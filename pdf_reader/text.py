"""Sentence splitting with character offsets, and text clean-up for speech."""

from __future__ import annotations

import re
import unicodedata

ABBREVIATIONS = {
    "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "mt", "fig", "figs", "eq", "eqs",
    "no", "nos", "vs", "etc", "e.g", "i.e", "al", "approx", "sec", "secs", "ch", "chap",
    "vol", "vols", "pp", "p", "ed", "eds", "inc", "ltd", "co", "corp", "u.s", "u.k", "ref",
    "refs", "cf", "ca", "min", "max", "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep",
    "sept", "oct", "nov", "dec", "dept", "est", "tab", "app", "appx", "viz", "resp", "incl",
    "ex", "nr", "op", "art", "para", "rev", "ver", "v", "pg",
}

# A sentence ends at . ! ? (plus closing quotes/brackets) followed by space and
# something that can start a sentence.
_BOUNDARY = re.compile(r"[.!?]+[\"'”’)\]]*(?=\s+[\"'“‘(\[]?[A-Z0-9À-ɏ])")
_SOFT_SPLIT = re.compile(r"[;:]\s|,\s|\s[–—-]\s")
MAX_SENTENCE = 320


def split_sentences(text: str) -> list[tuple[int, int]]:
    """Return (start, end) offsets of the sentences in ``text``.

    Offsets exclude surrounding whitespace. Very long sentences are split at
    clause boundaries so speech can start quickly.
    """
    spans: list[tuple[int, int]] = []
    start = 0
    for m in _BOUNDARY.finditer(text):
        end = m.end()
        if _is_abbreviation(text, m.start()):
            continue
        spans.append((start, end))
        start = end
    spans.append((start, len(text)))

    out: list[tuple[int, int]] = []
    for s, e in spans:
        while s < e and text[s].isspace():
            s += 1
        while e > s and text[e - 1].isspace():
            e -= 1
        if e > s:
            out.extend(_split_long(text, s, e))
    return out


def _is_abbreviation(text: str, dot: int) -> bool:
    if text[dot] != ".":
        return False
    # The word before the full stop
    i = dot
    while i > 0 and not text[i - 1].isspace() and text[i - 1] not in "([\"'":
        i -= 1
    word = text[i:dot].lower().rstrip(".")
    if not word:
        return False
    if word in ABBREVIATIONS:
        return True
    # Initials ("J. Smith") and single letters ("A. B.")
    if len(word) == 1 and word.isalpha():
        return True
    # Dotted abbreviations like "U.S.A"
    if re.fullmatch(r"(?:[a-z]\.)+[a-z]", word):
        return True
    return False


def _split_long(text: str, s: int, e: int) -> list[tuple[int, int]]:
    if e - s <= MAX_SENTENCE:
        return [(s, e)]
    mid = s + (e - s) // 2
    best = None
    for m in _SOFT_SPLIT.finditer(text, s + 60, e - 60):
        cut = m.start() + 1
        if best is None or abs(cut - mid) < abs(best - mid):
            best = cut
    if best is None:
        # No clause boundary: cut at the space nearest the middle
        left = text.rfind(" ", s, mid)
        best = left if left > s + 40 else -1
        if best < 0:
            return [(s, e)]
    a_end = best
    while a_end > s and text[a_end - 1].isspace():
        a_end -= 1
    b_start = best
    while b_start < e and text[b_start].isspace():
        b_start += 1
    return _split_long(text, s, a_end) + _split_long(text, b_start, e)


def clean_token(token: str) -> str:
    """Normalise one word (or a few) before it goes to the TTS engine.

    Works token by token so the client's word positions survive: a token
    can grow ("3–5" -> "3 to 5") or become empty, but never merges with
    its neighbours.
    """
    t = unicodedata.normalize("NFKC", token)
    t = t.replace("…", "...")
    t = re.sub(r"[·•▪●◦|]", " ", t)
    # Number ranges with an en dash read as "to"; other dashes are pauses
    t = re.sub(r"(?<=\d)\s?–\s?(?=\d)", " to ", t)
    t = re.sub(r"\s*[–—]\s*", ", ", t)
    t = re.sub(r"\(\s*\)|\[\s*\]", "", t)
    t = " ".join(t.split())
    if not re.search(r"\w", t):
        # Punctuation alone keeps its pause value; symbols are dropped
        t = "".join(c for c in t if c in ".,;:!?")
    return t.strip(" ")
