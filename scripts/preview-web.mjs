// Serve the built renderer in an ordinary browser, with a stand-in for the
// Electron bridge, for UI work and screenshots without launching Electron.
// The voice is faked (silence with plausible word timings).
//
//   npm run build && node scripts/preview-web.mjs [file.pdf] [--port 5199]
//   then open http://127.0.0.1:5199/  (add ?shot=1 to stage a reading moment)

import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";

const args = process.argv.slice(2);
const portArg = args.indexOf("--port");
const port = portArg >= 0 ? Number(args[portArg + 1]) : 5199;
const pdf = resolve(args.find((a) => a.endsWith(".pdf")) ?? "tests/fixtures/sample.pdf");
const root = resolve("out/renderer");
const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".wasm": "application/wasm", ".pfb": "application/octet-stream", ".bcmap": "application/octet-stream", ".icc": "application/octet-stream" };

const stub = `
(() => {
  const q = new URLSearchParams(location.search);
  const voices = [["af_heart","Heart","US","Female","A"],["af_bella","Bella","US","Female","A-"],["bf_emma","Emma","UK","Female","B-"],["am_michael","Michael","US","Male","C+"],["bm_george","George","UK","Male","C"]]
    .map(([id,name,accent,gender,grade]) => ({ id, name, accent, gender, grade }));
  function silentWav(seconds) {
    const n = Math.round(seconds * 24000), buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
    const s = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
    s(0,"RIFF"); v.setUint32(4,36+n*2,true); s(8,"WAVE"); s(12,"fmt "); v.setUint32(16,16,true); v.setUint16(20,1,true); v.setUint16(22,1,true);
    v.setUint32(24,24000,true); v.setUint32(28,48000,true); v.setUint16(32,2,true); v.setUint16(34,16,true); s(36,"data"); v.setUint32(40,n*2,true);
    return new Uint8Array(buf);
  }
  window.readalong = {
    async initial() {
      const data = new Uint8Array(await (await fetch("/document.pdf")).arrayBuffer());
      return { version: "preview", mica: false, window: { maximized: false, alwaysOnTop: q.has("pin"), focused: true, mini: false },
        file: q.has("empty") ? null : { path: "", name: ${JSON.stringify(pdf.split(/[\\\\/]/).pop())}, data }, screenshot: q.has("shot") };
    },
    openDialog: async () => null, openPath: async () => null, pathForFile: () => "", recent: async () => [],
    onOpenFile() {}, onCommand() {}, showMenu() {}, minimize() {}, toggleMaximize() {}, close() {},
    setAlwaysOnTop() {}, toggleMini() {}, onWindowState() {},
    ttsStatus: async () => ({ state: "ready", progress: 1, message: "", dtype: "fp32", rtf: 0.19 }),
    onTtsStatus() {}, voices: async () => voices,
    async speak(tokens) { const per = 0.32, d = tokens.length * per + 0.3; return { wav: silentWav(d), starts: tokens.map((_, i) => 0.15 + i * per), duration: d, rtf: 0.19 }; },
    setDtype() {}, retryTts() {}, shotReady(name) { document.title = "shot:" + name; },
  };
})();`;

createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/preview-stub.js") { res.writeHead(200, { "content-type": "text/javascript" }); res.end(stub); return; }
  if (url.pathname === "/document.pdf") { res.writeHead(200, { "content-type": "application/pdf" }); res.end(readFileSync(pdf)); return; }
  let p = normalize(join(root, decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname)));
  if (!p.startsWith(root) || !existsSync(p)) { res.writeHead(404); res.end(); return; }
  let body = readFileSync(p);
  if (p.endsWith("index.html")) body = Buffer.from(body.toString().replace('<script type="module"', '<script src="/preview-stub.js"></script><script type="module"'));
  res.writeHead(200, { "content-type": types[extname(p)] ?? "application/octet-stream" });
  res.end(body);
}).listen(port, "127.0.0.1", () => console.log(`preview on http://127.0.0.1:${port}/ serving ${pdf}`));
