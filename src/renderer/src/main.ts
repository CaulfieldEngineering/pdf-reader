/** Readalong renderer: wires the page view, the player and the window chrome. */

import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { analyze, toData, type BlockData, type DocData } from "../../shared/analysis/analyze";
import type { SkipGroup } from "../../shared/analysis/detectors/types";
import type { Command, FileData, ReadalongApi, TtsStatus, VoiceInfo, WindowState } from "../../shared/ipc";
import { buildQueue, isSkipped, nearestUtterance, skipValue, type Utterance, utteranceText } from "../../shared/reading";
import { Player } from "./player";
import { loadPosition, loadSettings, savePosition, saveSettings } from "./settings";
import { Viewer, kindLabel, wordRects } from "./viewer";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

declare global {
  interface Window { readalong: ReadalongApi }
}

const api = window.readalong;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const settings = loadSettings();
const viewer = new Viewer($("scroller"), $("pages"));
let doc: DocData | null = null;
let docKey = "";
let pdfTask: ReturnType<typeof pdfjs.getDocument> | null = null;
let groups: SkipGroup[] = [];
let screenshot = false;
let windowState: WindowState = { maximized: false, alwaysOnTop: false, focused: true, mini: false };

// ------------------------------------------------------------------ toast

let toastTimer = 0;
function toast(msg: string, ms = 3400): void {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { t.hidden = true; }, ms);
}

// ------------------------------------------------------------------ player

const player: Player = new Player(api, {
  position: (i, scroll) => showPosition(i, scroll),
  word: (k) => showWord(k),
  state: (playing, waiting) => {
    document.querySelectorAll<SVGUseElement>(".play-icon").forEach((u) => u.setAttribute("href", playing ? "#i-pause" : "#i-play"));
    for (const id of ["btn-play", "m-play"]) {
      $(id).classList.toggle("waiting", playing && waiting);
      $(id).title = playing ? "Pause (Space)" : "Play (Space)";
    }
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = playing ? "playing" : "paused";
  },
  message: (m) => toast(m),
  gapAfter: (i: number): number => {
    const u: Utterance | undefined = player.queue[i], n: Utterance | undefined = player.queue[i + 1];
    if (!u || !n || !doc) return 0;
    if (n.b !== u.b) return doc.blocks[u.b].kind === "heading" ? 550 : 380;
    return 120;
  },
});
player.voice = settings.voice;
player.speed = settings.speed;

function uttRects(u: Utterance) {
  if (u.rects) return u.rects;
  const b = doc!.blocks[u.b];
  const idx: number[] = [];
  b.w.forEach((w, i) => { if (w[4] < u.e! && w[5] > u.s!) idx.push(i); });
  u.rects = wordRects(b, idx);
  return u.rects;
}

function showPosition(i: number, scroll: boolean): void {
  const u = player.queue[i];
  updateNow();
  if (!u || !doc) return;
  viewer.highlight(u.page, uttRects(u));
  if (scroll) {
    const r = uttRects(u)[0];
    if (r) viewer.scrollTo(u.page, r, false, settings.follow);
  }
  updateCurrentSection();
  savePosition(docKey, u.b, u.k);
  renderMiniText(-1);
}

function showWord(k: number): void {
  const u = player.queue[player.cur];
  if (!u || !doc) return;
  const tok = k >= 0 && settings.wordHl ? u.tokens[k] : undefined;
  viewer.word(tok && tok.w.length ? wordRects(doc.blocks[u.b], tok.w) : []);
  renderMiniText(settings.wordHl ? k : -1);
  const p = (player.cur + player.clipProgress) / Math.max(1, player.queue.length);
  $("mini-progress").style.width = p * 100 + "%";
}

function updateNow(): void {
  const u = player.queue[player.cur];
  const text = !doc ? "Open a PDF to start" : u ? utteranceText(u) : "Nothing to read with the current skip settings";
  $("now-text").textContent = text;
  $("now-text").title = text;
  const frac = player.queue.length > 1 ? player.cur / (player.queue.length - 1) : 0;
  const pos = doc && u ? `Page ${u.page + 1} of ${doc.pages.length} · ${Math.round(frac * 100)}%` : "";
  $("now-pos").textContent = pos;
  $("mini-pos").textContent = pos;
  $("doc-bar").style.width = frac * 100 + "%";
  $("mini-progress").style.width = frac * 100 + "%";
  if ("mediaSession" in navigator && doc) {
    navigator.mediaSession.metadata = new MediaMetadata({ title: text.slice(0, 120), artist: doc.name, album: "Readalong" });
  }
}

function renderMiniText(k: number): void {
  const box = $("mini-text");
  const u = player.queue[player.cur];
  if (!u) { box.textContent = doc ? "Nothing to read with the current skip settings" : "Open a PDF to start"; return; }
  box.innerHTML = "";
  u.tokens.forEach((t, i) => {
    if (i) box.append(" ");
    const s = document.createElement("span");
    s.textContent = t.t;
    if (i === k) s.className = "w";
    box.append(s);
  });
}

// ------------------------------------------------------------------ theme & classes

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
function applyTheme(): void {
  const dark = settings.theme === "dark" || (settings.theme === "system" && darkQuery.matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.body.classList.toggle("dark-pages", settings.darkPages);
  document.body.classList.toggle("show-skipped", settings.showSkipped);
  document.body.classList.toggle("no-sidebar", !settings.sidebar);
  $("btn-sidebar").classList.toggle("on", settings.sidebar);
}
darkQuery.addEventListener("change", applyTheme);

function applyWindowState(s: WindowState): void {
  windowState = s;
  document.body.classList.toggle("blurred", !s.focused);
  $("pin-icon").setAttribute("href", s.alwaysOnTop ? "#i-pin-on" : "#i-pin");
  $("btn-pin").classList.toggle("on", s.alwaysOnTop);
  $("btn-pin").title = s.alwaysOnTop ? "Keeping on top (Ctrl+T)" : "Keep on top (Ctrl+T)";
  $("max-icon").setAttribute("href", s.maximized ? "#i-restore" : "#i-max");
  $("btn-max").title = s.maximized ? "Restore" : "Maximize";
}

function updateMini(): void {
  const mini = window.innerWidth < 620 || window.innerHeight < 430;
  if (mini === document.body.classList.contains("mini")) return;
  document.body.classList.toggle("mini", mini);
  $("mini-icon").setAttribute("href", mini ? "#i-expand" : "#i-mini");
  $("btn-mini").title = mini ? "Full window (Ctrl+M)" : "Mini player (Ctrl+M)";
  if (!mini) requestAnimationFrame(() => viewer.layout());
  renderMiniText(-1);
}
window.addEventListener("resize", updateMini);

// ------------------------------------------------------------------ voice status

function showTts(t: TtsStatus): void {
  const pill = $("voice-pill");
  pill.classList.toggle("ready", t.state === "ready");
  pill.classList.toggle("error", t.state === "error");
  const pct = Math.round((t.progress || 0) * 100);
  const text: Record<string, string> = {
    idle: "Voice: starting",
    downloading: t.totalMB ? `Downloading voice ${pct}% (${Math.round(t.downloadedMB ?? 0)} of ${Math.round(t.totalMB)} MB)` : `Downloading voice ${pct}%`,
    loading: "Voice: loading",
    ready: "Voice ready",
    error: "Voice unavailable · retry",
  };
  $("voice-pill-text").textContent = text[t.state] ?? t.state;
  $("voice-pill-bar").style.width = pct + "%";
  pill.title = t.state === "error" ? `${t.message}\nClick to retry.` : `Kokoro-82M (${t.dtype}) on the CPU${t.rtf ? ` · ${(1 / t.rtf).toFixed(1)}× faster than real time` : ""}`;
  ($("dtype") as HTMLSelectElement).value = t.dtype;
  const ready = t.state === "ready";
  if (ready && !player.ttsReady) void loadVoices();
  player.setReady(ready);
  if (ready && !screenshot) window.setTimeout(() => pill.style.opacity = "0.75", 2500);
  else pill.style.opacity = "1";
}

async function loadVoices(): Promise<void> {
  let voices: VoiceInfo[] = [];
  try { voices = await api.voices(); } catch { return; }
  if (!voices.length) return;
  if (!voices.find((v) => v.id === settings.voice)) settings.voice = voices[0].id;
  for (const id of ["voice", "voice-quick"]) {
    const sel = $<HTMLSelectElement>(id);
    sel.innerHTML = "";
    for (const accent of ["US", "UK"]) {
      const g = document.createElement("optgroup");
      g.label = accent === "US" ? "American English" : "British English";
      for (const v of voices.filter((x) => x.accent === accent)) {
        const o = document.createElement("option");
        o.value = v.id;
        o.textContent = id === "voice" ? `${v.name} (${v.gender.toLowerCase()}, grade ${v.grade})` : `${v.name} · ${accent}`;
        g.append(o);
      }
      sel.append(g);
    }
    sel.value = settings.voice;
  }
  player.voice = settings.voice;
}

// ------------------------------------------------------------------ opening

function showLoading(text: string, p: number): void {
  $("loading").hidden = false;
  $("loading-text").textContent = text;
  $("loading-bar").style.width = Math.round(p * 100) + "%";
}

async function fingerprint(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", data.slice(0, Math.min(data.length, 4 << 20)) as BufferSource);
  return [...new Uint8Array(digest)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("") + data.length.toString(36);
}

async function openFile(f: FileData): Promise<void> {
  player.stop();
  showLoading(`Opening ${f.name}…`, 0);
  try {
    docKey = await fingerprint(f.data);
    if (pdfTask) { void pdfTask.destroy(); pdfTask = null; }
    viewer.clear();
    pdfTask = pdfjs.getDocument({
      data: f.data,
      cMapUrl: "./pdfjs/cmaps/",
      cMapPacked: true,
      standardFontDataUrl: "./pdfjs/standard_fonts/",
      wasmUrl: "./pdfjs/wasm/",
      iccUrl: "./pdfjs/iccs/",
      isEvalSupported: false,
      disableFontFace: new URLSearchParams(location.search).has("nofontface"),
    } as any);
    const pdf = await pdfTask.promise;
    const analysed = await analyze(pdf as any, f.name, (done, total) => showLoading(`Reading the layout · page ${done} of ${total}`, done / total));
    doc = toData(analysed);
    groups = doc.groups;
    viewer.zoom = settings.zoom;
    viewer.load(pdf, doc);
    document.body.classList.remove("no-doc");
    $("welcome").hidden = true;
    $("doc-title").textContent = f.name;
    document.title = `${f.name} · Readalong`;
    renderSections();
    renderSkipGroups();
    applySkips();
    rebuildQueue();
    const pos = loadPosition(docKey);
    player.setQueue(player.queue, pos ? nearestUtterance(player.queue, pos.b, pos.k) : 0);
    showPosition(player.cur, false);
    const u = player.queue[player.cur];
    const r = u && uttRects(u)[0];
    if (u && r) requestAnimationFrame(() => viewer.scrollTo(u.page, r, true));
    $("scroller").focus({ preventScroll: true });
    if (screenshot) void screenshotSequence();
  } catch (e: any) {
    toast(`Couldn't open ${f.name}: ${e?.message ?? e}`, 7000);
  } finally {
    $("loading").hidden = true;
  }
}

async function openDialog(): Promise<void> {
  const f = await api.openDialog();
  if (f) await openFile(f);
}

async function renderRecent(): Promise<void> {
  const box = $("recent");
  box.innerHTML = "";
  const list = (await api.recent()).slice(0, 5);
  if (!list.length) return;
  const h = document.createElement("h4");
  h.textContent = "Recent";
  box.append(h);
  for (const r of list) {
    const b = document.createElement("button");
    b.innerHTML = `<svg><use href="#i-file"/></svg><span class="rtext"><div class="rname"></div><div class="rpath"></div></span>`;
    b.querySelector(".rname")!.textContent = r.name;
    b.querySelector(".rpath")!.textContent = r.path;
    b.addEventListener("click", async () => {
      const f = await api.openPath(r.path);
      if (f) await openFile(f);
    });
    box.append(b);
  }
}

// ------------------------------------------------------------------ skipping

function groupSkipped(g: string): boolean {
  return isSkipped(settings.skip, groups, g);
}
function blockSkipped(b: BlockData): boolean {
  if (b.kind === "table") return skipValue(settings.skip, groups, "tables") === "skip";
  return !!b.group && groupSkipped(b.group);
}
function describe(b: BlockData): string {
  const label = kindLabel(b.kind);
  if (!b.group) return `${label}. Click to read from here.`;
  return `${label}: ${b.why || "detected"}. ${blockSkipped(b) ? "Skipped" : "Read"}; change this in Settings.`;
}

function applySkips(): void {
  if (!doc) return;
  viewer.applySkips(blockSkipped, groupSkipped, describe);
  document.querySelectorAll<HTMLAnchorElement>("#sections a").forEach((a) => {
    const b = doc!.blocks[Number(a.dataset.block)];
    a.classList.toggle("skipped", !!b && blockSkipped(b));
  });
  const counts: Record<string, number> = {};
  for (const b of doc.blocks) {
    if (b.group) counts[b.group] = (counts[b.group] ?? 0) + 1;
    for (const sp of b.sp) counts[sp[3]] = (counts[sp[3]] ?? 0) + 1;
  }
  for (const g of groups) {
    const c = document.querySelector(`.skip-group[data-g="${g.id}"] .count`);
    if (c) c.textContent = counts[g.id] ? `${counts[g.id]} found` : "none found";
  }
  const parts = groups.filter((g) => counts[g.id] && groupSkipped(g.id)).map((g) => `${counts[g.id]} ${g.label.charAt(0).toLowerCase()}${g.label.slice(1)}`);
  $("skip-summary").textContent = parts.length ? `Skipping ${parts.join(", ")}.` : "Reading everything.";
}

function rebuildQueue(): void {
  if (!doc) return;
  const prev = player.queue[player.cur];
  const queue = buildQueue(doc, settings.skip);
  const idx = prev ? nearestUtterance(queue, prev.b, prev.k) : 0;
  const same = prev && queue[idx] && queue[idx].b === prev.b && queue[idx].k === prev.k;
  player.setQueue(queue, idx);
  if (player.playing && !same) void player.playAt(idx);
  else if (same) player.keepCurrentAt(idx);
}

function changedSkips(): void {
  saveSettings(settings);
  applySkips();
  rebuildQueue();
  showPosition(player.cur, false);
}

function renderSkipGroups(): void {
  const box = $("skip-groups");
  box.innerHTML = "";
  for (const g of groups) {
    const wrap = document.createElement("div");
    wrap.className = "skip-group";
    wrap.dataset.g = g.id;
    const v = skipValue(settings.skip, groups, g.id);
    wrap.innerHTML = `<label class="switch"><input type="checkbox"><span class="track"></span><span><b></b><span class="count"></span></span></label><span class="help"></span>`;
    const cb = wrap.querySelector("input")!;
    cb.checked = typeof v === "string" ? v === "skip" : !!v;
    wrap.querySelector("b")!.textContent = `Skip ${g.label.charAt(0).toLowerCase()}${g.label.slice(1)}`;
    wrap.querySelector(".help")!.textContent = g.help;
    let sel: HTMLSelectElement | null = null;
    if (g.choices) {
      const choices = g.choices.filter((c) => c.id !== "skip");
      sel = document.createElement("select");
      for (const c of choices) {
        const o = document.createElement("option");
        o.value = c.id;
        o.textContent = `Otherwise: ${c.label.toLowerCase()}`;
        sel.append(o);
      }
      const remembered = settings.skip[`${g.id}.mode`];
      sel.value = typeof v === "string" && v !== "skip" ? v : typeof remembered === "string" ? remembered : choices[0].id;
      sel.disabled = cb.checked;
      sel.addEventListener("change", () => {
        settings.skip[`${g.id}.mode`] = sel!.value;
        if (!cb.checked) settings.skip[g.id] = sel!.value;
        changedSkips();
      });
      wrap.append(sel);
    }
    cb.addEventListener("change", () => {
      if (sel) {
        settings.skip[g.id] = cb.checked ? "skip" : sel.value;
        sel.disabled = cb.checked;
      } else settings.skip[g.id] = cb.checked;
      changedSkips();
    });
    box.append(wrap);
  }
  applySkips();
}

// ------------------------------------------------------------------ sections

function renderSections(): void {
  const nav = $("sections");
  nav.innerHTML = "";
  const secs = doc?.sections ?? [];
  $("sections-source").textContent = secs.length ? (secs[0].source === "outline" ? "from the outline" : "detected") : "";
  if (!secs.length) {
    nav.innerHTML = `<div class="empty">No sections found. Click any paragraph to read from there.</div>`;
    return;
  }
  for (const s of secs) {
    const a = document.createElement("a");
    a.dataset.level = String(Math.min(4, s.level));
    a.dataset.block = String(s.block);
    a.title = s.title;
    const pg = document.createElement("span");
    pg.className = "pg";
    pg.textContent = String(s.page + 1);
    a.append(pg, document.createTextNode(s.title));
    a.addEventListener("click", () => jumpToBlock(s.block));
    nav.append(a);
  }
}

function updateCurrentSection(): void {
  const u = player.queue[player.cur];
  if (!u) return;
  let best: HTMLAnchorElement | null = null;
  document.querySelectorAll<HTMLAnchorElement>("#sections a").forEach((a) => {
    a.classList.remove("current");
    if (Number(a.dataset.block) <= u.b) best = a;
  });
  if (best) {
    (best as HTMLAnchorElement).classList.add("current");
    (best as HTMLAnchorElement).scrollIntoView({ block: "nearest" });
  }
}

function jumpToBlock(id: number): void {
  if (!doc) return;
  const b = doc.blocks[id];
  if (b) viewer.scrollTo(b.p, b.box, true);
  viewer.userScrollAt = Date.now();
  const idx = nearestUtterance(player.queue, id, 0);
  if (player.playing) void player.playAt(idx, false);
  else { player.cur = idx; showPosition(idx, false); }
}

// ------------------------------------------------------------------ settings sheet

function setSpeed(v: number): void {
  settings.speed = Math.min(3, Math.max(0.5, Math.round(v * 20) / 20));
  saveSettings(settings);
  player.setSpeed(settings.speed);
  ($("speed") as HTMLInputElement).value = String(settings.speed);
  $("speed-label").textContent = settings.speed.toFixed(2) + "×";
  const short = settings.speed.toFixed(Math.round(settings.speed * 100) % 10 ? 2 : 1) + "×";
  $("speed-val").textContent = short;
  $("m-speed").textContent = short;
}
function setVoice(v: string): void {
  settings.voice = v;
  saveSettings(settings);
  ($("voice") as HTMLSelectElement).value = v;
  ($("voice-quick") as HTMLSelectElement).value = v;
  player.setVoice(v);
}
function toggleSheet(open?: boolean): void {
  const sheet = $("sheet");
  const show = open ?? sheet.hidden;
  sheet.hidden = !show;
  $("workspace").classList.toggle("sheet-open", show);
  $("btn-settings").classList.toggle("on", show);
  requestAnimationFrame(() => viewer.layout());
}
function toggleSidebar(): void {
  settings.sidebar = !settings.sidebar;
  saveSettings(settings);
  applyTheme();
  window.setTimeout(() => viewer.layout(), 260);
}
function setZoom(z: number): void {
  settings.zoom = Math.min(3, Math.max(0.4, Math.round(z * 10) / 10));
  saveSettings(settings);
  viewer.zoom = settings.zoom;
  viewer.layout();
  $("zoom-val").textContent = Math.round(settings.zoom * 100) + "%";
}

// ------------------------------------------------------------------ commands & keys

function command(c: Command): void {
  switch (c) {
    case "toggle-play": player.toggle(); break;
    case "next": player.step(1); break;
    case "prev": player.step(-1); break;
    case "open": void openDialog(); break;
    case "settings": toggleSheet(); break;
    case "sidebar": toggleSidebar(); break;
    case "mini": if (screenshot) void screenshotMini(); break;
    case "zoom-in": setZoom(settings.zoom + 0.1); break;
    case "zoom-out": setZoom(settings.zoom - 0.1); break;
  }
}

function onKey(e: KeyboardEvent): void {
  const t = e.target as HTMLElement;
  const tag = t.tagName.toLowerCase();
  if ((tag === "input" && (t as HTMLInputElement).type !== "checkbox" && (t as HTMLInputElement).type !== "range") || tag === "select") return;
  const k = e.key;
  const ctrl = e.ctrlKey || e.metaKey;
  let handled = true;
  if (ctrl && k.toLowerCase() === "o") void openDialog();
  else if (ctrl && k.toLowerCase() === "m") api.toggleMini();
  else if (ctrl && k.toLowerCase() === "t") api.setAlwaysOnTop(!windowState.alwaysOnTop);
  else if (ctrl && k.toLowerCase() === "b") toggleSidebar();
  else if (ctrl && k === ",") toggleSheet();
  else if (ctrl && (k === "=" || k === "+")) setZoom(settings.zoom + 0.1);
  else if (ctrl && k === "-") setZoom(settings.zoom - 0.1);
  else if (ctrl && k === "0") setZoom(1);
  else if (ctrl || e.altKey) handled = false;
  else if (k === " " || k === "k") player.toggle();
  else if (k === "ArrowRight") e.shiftKey ? player.para(1) : player.step(1);
  else if (k === "ArrowLeft") e.shiftKey ? player.para(-1) : player.step(-1);
  else if (k === "ArrowDown") player.para(1);
  else if (k === "ArrowUp") player.para(-1);
  else if (k === "[") setSpeed(settings.speed - 0.1);
  else if (k === "]") setSpeed(settings.speed + 0.1);
  else if (k === "Escape") toggleSheet(false);
  else handled = false;
  if (handled) e.preventDefault();
}

// ------------------------------------------------------------------ screenshots (self-test)

async function screenshotSequence(): Promise<void> {
  // Show a mid-document sentence with a word highlighted, as during playback
  await new Promise((r) => setTimeout(r, 400));
  const target = Math.min(player.queue.length - 1, 2);
  player.cur = target;
  showPosition(target, false);
  const u = player.queue[target];
  if (u) {
    const r = uttRects(u)[0];
    if (r) viewer.scrollTo(u.page, r, true);
    showWord(Math.min(3, u.tokens.length - 1));
  }
  toggleSheet(true);
  // Voice self-test: wait for the model, synthesize the staged sentence
  for (let i = 0; i < 120 && !player.ttsReady; i++) await new Promise((r) => setTimeout(r, 500));
  if (u && player.ttsReady) {
    try {
      const t0 = performance.now();
      const r = await api.speak(u.tokens.map((t) => t.t), settings.voice, 1);
      console.log(`voice self-test: ${r.duration.toFixed(2)} s of audio in ${((performance.now() - t0) / 1000).toFixed(2)} s (worker RTF ${r.rtf.toFixed(3)}), ${r.starts.length} word timings, ${r.wav.length} bytes`);
    } catch (e: any) {
      console.log(`voice self-test failed: ${e?.message ?? e}`);
    }
  } else console.log("voice self-test: model not ready");
  await new Promise((r) => setTimeout(r, 1000));
  api.shotReady("full");
}
async function screenshotMini(): Promise<void> {
  await new Promise((r) => setTimeout(r, 700));
  updateMini();
  const u = player.queue[player.cur];
  if (u) renderMiniText(Math.min(3, u.tokens.length - 1));
  await new Promise((r) => setTimeout(r, 300));
  api.shotReady("mini");
}

// ------------------------------------------------------------------ wiring

function wire(): void {
  const click = (id: string, f: () => void) => $(id).addEventListener("click", f);
  click("btn-menu", () => {
    const r = $("btn-menu").getBoundingClientRect();
    api.showMenu(r.left, r.bottom + 2);
  });
  click("btn-min", () => api.minimize());
  click("btn-max", () => api.toggleMaximize());
  click("btn-close", () => api.close());
  $("titlebar").addEventListener("dblclick", (e) => { if ((e.target as HTMLElement).closest(".drag-fill, .doc-title")) api.toggleMaximize(); });
  click("btn-pin", () => api.setAlwaysOnTop(!windowState.alwaysOnTop));
  click("btn-mini", () => api.toggleMini());
  click("m-expand", () => api.toggleMini());
  click("btn-sidebar", toggleSidebar);
  click("btn-settings", () => toggleSheet());
  click("btn-sheet-close", () => toggleSheet(false));
  click("btn-open", () => void openDialog());
  click("voice-pill", () => { if ($("voice-pill").classList.contains("error")) api.retryTts(); });
  for (const [a, b] of [["btn-play", "m-play"], ["btn-prev", "m-prev"], ["btn-next", "m-next"], ["btn-slower", "m-slower"], ["btn-faster", "m-faster"]]) {
    const f = {
      "btn-play": () => (doc ? player.toggle() : void openDialog()),
      "btn-prev": () => player.step(-1),
      "btn-next": () => player.step(1),
      "btn-slower": () => setSpeed(settings.speed - 0.1),
      "btn-faster": () => setSpeed(settings.speed + 0.1),
    }[a]!;
    click(a, f);
    click(b, f);
  }
  click("btn-prevpara", () => player.para(-1));
  click("btn-nextpara", () => player.para(1));
  click("btn-zoomin", () => setZoom(settings.zoom + 0.1));
  click("btn-zoomout", () => setZoom(settings.zoom - 0.1));
  $<HTMLInputElement>("speed").addEventListener("input", (e) => setSpeed(Number((e.target as HTMLInputElement).value)));
  for (const id of ["voice", "voice-quick"]) $<HTMLSelectElement>(id).addEventListener("change", (e) => setVoice((e.target as HTMLSelectElement).value));
  $<HTMLSelectElement>("dtype").addEventListener("change", (e) => {
    api.setDtype((e.target as HTMLSelectElement).value);
    toast("Switching the voice model. It downloads once if it isn't on this PC yet.");
  });
  const bindSwitch = (id: string, key: "showSkipped" | "wordHl" | "follow" | "darkPages", after?: () => void) => {
    const cb = $<HTMLInputElement>(id);
    cb.checked = settings[key];
    cb.addEventListener("change", () => { settings[key] = cb.checked; saveSettings(settings); applyTheme(); after?.(); });
  };
  bindSwitch("show-skipped", "showSkipped");
  bindSwitch("word-hl", "wordHl", () => showWord(-1));
  bindSwitch("follow", "follow");
  bindSwitch("dark-pages", "darkPages");
  const theme = $<HTMLSelectElement>("theme");
  theme.value = settings.theme;
  theme.addEventListener("change", () => { settings.theme = theme.value as any; saveSettings(settings); applyTheme(); });

  viewer.onBlockClick = (id, k) => {
    if (!doc) return;
    const b = doc.blocks[id];
    if (blockSkipped(b)) toast(`${kindLabel(b.kind)} is skipped, so reading starts after it.`);
    viewer.userScrollAt = Date.now();
    player.playing = true;
    void player.playAt(nearestUtterance(player.queue, id, k), false);
  };

  document.addEventListener("keydown", onKey);

  // Drag and drop anywhere in the window
  let depth = 0;
  window.addEventListener("dragenter", (e) => { if (e.dataTransfer?.types.includes("Files")) { depth++; $("dropzone").hidden = false; } });
  window.addEventListener("dragleave", () => { depth = Math.max(0, depth - 1); if (!depth) $("dropzone").hidden = true; });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", async (e) => {
    e.preventDefault();
    depth = 0;
    $("dropzone").hidden = true;
    const file = [...(e.dataTransfer?.files ?? [])].find((f) => /\.pdf$/i.test(f.name) || f.type === "application/pdf");
    if (!file) { toast("Drop a PDF file."); return; }
    const path = api.pathForFile(file);
    const f = path ? await api.openPath(path) : { path: "", name: file.name, data: new Uint8Array(await file.arrayBuffer()) };
    if (f) await openFile(f);
  });

  if ("mediaSession" in navigator) {
    navigator.mediaSession.setActionHandler("play", () => player.play());
    navigator.mediaSession.setActionHandler("pause", () => player.pause());
    navigator.mediaSession.setActionHandler("nexttrack", () => player.step(1));
    navigator.mediaSession.setActionHandler("previoustrack", () => player.step(-1));
  }

  api.onCommand(command);
  api.onOpenFile((f) => void openFile(f));
  api.onWindowState(applyWindowState);
  api.onTtsStatus(showTts);
}

async function init(): Promise<void> {
  document.body.classList.add("no-doc");
  applyTheme();
  wire();
  setSpeed(settings.speed);
  setZoom(settings.zoom);
  updateMini();
  const info = await api.initial();
  screenshot = info.screenshot;
  document.body.classList.toggle("mica", info.mica);
  applyWindowState(info.window);
  $("about").textContent = `Readalong ${info.version}. Voice: Kokoro-82M via kokoro-js, on this PC. PDF: PDF.js.`;
  showTts(await api.ttsStatus());
  void renderRecent();
  if (info.file) await openFile(info.file);
}

void init();
