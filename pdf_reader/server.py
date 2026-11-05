"""Local web server: serves the UI, analyses PDFs, renders pages and speaks."""

from __future__ import annotations

import hashlib
import io
import threading
import traceback
from collections import OrderedDict
from dataclasses import dataclass, field
from pathlib import Path

import pypdfium2 as pdfium
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.middleware.trustedhost import TrustedHostMiddleware

from . import __version__
from .analyze import PDFIUM_LOCK, analyze, summary, to_json
from .detectors import GROUPS
from .text import clean_token
from .tts import DEFAULT_VOICE, Engine

STATIC = Path(__file__).parent / "static"
MAX_DOCS = 3
MAX_RENDER_WIDTH = 3000


@dataclass
class Entry:
    id: str
    name: str
    data: bytes
    state: str = "analyzing"  # analyzing, ready, error
    progress: float = 0.0
    error: str = ""
    json: dict | None = None
    summary: dict | None = None
    pdf: object | None = None  # pypdfium2.PdfDocument, opened on first render
    renders: OrderedDict = field(default_factory=OrderedDict)


class DocStore:
    def __init__(self):
        self._docs: OrderedDict[str, Entry] = OrderedDict()
        self._lock = threading.Lock()

    def open(self, data: bytes, name: str, wait: bool = False) -> Entry:
        if not data.startswith(b"%PDF") and b"%PDF" not in data[:1024]:
            raise ValueError("That file isn't a PDF")
        doc_id = hashlib.sha1(data).hexdigest()[:16]
        with self._lock:
            entry = self._docs.get(doc_id)
            if entry and entry.state != "error":
                self._docs.move_to_end(doc_id)
                return entry
            entry = Entry(id=doc_id, name=name, data=data)
            self._docs[doc_id] = entry
            while len(self._docs) > MAX_DOCS:
                _, old = self._docs.popitem(last=False)
                self._close(old)
        t = threading.Thread(target=self._analyze, args=(entry,), name=f"analyze-{doc_id}", daemon=True)
        t.start()
        if wait:
            t.join()
        return entry

    def get(self, doc_id: str) -> Entry | None:
        return self._docs.get(doc_id)

    def _analyze(self, e: Entry) -> None:
        def progress(done, total):
            e.progress = done / max(1, total)

        try:
            doc = analyze(e.data, e.name, progress)
            e.json = to_json(doc)
            e.json["id"] = e.id
            e.summary = summary(doc)
            e.state = "ready"
            print(f"[pdf-reader] analysed {e.name}: {e.summary}", flush=True)
        except Exception as ex:
            traceback.print_exc()
            e.error = f"{type(ex).__name__}: {ex}"
            e.state = "error"

    @staticmethod
    def _close(e: Entry) -> None:
        with PDFIUM_LOCK:
            if e.pdf is not None:
                e.pdf.close()
                e.pdf = None

    def render(self, e: Entry, index: int, width: int) -> bytes:
        width = max(100, min(MAX_RENDER_WIDTH, int(width)))
        key = (index, width)
        hit = e.renders.get(key)
        if hit:
            e.renders.move_to_end(key)
            return hit
        with PDFIUM_LOCK:
            if e.pdf is None:
                e.pdf = pdfium.PdfDocument(e.data)
            if not 0 <= index < len(e.pdf):
                raise IndexError(index)
            page = e.pdf[index]
            try:
                scale = width / page.get_width()
                bitmap = page.render(scale=scale, may_draw_forms=True)
                img = bitmap.to_pil()
            finally:
                page.close()
        buf = io.BytesIO()
        img.convert("RGB").save(buf, format="PNG", compress_level=3)
        data = buf.getvalue()
        e.renders[key] = data
        while len(e.renders) > 80:
            e.renders.popitem(last=False)
        return data


class SpeakRequest(BaseModel):
    tokens: list[str]
    voice: str = DEFAULT_VOICE
    speed: float = 1.0


def create_app(engine: Engine | None = None, store: DocStore | None = None, initial: Entry | None = None) -> FastAPI:
    engine = engine or Engine()
    store = store or DocStore()
    app = FastAPI(title="pdf-reader", version=__version__, docs_url=None, redoc_url=None)
    # Only answer to localhost names, so a web page can't reach the server
    # through DNS rebinding.
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=["127.0.0.1", "localhost", "testserver", "[::1]"])
    app.state.engine = engine
    app.state.store = store
    app.state.initial = initial.id if initial else None

    @app.get("/", include_in_schema=False)
    def index():
        return FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-cache"})

    app.mount("/static", StaticFiles(directory=STATIC), name="static")

    @app.get("/api/status")
    def status():
        return {"version": __version__, "tts": engine.status(), "initial": app.state.initial, "groups": GROUPS}

    @app.post("/api/tts/start")
    def tts_start():
        engine.start()
        return engine.status()

    @app.get("/api/voices")
    def voices():
        return {"voices": engine.voices(), "default": DEFAULT_VOICE}

    @app.post("/api/open")
    async def open_pdf(file: UploadFile = File(...)):
        data = await file.read()
        try:
            entry = store.open(data, file.filename or "document.pdf")
        except ValueError as ex:
            raise HTTPException(400, str(ex))
        return {"id": entry.id, "name": entry.name, "state": entry.state}

    def _entry(doc_id: str) -> Entry:
        e = store.get(doc_id)
        if e is None:
            raise HTTPException(404, "Unknown document (it may have been closed); open it again")
        return e

    @app.get("/api/doc/{doc_id}")
    def doc(doc_id: str):
        e = _entry(doc_id)
        if e.state == "analyzing":
            return JSONResponse({"id": e.id, "name": e.name, "state": e.state, "progress": round(e.progress, 3)}, status_code=202)
        if e.state == "error":
            return JSONResponse({"id": e.id, "state": e.state, "error": e.error}, status_code=500)
        return JSONResponse({"state": "ready", **e.json})

    @app.get("/api/doc/{doc_id}/summary")
    def doc_summary(doc_id: str):
        e = _entry(doc_id)
        return {"state": e.state, "summary": e.summary}

    @app.get("/api/doc/{doc_id}/page/{index}")
    def page_image(doc_id: str, index: int, w: int = 1200):
        e = _entry(doc_id)
        try:
            data = store.render(e, index, w)
        except IndexError:
            raise HTTPException(404, "No such page")
        return Response(data, media_type="image/png", headers={"Cache-Control": "private, max-age=86400"})

    @app.post("/api/speak")
    def speak(req: SpeakRequest):
        if engine.state != "ready":
            raise HTTPException(503, engine.message or "The voice model isn't ready yet")
        # Tokens keep their positions (empty ones get a zero weight) so the
        # returned start times line up with the client's words.
        tokens = [clean_token(t) for t in req.tokens[:400]]
        if not any(tokens):
            raise HTTPException(400, "Nothing to say")
        try:
            clip = engine.speak(tokens, req.voice, req.speed)
        except ValueError as ex:
            raise HTTPException(400, str(ex))
        return {"key": clip.key, "duration": clip.duration, "starts": clip.starts, "rtf": engine.rtf}

    @app.get("/api/audio/{key}")
    def audio(key: str):
        clip = engine.clip(key)
        if clip is None:
            raise HTTPException(404, "Audio expired; request it again")
        return Response(clip.wav, media_type="audio/wav", headers={"Cache-Control": "private, max-age=3600"})

    return app
