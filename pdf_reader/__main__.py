"""Command line entry point.

    python -m pdf_reader [file.pdf]            start the reader and open the browser
    python -m pdf_reader --analyze file.pdf    print what the skip detectors found
    python -m pdf_reader --download            fetch the voice model and exit
"""

from __future__ import annotations

import argparse
import json
import socket
import sys
import threading
import webbrowser
from pathlib import Path

from . import __version__
from .tts import MODELS, Engine, cache_dir


def _free_port(host: str, preferred: int) -> int:
    for port in [preferred, *range(preferred + 1, preferred + 20), 0]:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind((host, port))
                return s.getsockname()[1]
            except OSError:
                continue
    raise SystemExit("No free port found")


def _analyze(path: Path, verbose: bool) -> int:
    from .analyze import analyze, summary

    doc = analyze(path.read_bytes(), path.name)
    print(json.dumps(summary(doc), indent=2))
    if verbose:
        for b in doc.blocks:
            if b.kind not in ("body", "heading") or b.spans:
                spans = ", ".join(f"{s.kind}:{b.text[s.start:s.end]!r}" for s in b.spans)
                print(f"p{b.page + 1:>3} #{b.id:<5} {b.kind:<12} {b.text[:70]!r} {spans} ({b.reason})")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="pdf-reader", description="Local, offline voice PDF reader")
    ap.add_argument("file", nargs="?", help="PDF to open")
    ap.add_argument("--host", default="127.0.0.1", help="address to listen on (default 127.0.0.1)")
    ap.add_argument("--port", type=int, default=8765, help="port (default 8765, or the next free one)")
    ap.add_argument("--model", choices=list(MODELS), default=None, help="Kokoro model precision (default fp32)")
    ap.add_argument("--no-browser", action="store_true", help="don't open a browser tab")
    ap.add_argument("--analyze", action="store_true", help="print the skip classification of FILE and exit")
    ap.add_argument("--verbose", "-v", action="store_true", help="with --analyze, list every skipped block")
    ap.add_argument("--download", action="store_true", help="download the voice model and exit")
    ap.add_argument("--version", action="version", version=__version__)
    args = ap.parse_args(argv)

    path = Path(args.file).expanduser().resolve() if args.file else None
    if path and not path.is_file():
        ap.error(f"no such file: {path}")

    if args.analyze:
        if not path:
            ap.error("--analyze needs a file")
        return _analyze(path, args.verbose)

    engine = Engine(args.model) if args.model else Engine()
    if args.download:
        print(f"Model cache: {cache_dir()}")
        ok = engine.wait()
        print("Ready." if ok else f"Failed: {engine.message}")
        return 0 if ok else 1

    import uvicorn

    from .server import DocStore, create_app

    store = DocStore()
    initial = store.open(path.read_bytes(), path.name) if path else None
    engine.start()
    app = create_app(engine, store, initial)

    port = _free_port(args.host, args.port)
    url = f"http://{'127.0.0.1' if args.host in ('0.0.0.0', '127.0.0.1') else args.host}:{port}/"
    print(f"pdf-reader {__version__} on {url}  (Ctrl+C to stop)", flush=True)
    if not args.no_browser:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    uvicorn.run(app, host=args.host, port=port, log_level="warning")
    return 0


if __name__ == "__main__":
    sys.exit(main())
