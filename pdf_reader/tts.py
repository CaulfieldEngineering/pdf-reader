"""Kokoro-82M text to speech through kokoro-onnx, on the CPU.

The model and voice files are downloaded on first use to a per-user cache
directory (see ``cache_dir``) and never stored in the repository.
"""

from __future__ import annotations

import hashlib
import io
import os
import sys
import threading
import time
import urllib.request
import wave
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path

import numpy as np

RELEASE_URL = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1/"
# Exports from the v1.1 release carry a duration output, which gives the
# phoneme timings used for word highlighting.
MODELS = {
    "int8": ("kokoro-v1.0.int8.onnx", 114119327),
    "fp16": ("kokoro-v1.0.fp16.onnx", 163527961),
    "fp32": ("kokoro-v1.0.onnx", 325505369),
}
VOICES_FILE = ("voices-v1.0.bin", 28214398)
DEFAULT_MODEL = "fp32"
DEFAULT_VOICE = "af_heart"
SAMPLE_RATE = 24000

LANGS = {"a": "en-us", "b": "en-gb", "e": "es", "f": "fr-fr", "h": "hi", "i": "it", "p": "pt-br"}
LANG_NAMES = {"a": "US English", "b": "UK English", "e": "Spanish", "f": "French", "h": "Hindi", "i": "Italian", "p": "Portuguese"}
FAVOURITES = ["af_heart", "af_bella", "af_nicole", "bf_emma", "am_michael", "am_fenrir", "bm_george", "bm_fable"]
PUNCT = set(".,;:!?—…\"()“”' -")


def cache_dir() -> Path:
    env = os.environ.get("PDF_READER_MODELS")
    if env:
        return Path(env)
    if sys.platform == "win32":
        base = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Caches"
    else:
        base = Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache")
    return base / "pdf-reader" / "models"


def download(url: str, dest: Path, expected: int | None, progress) -> None:
    """Stream ``url`` to ``dest`` through a .part file, reporting progress."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_suffix(dest.suffix + ".part")
    req = urllib.request.Request(url, headers={"User-Agent": "pdf-reader"})
    with urllib.request.urlopen(req, timeout=60) as r, open(part, "wb") as f:
        total = int(r.headers.get("Content-Length") or expected or 0)
        done = 0
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)
            done += len(chunk)
            progress(done, total)
    if expected and part.stat().st_size != expected:
        size = part.stat().st_size
        part.unlink(missing_ok=True)
        raise IOError(f"{dest.name}: downloaded {size} bytes, expected {expected}")
    part.replace(dest)


@dataclass
class Clip:
    key: str
    wav: bytes
    duration: float
    starts: list[float]  # start time of each token, seconds


def to_wav(audio: np.ndarray, rate: int = SAMPLE_RATE) -> bytes:
    pcm = (np.clip(audio, -1.0, 1.0) * 32767).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


def token_starts(timings, weights: list[float], duration: float) -> list[float]:
    """Start time of each token, from phoneme timings and per-token weights.

    ``timings`` are (phoneme, start, end) from the model. ``weights`` say how
    many voiced phonemes each token has. Token i starts at the voiced phoneme
    whose index matches the share of weight before token i, so the result is
    exact when the weights match the model's phonemes and degrades gracefully
    when espeak splits or merges words differently.
    """
    voiced = [t for t in timings if t[0] not in PUNCT and t[0].strip()]
    total = sum(weights)
    if not weights:
        return []
    if not voiced or total <= 0:
        step = duration / len(weights)
        return [round(i * step, 3) for i in range(len(weights))]
    out, acc = [], 0.0
    for w in weights:
        idx = min(len(voiced) - 1, int(round(acc / total * len(voiced))))
        out.append(round(float(voiced[idx][1]), 3))
        acc += w
    return out


class Engine:
    def __init__(self, model: str = DEFAULT_MODEL, cache_bytes: int = 400 << 20):
        if model not in MODELS:
            raise ValueError(f"model must be one of {', '.join(MODELS)}")
        self.model_name = model
        self.state = "idle"  # idle, downloading, loading, ready, error
        self.message = ""
        self.progress = 0.0
        self._kokoro = None
        self._lock = threading.Lock()       # one synthesis at a time
        self._start_lock = threading.Lock()
        self._cache: OrderedDict[str, Clip] = OrderedDict()
        self._cache_bytes = 0
        self._cache_limit = cache_bytes
        self._thread: threading.Thread | None = None
        self.rtf: float | None = None

    # ------------------------------------------------------------------ setup

    @property
    def files(self) -> tuple[Path, Path]:
        d = cache_dir()
        return d / MODELS[self.model_name][0], d / VOICES_FILE[0]

    def start(self) -> None:
        """Download (if needed) and load the model in a background thread."""
        with self._start_lock:
            if self._thread is None or (self.state == "error" and not self._thread.is_alive()):
                self._thread = threading.Thread(target=self._prepare, name="tts-setup", daemon=True)
                self._thread.start()

    def wait(self, timeout: float | None = None) -> bool:
        self.start()
        if self._thread:
            self._thread.join(timeout)
        return self.state == "ready"

    def _prepare(self) -> None:
        try:
            model_path, voices_path = self.files
            todo = [(p, size) for p, size in ((model_path, MODELS[self.model_name][1]), (voices_path, VOICES_FILE[1])) if not p.exists()]
            if todo:
                self.state = "downloading"
                grand = sum(s for _, s in todo)
                base = 0
                for path, size in todo:
                    self.message = f"Downloading {path.name}"
                    print(f"[pdf-reader] downloading {path.name} ({size / 1e6:.0f} MB) to {path.parent}", flush=True)
                    last = [0.0]

                    def report(done, total, base=base):
                        self.progress = (base + done) / grand
                        now = time.time()
                        if now - last[0] > 0.5 or done == total:
                            last[0] = now
                            pct = 100 * done / total if total else 0
                            print(f"\r  {path.name}: {done / 1e6:6.1f} / {total / 1e6:.1f} MB ({pct:5.1f}%)", end="", flush=True)

                    download(RELEASE_URL + path.name, path, size, report)
                    print(flush=True)
                    base += size
            self.state = "loading"
            self.message = "Loading the voice model"
            self.progress = 1.0
            from kokoro_onnx import Kokoro

            self._kokoro = Kokoro(str(model_path), str(voices_path))
            self.state = "ready"
            self.message = ""
        except Exception as e:  # reported to the UI through /api/status
            self.state = "error"
            self.message = f"{type(e).__name__}: {e}"
            print(f"[pdf-reader] TTS setup failed: {self.message}", flush=True)

    def status(self) -> dict:
        return {"state": self.state, "message": self.message, "progress": round(self.progress, 3), "model": self.model_name, "rtf": self.rtf}

    # ------------------------------------------------------------------ voices

    def voices(self) -> list[dict]:
        if self._kokoro is None:
            return []
        out = []
        for v in self._kokoro.get_voices():
            prefix = v[:1]
            if prefix not in LANGS or "_" not in v:
                continue
            gender = {"f": "female", "m": "male"}.get(v[1:2], "")
            name = v.split("_", 1)[1].capitalize()
            out.append({"id": v, "label": f"{name} ({LANG_NAMES[prefix]}, {gender})", "lang": LANGS[prefix],
                        "english": prefix in "ab"})
        rank = {v: i for i, v in enumerate(FAVOURITES)}
        out.sort(key=lambda d: (not d["english"], rank.get(d["id"], 99), d["id"]))
        return out

    # ------------------------------------------------------------------ speech

    def _weights(self, tokens: list[str], lang: str) -> list[float]:
        try:
            import phonemizer
            from kokoro_onnx.tokenizer import _espeak_lock

            with _espeak_lock:
                ph = phonemizer.phonemize(tokens, lang, preserve_punctuation=True, with_stress=True)
            vocab = self._kokoro.tokenizer.vocab
            return [float(sum(1 for c in p if c in vocab and c not in PUNCT)) for p in ph]
        except Exception:
            return [float(sum(c.isalnum() for c in t)) for t in tokens]

    def speak(self, tokens: list[str], voice: str = DEFAULT_VOICE, speed: float = 1.0) -> Clip:
        if self._kokoro is None:
            raise RuntimeError("The voice model isn't ready yet")
        text = " ".join(t for t in tokens if t)
        speed = float(min(2.0, max(0.5, speed)))
        key = hashlib.sha1(f"{self.model_name}|{voice}|{speed:.2f}|{text}".encode()).hexdigest()[:20]
        with self._lock:
            hit = self._cache.get(key)
            if hit:
                self._cache.move_to_end(key)
                return hit
            lang = LANGS.get(voice[:1], "en-us")
            t0 = time.perf_counter()
            audio, rate, timings = self._kokoro.create_timed(text, voice=voice, speed=speed, lang=lang)
            elapsed = time.perf_counter() - t0
            duration = len(audio) / rate
            if duration > 0:
                self.rtf = round(elapsed / duration, 3)
            weights = self._weights(tokens, lang)
            starts = token_starts([(t.phoneme, t.start, t.end) for t in timings], weights, duration)
            clip = Clip(key=key, wav=to_wav(audio, rate), duration=round(duration, 3), starts=starts)
            self._cache[key] = clip
            self._cache_bytes += len(clip.wav)
            while self._cache_bytes > self._cache_limit and len(self._cache) > 1:
                _, old = self._cache.popitem(last=False)
                self._cache_bytes -= len(old.wav)
            return clip

    def clip(self, key: str) -> Clip | None:
        return self._cache.get(key)

    def clear_cache(self) -> None:
        with self._lock:
            self._cache.clear()
            self._cache_bytes = 0
