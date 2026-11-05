// Screenshot the browser preview (scripts/preview-web.mjs) with headless Edge
// or Chrome over the DevTools protocol. Waits until the page reports that it
// has staged a reading moment, then captures it.
//
//   node scripts/shoot-web.mjs <url> <out.png> <width> <height> [--dark] [--browser path]
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [url, out, w = "1360", h = "880"] = process.argv.slice(2);
const dark = process.argv.includes("--dark");
const bi = process.argv.indexOf("--browser");
const browser = bi > 0 ? process.argv[bi + 1] : "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const port = 9300 + Math.floor(Math.random() * 500);
const profile = process.env.SHOT_PROFILE || mkdtempSync(join(tmpdir(), "shot-"));
const args = ["--headless=new", "--disable-gpu", "--hide-scrollbars", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, `--window-size=${w},${h}`, "about:blank"];
if (dark) args.push("--force-dark-mode", "--blink-settings=preferredColorScheme=0");
const child = spawn(browser, args, { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target;
for (let i = 0; i < 50 && !target; i++) {
  await sleep(200);
  try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === "page"); } catch {}
}
if (!target) { console.error("browser did not start"); child.kill(); process.exit(1); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let id = 0;
const pending = new Map();
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
  if (m.method === "Runtime.consoleAPICalled") console.log("[console]", m.params.args.map((a) => a.value ?? a.description).join(" "));
  if (m.method === "Runtime.exceptionThrown") console.log("[exception]", m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
});
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await send("Runtime.enable");
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: Number(w), height: Number(h), deviceScaleFactor: Number(process.env.SHOT_SCALE || 1), mobile: false });
if (dark) await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
await send("Page.navigate", { url });
const t0 = Date.now();
let title = "";
while (Date.now() - t0 < 60000) {
  await sleep(500);
  title = (await send("Runtime.evaluate", { expression: "document.title", returnByValue: true }))?.result?.value ?? "";
  if (title.startsWith("shot:")) break;
}
await sleep(800);
if (process.env.SHOT_EVAL) console.log("eval:", JSON.stringify((await send("Runtime.evaluate", { expression: process.env.SHOT_EVAL, returnByValue: true }))?.result?.value));
const shot = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(out, Buffer.from(shot.data, "base64"));
console.log(`${out} (${title || "no ready signal"}, ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
ws.close();
child.kill();
process.exit(0);
