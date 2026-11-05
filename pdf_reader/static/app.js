/* pdf-reader front end: page view, reading queue, playback and settings. */
"use strict";

const $ = (id) => document.getElementById(id);
const SETTINGS_KEY = "pdf-reader.settings";
const POS_KEY = "pdf-reader.pos.";
const LOOKAHEAD = 3;          // sentences synthesised ahead of the one playing
const MAX_CLIPS = 160;        // audio clips kept in the browser
const KIND_LABELS = {
  body: "Body text", heading: "Heading", header: "Running header", footer: "Running footer",
  page_number: "Page number", table: "Table", caption: "Caption", figure_text: "Text in a figure",
  footnote: "Footnote", references: "References",
  citation: "Citation", url: "URL", footnote_mark: "Footnote marker",
};
const FALLBACK_GROUPS = [
  { id: "headers", label: "Running headers, footers and page numbers", default: true },
  { id: "tables", label: "Tables", choices: [{ id: "skip", label: "Skip" }, { id: "rows", label: "Read as rows" }, { id: "plain", label: "Read cells in order" }], default: "skip" },
  { id: "figures", label: "Figures and captions", default: true },
  { id: "citations", label: "Citations, URLs and footnotes", default: true },
];
const DEFAULTS = {
  voice: "af_heart", speed: 1.0, skip: {}, showSkipped: true, wordHl: true, follow: true,
  darkPages: true, theme: "system", zoom: 1, sidebar: true,
};

let settings = loadSettings();
let groups = FALLBACK_GROUPS;
let doc = null;
let pageEls = [];
let blockEls = [];
let queue = [];
let firstUtt = new Map();     // block id -> first queue index
let cur = 0;
let playing = false;
let waiting = false;
let ttsReady = false;
let curClip = null;
let curClipIdx = -1;
let playToken = 0;
let raf = 0;
let lastWord = -1;
let userScrollAt = 0;
let hlPage = null;
let maxPageW = 612;

const audio = new Audio();
audio.preload = "auto";
const clips = new Map();      // cache key -> clip entry
const waiters = new Map();    // cache key -> [resolve]
let inflight = 0;
const measure = document.createElement("canvas").getContext("2d");

// ------------------------------------------------------------------ settings

function loadSettings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}"); } catch (e) { s = {}; }
  return { ...DEFAULTS, ...s, skip: { ...(s.skip || {}) } };
}
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { /* private mode */ }
}
function skipValue(gid) {
  if (gid in settings.skip) return settings.skip[gid];
  const g = groups.find((x) => x.id === gid);
  return g ? g.default : false;
}
function isSkipped(gid) {
  if (!gid) return false;
  const v = skipValue(gid);
  return typeof v === "string" ? v === "skip" : !!v;
}
function blockSkipped(b) {
  return !!b.group && isSkipped(b.group);
}

// ------------------------------------------------------------------ helpers

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function place(e, box, P, pad = 0) {
  e.style.left = ((box[0] - pad) / P.w) * 100 + "%";
  e.style.top = ((box[1] - pad) / P.h) * 100 + "%";
  e.style.width = ((box[2] - box[0] + 2 * pad) / P.w) * 100 + "%";
  e.style.height = ((box[3] - box[1] + 2 * pad) / P.h) * 100 + "%";
}
let toastTimer = 0;
function toast(msg, ms = 3200) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hasWord = (s) => /[\p{L}\p{N}]/u.test(s);

// ------------------------------------------------------------------ theme

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
function applyTheme() {
  const root = document.documentElement;
  if (settings.theme === "light" || settings.theme === "dark") root.dataset.theme = settings.theme;
  else delete root.dataset.theme;
  const dark = settings.theme === "dark" || (settings.theme === "system" && darkQuery.matches);
  document.body.classList.toggle("is-dark", dark);
  document.body.classList.toggle("dark-pages", !!settings.darkPages);
  document.body.classList.toggle("show-skipped", !!settings.showSkipped);
  document.body.classList.toggle("no-sidebar", !settings.sidebar);
}
darkQuery.addEventListener("change", applyTheme);

// ------------------------------------------------------------------ TTS status

async function pollStatus() {
  for (;;) {
    let st = null;
    try { st = await (await fetch("/api/status")).json(); } catch (e) { /* server restarting */ }
    if (st) {
      if (st.groups && st.groups.length) { groups = st.groups; }
      showTts(st.tts);
      if (st.tts.state === "ready" && !ttsReady) {
        ttsReady = true;
        await loadVoices();
        if (playing) playAt(cur);
      }
      if (st.tts.state === "ready" || st.tts.state === "error") return st;
    }
    await sleep(800);
  }
}
function showTts(t) {
  const pill = $("tts-pill");
  pill.classList.toggle("ready", t.state === "ready");
  pill.classList.toggle("error", t.state === "error");
  const pct = Math.round((t.progress || 0) * 100);
  const text = {
    idle: "Voice model: starting",
    downloading: `Downloading voice model ${pct}%`,
    loading: "Loading voice model…",
    ready: "Voice ready",
    error: "Voice model failed",
  }[t.state] || t.state;
  $("tts-text").textContent = text;
  $("tts-bar").style.width = pct + "%";
  pill.title = t.message || `Kokoro-82M (${t.model}) on the CPU`;
  $("engine-info").textContent = `Voice engine: Kokoro-82M ${t.model} via kokoro-onnx, CPU.` +
    (t.rtf ? ` Last sentence took ${(t.rtf * 100).toFixed(0)}% of its length to make.` : "");
  if (t.state === "error") toast("The voice model couldn't load: " + t.message, 8000);
}
async function loadVoices() {
  let data = { voices: [] };
  try { data = await (await fetch("/api/voices")).json(); } catch (e) { return; }
  const voices = data.voices || [];
  if (!voices.find((v) => v.id === settings.voice) && voices.length) settings.voice = data.default || voices[0].id;
  for (const sel of [$("voice"), $("voice-quick")]) {
    sel.innerHTML = "";
    const eng = el("optgroup"); eng.label = "English";
    const other = el("optgroup"); other.label = "Other languages";
    for (const v of voices) {
      const o = el("option", null, sel.id === "voice-quick" ? v.label.replace(/ \(.*\)/, "") + (v.lang === "en-gb" ? " (UK)" : "") : v.label);
      o.value = v.id;
      (v.english ? eng : other).append(o);
    }
    sel.append(eng);
    if (other.children.length) sel.append(other);
    sel.value = settings.voice;
  }
}

// ------------------------------------------------------------------ opening

async function openFile(file) {
  if (!file) return;
  if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") { toast("That doesn't look like a PDF."); return; }
  stop();
  showLoading(`Uploading ${file.name}…`, 0);
  const form = new FormData();
  form.append("file", file, file.name);
  try {
    const r = await fetch("/api/open", { method: "POST", body: form });
    const j = await r.json();
    if (!r.ok) throw new Error(j.detail || r.statusText);
    await loadDoc(j.id, j.name);
  } catch (e) {
    hideLoading();
    toast("Couldn't open the file: " + e.message, 6000);
  }
}

async function loadDoc(id, name) {
  showLoading(`Analysing ${name || "document"}…`, 0);
  for (;;) {
    const r = await fetch(`/api/doc/${id}`);
    const j = await r.json();
    if (r.status === 202) {
      showLoading(`Analysing ${j.name}… page layout, tables, figures`, j.progress);
      await sleep(250);
      continue;
    }
    hideLoading();
    if (!r.ok) { toast("Analysis failed: " + (j.error || j.detail), 8000); return; }
    setDoc(j);
    return;
  }
}
function showLoading(text, p) {
  $("loading").hidden = false;
  $("loading-text").textContent = text;
  $("loading-bar").style.width = Math.round((p || 0) * 100) + "%";
}
function hideLoading() { $("loading").hidden = true; }

function setDoc(d) {
  stop();
  doc = d;
  if (d.groups) groups = d.groups;
  document.title = `${d.name} · PDF Reader`;
  $("docname").textContent = d.name;
  $("empty").hidden = true;
  renderPages();
  renderSections();
  renderSkipGroups();
  applySkipClasses();
  buildQueue();
  const saved = loadPos();
  cur = saved != null ? saved : 0;
  showCurrent(true);
  $("viewer").focus({ preventScroll: true });
}

// ------------------------------------------------------------------ page view

function renderPages() {
  const pages = $("pages");
  pages.innerHTML = "";
  pageEls = [];
  blockEls = [];
  hlPage = null;
  maxPageW = Math.max(...doc.pages.map((p) => p.w));
  doc.pages.forEach((P, i) => {
    const page = el("div", "page");
    page.dataset.p = i;
    const img = new Image();
    img.alt = "";
    img.draggable = false;
    img.decoding = "async";
    img.onload = () => img.classList.add("loaded");
    const overlay = el("div", "overlay");
    const hl = el("div", "hl");
    page.append(img, overlay, hl, el("div", "pnum", String(i + 1)));
    pages.append(page);
    pageEls.push({ page, img, overlay, hl, P, width: 0 });
  });
  for (const b of doc.blocks) {
    const pe = pageEls[b.p];
    const P = pe.P;
    const be = el("div", "block");
    place(be, b.box, P, 1.5);
    be.dataset.b = b.id;
    pe.overlay.append(be);
    const lines = [];
    for (const ln of blockLines(b)) {
      const s = el("span", "line", ln.text);
      const h = Math.max(1, ln.box[3] - ln.box[1]);
      s.style.left = (ln.box[0] / P.w) * 100 + "%";
      s.style.top = (ln.box[1] / P.h) * 100 + "%";
      s.style.fontSize = `calc(var(--s) * ${h.toFixed(2)}px)`;
      measure.font = `${h}px Arial, Helvetica, sans-serif`;
      const wpt = measure.measureText(ln.text).width;
      if (wpt > 0) s.style.transform = `scaleX(${((ln.box[2] - ln.box[0]) / wpt).toFixed(4)})`;
      pe.overlay.append(s);
      lines.push(s);
    }
    const spans = [];
    for (const sp of b.sp) {
      for (const r of charRects(b, sp[0], sp[1])) {
        const e = el("div", "skipspan");
        place(e, r, P, 0.5);
        e.title = `${KIND_LABELS[sp[2]] || sp[2]}${sp[4] ? ` (read as "${sp[4]}")` : ""}`;
        pe.overlay.append(e);
        spans.push({ e, group: sp[3] });
      }
    }
    blockEls[b.id] = { be, lines, spans };
  }
  layoutPages();
  observePages();
}

function blockLines(b) {
  const out = [];
  let curLine = null;
  for (const w of b.w) {
    if (!curLine || curLine.n !== w[6]) {
      curLine = { n: w[6], s: w[4], e: w[5], box: [w[0], w[1], w[2], w[3]] };
      out.push(curLine);
    } else {
      curLine.e = w[5];
      curLine.box = [Math.min(curLine.box[0], w[0]), Math.min(curLine.box[1], w[1]), Math.max(curLine.box[2], w[2]), Math.max(curLine.box[3], w[3])];
    }
  }
  return out.map((l) => ({ text: b.text.slice(l.s, l.e), box: l.box }));
}

// Approximate boxes for characters s..e of a block (inline spans)
function charRects(b, s, e) {
  const byLine = new Map();
  for (const w of b.w) {
    const a = Math.max(s, w[4]), z = Math.min(e, w[5]);
    if (z <= a) continue;
    const len = Math.max(1, w[5] - w[4]);
    const x0 = w[0] + ((a - w[4]) / len) * (w[2] - w[0]);
    const x1 = w[0] + ((z - w[4]) / len) * (w[2] - w[0]);
    const r = byLine.get(w[6]);
    if (!r) byLine.set(w[6], [x0, w[1], x1, w[3]]);
    else { r[0] = Math.min(r[0], x0); r[1] = Math.min(r[1], w[1]); r[2] = Math.max(r[2], x1); r[3] = Math.max(r[3], w[3]); }
  }
  return [...byLine.values()];
}
function wordRects(b, idxs) {
  const byLine = new Map();
  for (const i of idxs) {
    const w = b.w[i];
    if (!w) continue;
    const r = byLine.get(w[6]);
    if (!r) byLine.set(w[6], [w[0], w[1], w[2], w[3]]);
    else { r[0] = Math.min(r[0], w[0]); r[1] = Math.min(r[1], w[1]); r[2] = Math.max(r[2], w[2]); r[3] = Math.max(r[3], w[3]); }
  }
  return [...byLine.values()];
}

function layoutPages() {
  if (!doc) return;
  const viewer = $("viewer");
  const avail = Math.max(320, viewer.clientWidth - 40);
  const base = Math.min(avail, 980);
  const s = (base * settings.zoom) / maxPageW;
  for (const pe of pageEls) {
    pe.page.style.width = Math.round(pe.P.w * s) + "px";
    pe.page.style.height = Math.round(pe.P.h * s) + "px";
    pe.page.style.setProperty("--s", s.toFixed(5));
    pe.scale = s;
    if (pe.visible) loadImage(pe);
  }
  $("zoom-label").textContent = Math.round(settings.zoom * 100) + "%";
}
function loadImage(pe) {
  const dpr = window.devicePixelRatio || 1;
  const want = Math.min(3000, Math.ceil((pe.P.w * pe.scale * dpr) / 200) * 200);
  if (want <= pe.width) return;
  pe.width = want;
  pe.img.src = `/api/doc/${doc.id}/page/${pe.page.dataset.p}?w=${want}`;
}
let pageObserver = null;
function observePages() {
  if (pageObserver) pageObserver.disconnect();
  pageObserver = new IntersectionObserver((entries) => {
    for (const en of entries) {
      const pe = pageEls[+en.target.dataset.p];
      pe.visible = en.isIntersecting;
      if (en.isIntersecting) loadImage(pe);
    }
  }, { root: $("viewer"), rootMargin: "1200px 0px" });
  for (const pe of pageEls) pageObserver.observe(pe.page);
}

function setZoom(z) {
  const viewer = $("viewer");
  const ratio = viewer.scrollTop / Math.max(1, viewer.scrollHeight);
  settings.zoom = Math.min(3, Math.max(0.4, Math.round(z * 10) / 10));
  saveSettings();
  layoutPages();
  viewer.scrollTop = ratio * viewer.scrollHeight;
}

// ------------------------------------------------------------------ skip display

function describe(b) {
  const label = KIND_LABELS[b.kind] || b.kind;
  if (!b.group) return `${label}. Click to read from here.`;
  const skipped = blockSkipped(b);
  return `${label}: ${b.why || "detected"}. ${skipped ? "Skipped" : "Read"} (change in Settings).`;
}
function applySkipClasses() {
  if (!doc) return;
  for (const b of doc.blocks) {
    const x = blockEls[b.id];
    if (!x) continue;
    const skip = blockSkipped(b);
    x.be.classList.toggle("skip", skip);
    x.be.title = describe(b);
    for (const l of x.lines) l.classList.toggle("skip", skip);
    for (const sp of x.spans) sp.e.classList.toggle("on", !skip && isSkipped(sp.group));
  }
  // Sidebar: dim sections whose heading is skipped
  document.querySelectorAll("#sections a").forEach((a) => {
    const b = doc.blocks[+a.dataset.block];
    a.classList.toggle("skipped", !!b && blockSkipped(b));
  });
  const counts = {};
  for (const b of doc.blocks) {
    if (b.group) counts[b.group] = (counts[b.group] || 0) + 1;
    for (const sp of b.sp) counts[sp[3]] = (counts[sp[3]] || 0) + 1;
  }
  for (const g of groups) {
    const c = document.querySelector(`.skip-group[data-g="${g.id}"] .count`);
    if (c) c.textContent = counts[g.id] ? `${counts[g.id]} found` : "none found";
  }
  const parts = groups.filter((g) => counts[g.id] && isSkipped(g.id)).map((g) => `${counts[g.id]} ${g.id}`);
  $("skip-summary").textContent = parts.length ? `Skipping ${parts.join(", ")}.` : "Nothing is being skipped.";
}

function renderSkipGroups() {
  const box = $("skip-groups");
  box.innerHTML = "";
  for (const g of groups) {
    const wrap = el("div", "skip-group");
    wrap.dataset.g = g.id;
    const lab = el("label", "check");
    const cb = el("input");
    cb.type = "checkbox";
    const v = skipValue(g.id);
    cb.checked = typeof v === "string" ? v === "skip" : !!v;
    const txt = el("span");
    txt.append(document.createTextNode(`Skip ${g.label.charAt(0).toLowerCase()}${g.label.slice(1)}`), el("span", "count"));
    lab.append(cb, txt);
    wrap.append(lab);
    if (g.help) wrap.append(el("span", "help", g.help));
    let sel = null;
    if (g.choices) {
      sel = el("select");
      for (const c of g.choices.filter((c) => c.id !== "skip")) {
        const o = el("option", null, `When not skipped: ${c.label.toLowerCase()}`);
        o.value = c.id;
        sel.append(o);
      }
      sel.value = typeof v === "string" && v !== "skip" ? v : (settings.skip[g.id + ".mode"] || g.choices.find((c) => c.id !== "skip").id);
      sel.disabled = cb.checked;
      sel.addEventListener("change", () => {
        settings.skip[g.id + ".mode"] = sel.value;
        if (!cb.checked) settings.skip[g.id] = sel.value;
        changedSkips();
      });
      wrap.append(sel);
    }
    cb.addEventListener("change", () => {
      if (g.choices) {
        settings.skip[g.id] = cb.checked ? "skip" : sel.value;
        sel.disabled = cb.checked;
      } else {
        settings.skip[g.id] = cb.checked;
      }
      changedSkips();
    });
    box.append(wrap);
  }
}
function changedSkips() {
  saveSettings();
  applySkipClasses();
  const pos = queue[cur];
  buildQueue();
  if (pos) cur = nearestUtt(pos.b, pos.k);
  if (playing) {
    // Keep the sentence that is playing unless it is now skipped
    const same = queue[cur] && pos && queue[cur].b === pos.b && queue[cur].k === pos.k;
    if (!same) playAt(cur);
    else { curClipIdx = cur; showCurrent(false); }
  } else showCurrent(false);
}

// ------------------------------------------------------------------ sections

function renderSections() {
  const nav = $("sections");
  nav.innerHTML = "";
  const secs = doc.sections || [];
  $("sections-source").textContent = secs.length ? (secs[0].source === "outline" ? "from the PDF outline" : "detected headings") : "";
  if (!secs.length) {
    nav.append(el("p", "muted pad", "No sections found. Click any paragraph to read from there."));
    return;
  }
  for (const s of secs) {
    const a = el("a");
    a.dataset.level = Math.min(4, s.level);
    a.dataset.block = s.block;
    a.title = s.title;
    a.append(el("span", "pg", String(s.page + 1)), document.createTextNode(s.title));
    a.addEventListener("click", () => jumpToBlock(s.block, true));
    nav.append(a);
  }
}
function updateCurrentSection() {
  const u = queue[cur];
  if (!u) return;
  let best = null;
  document.querySelectorAll("#sections a").forEach((a) => {
    a.classList.remove("current");
    if (+a.dataset.block <= u.b) best = a;
  });
  if (best) {
    best.classList.add("current");
    const nav = $("sections");
    const r = best.getBoundingClientRect(), n = nav.getBoundingClientRect();
    if (r.top < n.top || r.bottom > n.bottom) best.scrollIntoView({ block: "nearest" });
  }
}
function jumpToBlock(blockId, start) {
  const idx = nearestUtt(blockId, 0);
  const b = doc.blocks[blockId];
  if (b) scrollToBox(b.p, b.box, true);
  if (start && playing) playAt(idx, { scroll: false });
  else { cur = idx; curClipIdx = -1; showCurrent(false); }
}

// ------------------------------------------------------------------ reading queue

function buildTokens(b, s, e) {
  const spans = b.sp.filter((sp) => isSkipped(sp[3]) && sp[1] > s && sp[0] < e);
  const text = b.text;
  const tokens = [];
  b.w.forEach((w, wi) => {
    const a = Math.max(s, w[4]), z = Math.min(e, w[5]);
    if (z <= a) return;
    let kept = "";
    const reps = [];
    for (let c = a; c < z; c++) {
      const sp = spans.find((x) => c >= x[0] && c < x[1]);
      if (!sp) kept += text[c];
      else if (c === sp[0] && sp[4]) reps.push(sp[4]);
    }
    const piece = [kept.trim(), ...reps].filter(Boolean).join(" ");
    if (!piece) return;
    const glued = a > 0 && text[a - 1] !== " " && tokens.length && tokens[tokens.length - 1].last === wi - 1;
    const prev = tokens[tokens.length - 1];
    if (prev && (glued || !hasWord(piece))) {
      // No space before it (hyphenation, superscript), or punctuation left
      // over after removing a citation: attach to the previous token
      prev.t += piece;
      prev.w.push(wi);
      prev.last = wi;
    } else {
      tokens.push({ t: piece, w: [wi], last: wi });
    }
  });
  return tokens;
}

function buildQueue() {
  queue = [];
  firstUtt = new Map();
  if (!doc) return;
  for (const b of doc.blocks) {
    if (b.kind === "table" && b.rows) {
      const mode = skipValue("tables");
      if (mode === "skip" || mode === true) continue;
      const header = (b.rows[0] && b.rows[0].cells) || [];
      b.rows.forEach((r, ri) => {
        let text;
        if (mode === "rows") {
          if (ri === 0 && b.rows.length > 1) return;
          const parts = r.cells.map((c, ci) => {
            c = (c || "").trim();
            if (!c) return null;
            const h = (header[ci] || "").trim();
            return h && h !== c ? `${h}, ${c}` : c;
          }).filter(Boolean);
          if (!parts.length) return;
          text = `Row ${ri}: ${parts.join("; ")}.`;
        } else {
          const parts = r.cells.map((c) => (c || "").trim()).filter(Boolean);
          if (!parts.length) return;
          text = parts.join(", ") + ".";
        }
        pushUtt({ b: b.id, k: ri, page: b.p, rects: [r.box], tokens: text.split(/\s+/).map((t) => ({ t, w: [] })) });
      });
      continue;
    }
    if (blockSkipped(b)) continue;
    b.s.forEach(([s, e], si) => {
      const tokens = buildTokens(b, s, e);
      if (!tokens.some((t) => hasWord(t.t))) return;
      pushUtt({ b: b.id, k: si, page: b.p, s, e, tokens });
    });
  }
}
function pushUtt(u) {
  if (!firstUtt.has(u.b)) firstUtt.set(u.b, queue.length);
  u.i = queue.length;
  queue.push(u);
}
function nearestUtt(blockId, k) {
  for (let i = 0; i < queue.length; i++) {
    const u = queue[i];
    if (u.b > blockId || (u.b === blockId && u.k >= k)) return i;
  }
  return Math.max(0, queue.length - 1);
}
function uttRects(u) {
  if (u.rects) return u.rects;
  const b = doc.blocks[u.b];
  const idx = [];
  b.w.forEach((w, i) => { if (w[4] < u.e && w[5] > u.s) idx.push(i); });
  u.rects = wordRects(b, idx);
  return u.rects;
}
function uttText(u) { return u.tokens.map((t) => t.t).join(" "); }

// ------------------------------------------------------------------ highlight

function showCurrent(scroll) {
  lastWord = -1;
  if (hlPage) hlPage.hl.innerHTML = "";
  const u = queue[cur];
  updateNow();
  if (!u) return;
  const pe = pageEls[u.page];
  hlPage = pe;
  for (const r of uttRects(u)) {
    const d = el("div", "s");
    place(d, r, pe.P, 1.5);
    pe.hl.append(d);
  }
  if (scroll) {
    const rs = uttRects(u);
    if (rs.length) scrollToBox(u.page, rs[0], false);
  }
  updateCurrentSection();
  savePos();
}
function drawWord() {
  if (!curClip || curClipIdx !== cur || !hlPage) return;
  const u = queue[cur];
  if (!settings.wordHl) { hlPage.hl.querySelectorAll(".w").forEach((x) => x.remove()); return; }
  const t = audio.currentTime;
  const st = curClip.starts;
  let k = -1;
  for (let i = 0; i < st.length; i++) { if (st[i] <= t + 0.03) k = i; else break; }
  if (k === lastWord) return;
  lastWord = k;
  hlPage.hl.querySelectorAll(".w").forEach((x) => x.remove());
  const tok = u.tokens[k];
  if (!tok || !tok.w.length) return;
  const b = doc.blocks[u.b];
  for (const r of wordRects(b, tok.w)) {
    const d = el("div", "w");
    place(d, r, hlPage.P, 1);
    hlPage.hl.append(d);
  }
}
function wordLoop() {
  cancelAnimationFrame(raf);
  const tick = () => {
    if (!playing) return;
    drawWord();
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
}
function scrollToBox(pageIdx, box, force) {
  const viewer = $("viewer");
  const pe = pageEls[pageIdx];
  if (!pe) return;
  if (!force && (!settings.follow || Date.now() - userScrollAt < 4000)) return;
  const pr = pe.page.getBoundingClientRect();
  const vr = viewer.getBoundingClientRect();
  const y = pr.top + (box[1] / pe.P.h) * pr.height;
  const y2 = pr.top + (box[3] / pe.P.h) * pr.height;
  const margin = vr.height * 0.18;
  if (!force && y >= vr.top + margin && y2 <= vr.bottom - margin) return;
  viewer.scrollTo({ top: viewer.scrollTop + (y - vr.top) - vr.height * 0.3, behavior: force ? "auto" : "smooth" });
}
function updateNow() {
  const u = queue[cur];
  if (!doc) { $("now-text").textContent = "Nothing open"; return; }
  if (!u) { $("now-text").textContent = "Nothing to read with the current skip settings"; $("now-pos").textContent = ""; return; }
  $("now-text").textContent = uttText(u);
  $("now-pos").textContent = `Page ${u.page + 1} of ${doc.pages.length} · ${Math.round((cur / Math.max(1, queue.length - 1)) * 100)}%`;
  $("doc-bar").style.width = (cur / Math.max(1, queue.length - 1)) * 100 + "%";
}

// ------------------------------------------------------------------ position memory

function savePos() {
  const u = queue[cur];
  if (!doc || !u) return;
  try { localStorage.setItem(POS_KEY + doc.id, JSON.stringify({ b: u.b, k: u.k })); } catch (e) { /* ignore */ }
}
function loadPos() {
  try {
    const p = JSON.parse(localStorage.getItem(POS_KEY + doc.id) || "null");
    if (p && typeof p.b === "number") return nearestUtt(p.b, p.k || 0);
  } catch (e) { /* ignore */ }
  return null;
}

// ------------------------------------------------------------------ audio clips

function kSpeed() { return Math.round(Math.min(2, Math.max(0.5, settings.speed)) * 20) / 20; }
function clipKey(u) { return `${settings.voice}|${kSpeed()}|${uttText(u)}`; }

function pump() {
  if (!ttsReady || inflight >= 1 || !queue.length) return;
  for (let i = cur; i < Math.min(queue.length, cur + 1 + LOOKAHEAD); i++) {
    const k = clipKey(queue[i]);
    const c = clips.get(k);
    if (!c) { fetchClip(queue[i], k); return; }
  }
}
async function fetchClip(u, k) {
  const entry = { state: "pending" };
  clips.set(k, entry);
  inflight++;
  try {
    const r = await fetch("/api/speak", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tokens: u.tokens.map((t) => t.t), voice: settings.voice, speed: kSpeed() }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.detail || r.statusText);
    const a = await fetch(`/api/audio/${j.key}`);
    if (!a.ok) throw new Error("audio fetch failed");
    const blob = await a.blob();
    Object.assign(entry, { state: "ready", url: URL.createObjectURL(blob), starts: j.starts, duration: j.duration, speed: kSpeed() });
  } catch (e) {
    entry.state = "error";
    entry.error = e.message || String(e);
  }
  inflight--;
  const ws = waiters.get(k) || [];
  waiters.delete(k);
  ws.forEach((f) => f(entry));
  evictClips();
  pump();
}
function waitClip(k) {
  const c = clips.get(k);
  if (c && c.state === "ready") return Promise.resolve(c);
  if (c && c.state === "error") clips.delete(k);
  return new Promise((res) => {
    if (!waiters.has(k)) waiters.set(k, []);
    waiters.get(k).push(res);
    pump();
  });
}
function evictClips() {
  if (clips.size <= MAX_CLIPS) return;
  const keep = new Set();
  for (let i = Math.max(0, cur - 5); i < Math.min(queue.length, cur + LOOKAHEAD + 2); i++) keep.add(clipKey(queue[i]));
  for (const [k, c] of clips) {
    if (clips.size <= MAX_CLIPS * 0.75) break;
    if (keep.has(k) || c.state === "pending" || c === curClip) continue;
    if (c.url) URL.revokeObjectURL(c.url);
    clips.delete(k);
  }
}

// ------------------------------------------------------------------ playback

function setWaiting(w) {
  waiting = w;
  $("btn-play").classList.toggle("waiting", w && playing);
}
function updatePlay() {
  $("play-icon").setAttribute("href", playing ? "#i-pause" : "#i-play");
  $("btn-play").setAttribute("aria-label", playing ? "Pause" : "Play");
  $("btn-play").classList.toggle("waiting", waiting && playing);
}
async function playAt(i, opts = {}) {
  if (!queue.length) return;
  cur = Math.min(Math.max(0, i), queue.length - 1);
  const my = ++playToken;
  audio.pause();
  curClipIdx = -1;
  showCurrent(opts.scroll !== false);
  if (!playing) return;
  if (!ttsReady) { setWaiting(true); toast("The voice model is still loading. Reading starts when it's ready."); return; }
  setWaiting(true);
  const clip = await waitClip(clipKey(queue[cur]));
  if (my !== playToken || !playing) return;
  setWaiting(false);
  if (clip.state === "error") {
    toast("Speech failed: " + clip.error, 6000);
    playing = false;
    updatePlay();
    return;
  }
  curClip = clip;
  curClipIdx = cur;
  audio.src = clip.url;
  audio.playbackRate = settings.speed / clip.speed;
  audio.preservesPitch = true;
  try {
    await audio.play();
  } catch (e) {
    if (my === playToken) { playing = false; updatePlay(); toast("The browser blocked audio. Press play again."); }
    return;
  }
  wordLoop();
  pump();
}
function gapAfter(i) {
  const u = queue[i], n = queue[i + 1];
  if (!u || !n) return 0;
  const b = doc.blocks[u.b];
  if (n.b !== u.b) return b.kind === "heading" ? 550 : 380;
  return 120;
}
audio.addEventListener("ended", () => {
  if (!playing) return;
  const my = playToken;
  setTimeout(() => {
    if (my !== playToken || !playing) return;
    if (cur + 1 < queue.length) playAt(cur + 1);
    else { playing = false; updatePlay(); toast("End of the document."); }
  }, gapAfter(cur) / Math.max(0.5, settings.speed));
});

function play() {
  if (!doc || !queue.length) { if (!doc) $("file-input").click(); return; }
  playing = true;
  updatePlay();
  if (curClip && curClipIdx === cur && audio.src && !audio.ended && audio.currentTime > 0) {
    audio.play().then(wordLoop).catch(() => playAt(cur));
  } else {
    playAt(cur, { scroll: true });
  }
}
function pause() {
  playing = false;
  playToken++;
  audio.pause();
  setWaiting(false);
  updatePlay();
}
function stop() {
  pause();
  curClip = null;
  curClipIdx = -1;
}
function toggle() { playing ? pause() : play(); }
function step(d) {
  if (!queue.length) return;
  userScrollAt = 0;
  playAt(cur + d);
}
function para(d) {
  if (!queue.length) return;
  userScrollAt = 0;
  const b = queue[cur].b;
  if (d > 0) {
    let j = cur;
    while (j < queue.length && queue[j].b === b) j++;
    playAt(Math.min(j, queue.length - 1));
  } else {
    const first = firstUtt.get(b);
    if (cur > first) { playAt(first); return; }
    if (cur === 0) { playAt(0); return; }
    playAt(firstUtt.get(queue[cur - 1].b));
  }
}
function setSpeed(v) {
  settings.speed = Math.min(3, Math.max(0.5, Math.round(v * 20) / 20));
  saveSettings();
  $("speed").value = settings.speed;
  $("speed-label").textContent = settings.speed.toFixed(2) + "×";
  $("speed-quick").textContent = settings.speed.toFixed(2) + "×";
  // The sentence playing keeps going at the new rate; the next ones are
  // synthesised at the new speed.
  if (curClip) audio.playbackRate = settings.speed / curClip.speed;
  pump();
}
function setVoice(v) {
  settings.voice = v;
  saveSettings();
  $("voice").value = v;
  $("voice-quick").value = v;
  if (playing) playAt(cur, { scroll: false });
}

// ------------------------------------------------------------------ click to read

function onPageClick(ev) {
  const sel = window.getSelection();
  if (sel && sel.toString().trim()) return;
  const page = ev.target.closest(".page");
  if (!page || !doc) return;
  const pi = +page.dataset.p;
  const P = doc.pages[pi];
  const r = page.getBoundingClientRect();
  const x = ((ev.clientX - r.left) / r.width) * P.w;
  const y = ((ev.clientY - r.top) / r.height) * P.h;
  let best = null, area = Infinity;
  for (const b of doc.blocks) {
    if (b.p !== pi) continue;
    const [x0, y0, x1, y1] = b.box;
    if (x >= x0 - 2 && x <= x1 + 2 && y >= y0 - 2 && y <= y1 + 2) {
      const a = (x1 - x0) * (y1 - y0);
      if (a < area) { best = b; area = a; }
    }
  }
  if (!best) return;
  let k = 0;
  if (best.rows) {
    k = Math.max(0, best.rows.findIndex((row) => y >= row.box[1] && y <= row.box[3]));
  } else if (best.w.length) {
    let wi = 0, dmin = Infinity;
    best.w.forEach((w, i) => {
      const dx = x < w[0] ? w[0] - x : x > w[2] ? x - w[2] : 0;
      const dy = y < w[1] ? w[1] - y : y > w[3] ? y - w[3] : 0;
      const d = dx * dx + dy * dy * 4;
      if (d < dmin) { dmin = d; wi = i; }
    });
    const pos = best.w[wi][4];
    k = Math.max(0, best.s.findIndex(([s, e]) => pos >= s && pos < e));
  }
  if (blockSkipped(best)) toast(`${KIND_LABELS[best.kind] || best.kind} is skipped; reading from the next part that isn't.`);
  userScrollAt = Date.now();  // the user is looking here already
  playing = true;
  updatePlay();
  playAt(nearestUtt(best.id, k), { scroll: false });
}

// ------------------------------------------------------------------ wiring

function initControls() {
  $("btn-open").addEventListener("click", () => $("file-input").click());
  $("btn-open2").addEventListener("click", () => $("file-input").click());
  $("file-input").addEventListener("change", (e) => { openFile(e.target.files[0]); e.target.value = ""; });
  $("btn-play").addEventListener("click", toggle);
  $("btn-prev").addEventListener("click", () => step(-1));
  $("btn-next").addEventListener("click", () => step(1));
  $("btn-prevpara").addEventListener("click", () => para(-1));
  $("btn-nextpara").addEventListener("click", () => para(1));
  $("btn-slower").addEventListener("click", () => setSpeed(settings.speed - 0.1));
  $("btn-faster").addEventListener("click", () => setSpeed(settings.speed + 0.1));
  $("btn-zoomin").addEventListener("click", () => setZoom(settings.zoom + 0.1));
  $("btn-zoomout").addEventListener("click", () => setZoom(settings.zoom - 0.1));
  $("speed").addEventListener("input", (e) => setSpeed(+e.target.value));
  $("voice").addEventListener("change", (e) => setVoice(e.target.value));
  $("voice-quick").addEventListener("change", (e) => setVoice(e.target.value));
  $("btn-settings").addEventListener("click", () => { $("settings").hidden = !$("settings").hidden; layoutPages(); });
  $("btn-settings-close").addEventListener("click", () => { $("settings").hidden = true; layoutPages(); });
  $("btn-sidebar").addEventListener("click", () => { settings.sidebar = !settings.sidebar; saveSettings(); applyTheme(); layoutPages(); });
  $("btn-theme").addEventListener("click", () => {
    const dark = document.body.classList.contains("is-dark");
    settings.theme = dark ? "light" : "dark";
    $("theme").value = settings.theme;
    saveSettings();
    applyTheme();
  });
  const bindCheck = (id, key, after) => {
    $(id).checked = !!settings[key];
    $(id).addEventListener("change", (e) => { settings[key] = e.target.checked; saveSettings(); applyTheme(); if (after) after(); });
  };
  bindCheck("show-skipped", "showSkipped");
  bindCheck("word-hl", "wordHl", () => { lastWord = -1; drawWord(); });
  bindCheck("follow", "follow");
  bindCheck("dark-pages", "darkPages");
  $("theme").value = settings.theme;
  $("theme").addEventListener("change", (e) => { settings.theme = e.target.value; saveSettings(); applyTheme(); });

  $("pages").addEventListener("click", onPageClick);
  const viewer = $("viewer");
  ["wheel", "touchmove"].forEach((t) => viewer.addEventListener(t, () => { userScrollAt = Date.now(); }, { passive: true }));
  window.addEventListener("resize", () => { clearTimeout(window._rz); window._rz = setTimeout(layoutPages, 120); });

  // Drag and drop anywhere
  let dragDepth = 0;
  window.addEventListener("dragenter", (e) => { if ([...e.dataTransfer.types].includes("Files")) { dragDepth++; $("dropmask").hidden = false; } });
  window.addEventListener("dragleave", () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $("dropmask").hidden = true; });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    dragDepth = 0;
    $("dropmask").hidden = true;
    const f = [...(e.dataTransfer.files || [])].find((x) => /\.pdf$/i.test(x.name) || x.type === "application/pdf");
    if (f) openFile(f); else toast("Drop a PDF file.");
  });

  document.addEventListener("keydown", (e) => {
    const tag = (e.target.tagName || "").toLowerCase();
    if (tag === "input" && e.target.type !== "checkbox" && e.target.type !== "range") return;
    if (tag === "select" || tag === "textarea" || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;
    let handled = true;
    if (k === " " || k === "k") toggle();
    else if (k === "ArrowRight") e.shiftKey ? para(1) : step(1);
    else if (k === "ArrowLeft") e.shiftKey ? para(-1) : step(-1);
    else if (k === "ArrowDown") para(1);
    else if (k === "ArrowUp") para(-1);
    else if (k === "[") setSpeed(settings.speed - 0.1);
    else if (k === "]") setSpeed(settings.speed + 0.1);
    else if (k === "+" || k === "=") setZoom(settings.zoom + 0.1);
    else if (k === "-") setZoom(settings.zoom - 0.1);
    else if (k === "o" || k === "O") $("file-input").click();
    else if (k === "s" || k === "S") $("btn-settings").click();
    else if (k === "b" || k === "B") $("btn-sidebar").click();
    else if (k === "Escape") { $("settings").hidden = true; layoutPages(); }
    else handled = false;
    if (handled) e.preventDefault();
  });

  $("speed").value = settings.speed;
  setSpeed(settings.speed);
}

async function init() {
  applyTheme();
  initControls();
  renderSkipGroups();
  updatePlay();
  const statusPromise = pollStatus();
  let st = null;
  try { st = await (await fetch("/api/status")).json(); } catch (e) { /* ignore */ }
  if (st && st.groups) { groups = st.groups; renderSkipGroups(); }
  if (st && st.initial) await loadDoc(st.initial);
  await statusPromise;
}
init();
