/** Electron main process: the window, files, menus and the voice process. */

import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, nativeTheme, screen, shell, utilityProcess, type UtilityProcess } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { open as openFile, readFile } from "node:fs/promises";
import { release } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import icon from "../../build/icon.png?asset";
import workerPath from "./tts-worker?modulePath";
import type { Command, FileData, InitialInfo, RecentDoc, SpeakReply, TtsStatus, VoiceInfo, WindowState } from "../shared/ipc";
import { parseLexicon, type Lexicon } from "../shared/lexicon";
import * as lib from "../shared/library";
import { fingerprint, JsonStore, openLexicon, openLibrary, writeJson } from "./store";

const APP_ID = "com.caulfieldengineering.readalong";
const MINI = { width: 460, height: 176 };
const MINI_LIMIT = { width: 620, height: 430 };

const shotDir = process.argv.find((a) => a.startsWith("--screenshot="))?.slice(13) ?? null;
// Test mode (READALONG_TEST=1, or a --screenshot run): the window is never
// shown or focused, never on top, no global shortcuts, a separate profile,
// and no single-instance hand-off to a copy the user has open. Off unless asked for.
const TEST = process.env.READALONG_TEST === "1" || process.env.PDF_READER_TEST === "1" || !!shotDir;
const modelsDir = () => join(app.getPath("appData"), "Readalong", "models");
if (TEST) app.setPath("userData", join(app.getPath("appData"), "Readalong-test"));

app.setAppUserModelId(APP_ID);
if (!TEST && !app.requestSingleInstanceLock()) app.quit();

// ------------------------------------------------------------------ settings file

interface Stored {
  bounds?: { x: number; y: number; width: number; height: number };
  fullBounds?: { x: number; y: number; width: number; height: number };
  maximized?: boolean;
  alwaysOnTop?: boolean;
  dtype?: string;
  /** v0.1.0 recent list, migrated into the library on first start. */
  recent?: { path: string; name: string; openedAt: number }[];
}
const storePath = () => join(app.getPath("userData"), "settings.json");
let stored: Stored = {};
function loadStore() {
  try { stored = JSON.parse(readFileSync(storePath(), "utf8")); } catch { stored = {}; }
}
let saveTimer: NodeJS.Timeout | null = null;
function saveStore(now = false) {
  if (TEST) return;
  const write = () => {
    try {
      mkdirSync(app.getPath("userData"), { recursive: true });
      writeFileSync(storePath(), JSON.stringify(stored, null, 2));
    } catch { /* read-only profile: keep going */ }
  };
  if (saveTimer) clearTimeout(saveTimer);
  if (now) write();
  else saveTimer = setTimeout(write, 400);
}

// ------------------------------------------------------------------ args

function pdfArg(argv: string[]): string | null {
  for (const a of argv.slice(1)) {
    if (!a.startsWith("-") && /\.pdf$/i.test(a) && existsSync(a)) return resolve(a);
  }
  return null;
}

// ------------------------------------------------------------------ files

let library: JsonStore<lib.Library>;
let lexicon: JsonStore<Lexicon>;

async function readPdf(path: string, quiet = false): Promise<FileData | null> {
  try {
    const data = new Uint8Array(await readFile(path));
    const key = fingerprint(data);
    lib.touch(library.value, { key, path, name: basename(path), size: data.length });
    library.save();
    try { app.addRecentDocument(path); } catch { /* not supported */ }
    return { path, name: basename(path), data, key };
  } catch (e: any) {
    if (!quiet) dialog.showErrorBox("Couldn't open the file", `${path}

${e?.message ?? e}`);
    return null;
  }
}

/** Fingerprint without reading the whole file. */
async function fingerprintFile(path: string): Promise<{ key: string; size: number } | null> {
  try {
    const fh = await openFile(path, "r");
    try {
      const { size } = await fh.stat();
      const buf = new Uint8Array(Math.min(size, lib.FINGERPRINT_BYTES));
      await fh.read(buf, 0, buf.length, 0);
      const key = fingerprint(buf).slice(0, 16) + size.toString(36);
      return { key, size };
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}

/** Bring the v0.1.0 recent list into the library once. */
async function migrateRecent(): Promise<void> {
  if (!stored.recent?.length) return;
  for (const r of [...stored.recent].reverse()) {
    const fp = await fingerprintFile(r.path);
    if (fp) lib.touch(library.value, { key: fp.key, path: r.path, name: r.name, size: fp.size }, r.openedAt);
  }
  delete stored.recent;
  saveStore(true);
  library.save(true);
}

// ------------------------------------------------------------------ window

let win: BrowserWindow | null = null;
let pendingFile: string | null = pdfArg(process.argv);

// Mica on Windows 11 22H2+, but not in hidden test runs (it needs a visible window)
const micaSupported = process.platform === "win32" && Number(release().split(".")[2] ?? 0) >= 22621 && !TEST;

function visibleBounds(b?: Stored["bounds"]) {
  if (!b) return undefined;
  const area = screen.getDisplayMatching(b).workArea;
  const visible = b.x < area.x + area.width - 80 && b.x + b.width > area.x + 80 && b.y >= area.y - 10 && b.y < area.y + area.height - 60;
  return visible ? b : undefined;
}

function windowState(): WindowState {
  const [w, h] = win ? win.getSize() : [0, 0];
  return {
    maximized: !!win?.isMaximized(),
    alwaysOnTop: !!win?.isAlwaysOnTop(),
    focused: !!win?.isFocused(),
    mini: w < MINI_LIMIT.width || h < MINI_LIMIT.height,
  };
}
function sendState() {
  win?.webContents.send("window:state", windowState());
}

function createWindow() {
  const b = visibleBounds(stored.bounds);
  win = new BrowserWindow({
    width: b?.width ?? 1280,
    height: b?.height ?? 860,
    x: b?.x,
    y: b?.y,
    minWidth: 360,
    minHeight: 132,
    show: false,
    skipTaskbar: TEST,
    focusable: !TEST,
    title: "Readalong",
    icon,
    titleBarStyle: "hidden",
    backgroundColor: micaSupported ? "#00000000" : nativeTheme.shouldUseDarkColors ? "#1c1c1c" : "#f3f3f3",
    ...(micaSupported ? { backgroundMaterial: "mica" as const } : {}),
    alwaysOnTop: !TEST && !!stored.alwaysOnTop,
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      // Hidden test runs render offscreen so screenshots work without a window
      offscreen: TEST,
    },
  });
  if (!TEST) {
    if (stored.alwaysOnTop) win.setAlwaysOnTop(true, "floating");
    if (stored.maximized) win.maximize();
    win.once("ready-to-show", () => win?.show());
  }

  const remember = () => {
    if (!win || win.isMinimized() || win.isMaximized() || win.isFullScreen()) return;
    stored.bounds = win.getBounds();
    saveStore();
  };
  win.on("resize", () => { remember(); sendState(); });
  win.on("move", remember);
  for (const ev of ["maximize", "unmaximize", "focus", "blur", "always-on-top-changed"] as const) {
    win.on(ev as any, () => {
      if (ev === "maximize" || ev === "unmaximize") { stored.maximized = win!.isMaximized(); saveStore(); }
      sendState();
    });
  }
  win.on("close", () => {
    if (win && !win.isMaximized() && !win.isMinimized()) stored.bounds = win.getBounds();
    saveStore(true);
  });
  win.on("closed", () => { win = null; });

  // Links open in the browser, never inside the app
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (url !== win?.webContents.getURL()) e.preventDefault();
  });

  if (TEST || process.env.READALONG_DEBUG) {
    win.webContents.on("console-message", (e: any) => console.log(`[renderer] ${e.message ?? ""}`));
    win.webContents.on("render-process-gone", (_e, d) => console.log("[renderer gone]", d.reason));
  }

  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else win.loadFile(join(import.meta.dirname, "../renderer/index.html"));
}

function toggleMini() {
  if (!win) return;
  if (win.isMaximized()) win.unmaximize();
  const { mini } = windowState();
  if (mini) {
    const fb = visibleBounds(stored.fullBounds);
    const b = win.getBounds();
    win.setBounds(fb ?? { x: b.x, y: b.y, width: 1200, height: 820 }, true);
  } else {
    stored.fullBounds = win.getBounds();
    const b = win.getBounds();
    win.setBounds({ x: b.x + b.width - MINI.width - 24, y: b.y + 24, ...MINI }, true);
  }
  saveStore();
}

// ------------------------------------------------------------------ voice process

let worker: UtilityProcess | null = null;
let tts: TtsStatus = { state: "idle", progress: 0, message: "", dtype: "fp32", rtf: 0 };
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
let nextId = 1;

function startWorker() {
  if (worker) worker.kill();
  const dtype = (stored.dtype as string) || "fp32";
  tts = { state: "idle", progress: 0, message: "", dtype, rtf: 0 };
  worker = utilityProcess.fork(workerPath, [], { serviceName: "Readalong voice", stdio: "inherit" });
  worker.on("message", (m: any) => {
    if (m.type === "status") {
      if (m.state === "error" || process.env.READALONG_DEBUG) console.log("[voice]", m.state, m.message ?? "", m.progress ?? "");
      tts = { ...tts, state: m.state, progress: m.progress ?? tts.progress, message: m.message ?? "", dtype: m.dtype ?? tts.dtype, rtf: m.rtf ?? tts.rtf, downloadedMB: m.downloadedMB, totalMB: m.totalMB };
      win?.webContents.send("tts:status", tts);
    } else if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id)!;
      pending.delete(m.id);
      if (m.type === "error") p.reject(new Error(m.message));
      else p.resolve(m);
    }
  });
  worker.on("exit", (code) => {
    worker = null;
    for (const p of pending.values()) p.reject(new Error("The voice process stopped"));
    pending.clear();
    if (tts.state !== "error") {
      tts = { ...tts, state: "error", message: `The voice process stopped (code ${code})` };
      win?.webContents.send("tts:status", tts);
    }
  });
  worker.postMessage({ type: "init", cacheDir: modelsDir(), dtype, lexicon: lexicon.value.entries });
}

function ask<T>(msg: Record<string, unknown>): Promise<T> {
  if (!worker) return Promise.reject(new Error("The voice process isn't running"));
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker!.postMessage({ ...msg, id });
  });
}

// ------------------------------------------------------------------ menu

function send(cmd: Command) {
  win?.webContents.send("command", cmd);
}
function popupMenu(x: number, y: number) {
  if (!win) return;
  const recent = lib.recent(library.value).slice(0, 10);
  const menu = Menu.buildFromTemplate([
    { label: "Open…", accelerator: "CmdOrCtrl+O", click: () => send("open") },
    { label: "Home (recent files)", accelerator: "CmdOrCtrl+Shift+O", click: () => send("home") },
    {
      label: "Open recent",
      enabled: recent.length > 0,
      submenu: recent.map((r) => ({
        label: (r.pinned ? "★ " : "") + r.name,
        sublabel: r.path,
        click: async () => {
          const f = r.path && existsSync(r.path) ? await readPdf(r.path) : null;
          if (f) win?.webContents.send("file:open", f);
          else send("home");
        },
      })),
    },
    { type: "separator" },
    { label: "Add bookmark", accelerator: "CmdOrCtrl+B", click: () => send("bookmark") },
    { label: "Mini player", accelerator: "CmdOrCtrl+M", click: () => toggleMini() },
    { label: "Always on top", type: "checkbox", checked: win.isAlwaysOnTop(), accelerator: "CmdOrCtrl+T", click: (i) => { win?.setAlwaysOnTop(i.checked, "floating"); stored.alwaysOnTop = i.checked; saveStore(); } },
    { label: "Sidebar", accelerator: "CmdOrCtrl+Shift+B", click: () => send("sidebar") },
    { label: "Settings", accelerator: "CmdOrCtrl+,", click: () => send("settings") },
    { type: "separator" },
    { label: "Export bookmarks…", click: () => void exportLibrary() },
    { label: "Import bookmarks…", click: () => void importLibrary() },
    { type: "separator" },
    { label: "About Readalong", click: () => dialog.showMessageBox(win!, { type: "info", title: "Readalong", message: `Readalong ${app.getVersion()}`, detail: "A local, offline voice PDF reader.\nVoice: Kokoro-82M (Apache-2.0). PDF: PDF.js (Apache-2.0).\nhttps://github.com/CaulfieldEngineering/pdf-reader", icon }) },
    { label: "Exit", click: () => app.quit() },
  ]);
  menu.popup({ window: win, x: Math.round(x), y: Math.round(y) });
}

async function exportLibrary(): Promise<string | null> {
  if (!win) return null;
  const r = await dialog.showSaveDialog(win, { title: "Export bookmarks", defaultPath: "readalong-bookmarks.json", filters: [{ name: "JSON", extensions: ["json"] }] });
  if (r.canceled || !r.filePath) return null;
  writeJson(r.filePath, library.value);
  return r.filePath;
}

async function importLibrary(): Promise<number | null> {
  if (!win) return null;
  const r = await dialog.showOpenDialog(win, { title: "Import bookmarks", properties: ["openFile"], filters: [{ name: "JSON", extensions: ["json"] }] });
  if (r.canceled || !r.filePaths[0]) return null;
  try {
    const n = lib.mergeLibrary(library.value, lib.parseLibrary(JSON.parse(readFileSync(r.filePaths[0], "utf8"))));
    library.save();
    win.webContents.send("command", "home");
    return n;
  } catch (e: any) {
    dialog.showErrorBox("Couldn't import", String(e?.message ?? e));
    return null;
  }
}

function sendLexicon() {
  worker?.postMessage({ type: "lexicon", entries: lexicon.value.entries });
}

// ------------------------------------------------------------------ IPC

function registerIpc() {
  ipcMain.handle("app:initial", async (): Promise<InitialInfo> => {
    const file = pendingFile ? await readPdf(pendingFile) : null;
    pendingFile = null;
    return { version: app.getVersion(), mica: micaSupported, window: windowState(), file, screenshot: !!shotDir };
  });
  ipcMain.handle("file:dialog", async () => {
    if (!win) return null;
    const r = await dialog.showOpenDialog(win, { title: "Open a PDF", properties: ["openFile"], filters: [{ name: "PDF documents", extensions: ["pdf"] }] });
    return r.canceled || !r.filePaths[0] ? null : readPdf(r.filePaths[0]);
  });
  ipcMain.handle("file:open", (_e, path: string) => (typeof path === "string" && /\.pdf$/i.test(path) ? readPdf(path) : null));
  ipcMain.handle("library:list", (): RecentDoc[] =>
    lib.recent(library.value).map((d) => ({ ...d, exists: !!d.path && existsSync(d.path), folder: d.path ? dirname(d.path) : "" })));
  ipcMain.handle("library:doc", (_e, key: string) => lib.findDoc(library.value, key) ?? null);
  ipcMain.handle("library:open", async (_e, key: string) => {
    const d = lib.findDoc(library.value, key);
    return d?.path && existsSync(d.path) ? readPdf(d.path) : null;
  });
  ipcMain.handle("library:locate", async (_e, key: string) => {
    const d = lib.findDoc(library.value, key);
    if (!d || !win) return null;
    const r = await dialog.showOpenDialog(win, { title: `Locate ${d.name}`, defaultPath: d.path || undefined, properties: ["openFile"], filters: [{ name: "PDF documents", extensions: ["pdf"] }] });
    if (r.canceled || !r.filePaths[0]) return null;
    const path = r.filePaths[0];
    const data = new Uint8Array(await readFile(path));
    const file = { path, name: basename(path), data, key: fingerprint(data) };
    const verdict = lib.relocate(library.value, key, { key: file.key, path, name: file.name, size: data.length });
    lib.touch(library.value, { key: file.key, path, name: file.name, size: data.length });
    library.save();
    return verdict === "missing" ? null : { verdict, file };
  });
  ipcMain.handle("library:remove", (_e, key: string) => { lib.removeDoc(library.value, key); library.save(); });
  ipcMain.handle("library:pin", (_e, key: string, pinned: boolean) => { lib.pinDoc(library.value, key, !!pinned); library.save(); });
  ipcMain.on("library:position", (_e, key: string, pos: lib.Position) => { lib.setPosition(library.value, key, pos); library.save(); });
  ipcMain.handle("bookmark:add", (_e, key: string, at, label?: string, note?: string) => { const b = lib.addBookmark(library.value, key, at, label, note); library.save(); return b; });
  ipcMain.handle("bookmark:update", (_e, key: string, id: string, patch) => { const ok = lib.updateBookmark(library.value, key, id, patch); library.save(); return ok; });
  ipcMain.handle("bookmark:remove", (_e, key: string, id: string) => { const ok = lib.removeBookmark(library.value, key, id); library.save(); return ok; });
  ipcMain.handle("library:export", () => exportLibrary());
  ipcMain.handle("library:import", () => importLibrary());

  ipcMain.handle("lexicon:get", () => lexicon.value);
  ipcMain.handle("lexicon:set", (_e, lex: Lexicon) => {
    lexicon.value = parseLexicon(lex);
    lexicon.save();
    sendLexicon();
  });
  ipcMain.handle("lexicon:export", async () => {
    if (!win) return null;
    const r = await dialog.showSaveDialog(win, { title: "Export pronunciations", defaultPath: "readalong-pronunciations.json", filters: [{ name: "JSON", extensions: ["json"] }] });
    if (r.canceled || !r.filePath) return null;
    writeJson(r.filePath, lexicon.value);
    return r.filePath;
  });
  ipcMain.handle("lexicon:import", async () => {
    if (!win) return null;
    const r = await dialog.showOpenDialog(win, { title: "Import pronunciations", properties: ["openFile"], filters: [{ name: "JSON", extensions: ["json"] }] });
    if (r.canceled || !r.filePaths[0]) return null;
    try {
      return parseLexicon(JSON.parse(readFileSync(r.filePaths[0], "utf8")));
    } catch (e: any) {
      dialog.showErrorBox("Couldn't import", String(e?.message ?? e));
      return null;
    }
  });
  ipcMain.on("menu:popup", (_e, x: number, y: number) => popupMenu(x, y));

  ipcMain.on("win:minimize", () => win?.minimize());
  ipcMain.on("win:maximize", () => (win?.isMaximized() ? win.unmaximize() : win?.maximize()));
  ipcMain.on("win:close", () => win?.close());
  ipcMain.on("win:top", (_e, on: boolean) => {
    if (TEST) { win?.webContents.send("window:state", { ...windowState(), alwaysOnTop: !!on }); return; }
    win?.setAlwaysOnTop(!!on, "floating");
    stored.alwaysOnTop = !!on;
    saveStore();
    sendState();
  });
  ipcMain.on("win:mini", () => toggleMini());

  ipcMain.handle("tts:status", () => tts);
  ipcMain.handle("tts:voices", async () => (await ask<{ voices: VoiceInfo[] }>({ type: "voices" })).voices);
  ipcMain.handle("tts:speak", async (_e, tokens: string[], voice: string, speed: number): Promise<SpeakReply> => {
    const r = await ask<SpeakReply>({ type: "speak", tokens: tokens.slice(0, 400), voice, speed });
    tts.rtf = r.rtf;
    return { wav: r.wav, starts: r.starts, duration: r.duration, rtf: r.rtf, ...(r.fallback ? { fallback: r.fallback } : {}) };
  });
  ipcMain.on("tts:dtype", (_e, d: string) => {
    if (!["fp32", "fp16", "q8"].includes(d)) return;
    stored.dtype = d;
    saveStore();
    startWorker();
  });
  ipcMain.on("tts:retry", () => startWorker());
  ipcMain.handle("tts:check-voices", async () => (await ask<{ voices: unknown }>({ type: "check-voices" })).voices);

  // Screenshot self-test: the page stages a view, then asks for a capture
  ipcMain.handle("shot", async (_e, name: string) => {
    if (!shotDir || !win) return;
    await new Promise((r) => setTimeout(r, 700));
    const img = await win.webContents.capturePage();
    mkdirSync(shotDir, { recursive: true });
    writeFileSync(join(shotDir, `${name}.png`), img.toPNG());
    if (name === "full") {
      // Window behaviour checks on the hidden window (never shown)
      win.setAlwaysOnTop(true, "floating");
      const on = win.isAlwaysOnTop();
      win.setAlwaysOnTop(false);
      console.log(`[check] always on top: set -> ${on}, cleared -> ${win.isAlwaysOnTop()}`);
      console.log(`[check] window bounds ${JSON.stringify(win.getBounds())}, visible ${win.isVisible()}, focused ${win.isFocused()}`);
    }
    if (name === "mini") setTimeout(() => app.quit(), 300);
  });
  ipcMain.on("shot:log", (_e, msg: string) => console.log(`[check] ${msg}`));
}

// ------------------------------------------------------------------ app

app.on("second-instance", async (_e, argv) => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
    const p = pdfArg(argv);
    if (p) {
      const f = await readPdf(p);
      if (f) win.webContents.send("file:open", f);
    }
  }
});

app.whenReady().then(async () => {
  // Test runs can force a theme for screenshots
  if (TEST && /^(light|dark)$/.test(process.env.READALONG_TEST_THEME ?? "")) nativeTheme.themeSource = process.env.READALONG_TEST_THEME as "light" | "dark";
  loadStore();
  // In test mode these live in the separate test profile
  library = openLibrary(join(app.getPath("userData"), "library.json"));
  lexicon = openLexicon(join(app.getPath("userData"), "pronunciations.json"));
  if (!existsSync(join(app.getPath("userData"), "pronunciations.json"))) lexicon.save(true);
  await migrateRecent();
  Menu.setApplicationMenu(null);
  registerIpc();
  createWindow();
  startWorker();
  if (shotDir && win) {
    win.setBounds({ x: 60, y: 40, width: 1360, height: 880 });
  }
  // Global play / pause while another app has focus
  if (!TEST) try {
    globalShortcut.register("CommandOrControl+Alt+Space", () => send("toggle-play"));
    globalShortcut.register("CommandOrControl+Alt+Right", () => send("next"));
    globalShortcut.register("CommandOrControl+Alt+Left", () => send("prev"));
  } catch { /* taken by another app */ }
});

app.on("will-quit", () => {
  library?.flush();
  lexicon?.flush();
  globalShortcut.unregisterAll();
  worker?.kill();
});
app.on("window-all-closed", () => app.quit());
