/** The home view: recent documents with progress and bookmarks. */

import type { Bookmark, ReadalongApi, RecentDoc } from "../../shared/ipc";

export interface HomeHandlers {
  open(doc: RecentDoc, bookmark?: Bookmark): void;
  locate(doc: RecentDoc): void;
  changed(): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function icon(id: string): SVGSVGElement {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const u = document.createElementNS("http://www.w3.org/2000/svg", "use");
  u.setAttribute("href", `#${id}`);
  s.append(u);
  return s;
}
function iconButton(id: string, title: string, onClick: (e: MouseEvent) => void, cls = ""): HTMLButtonElement {
  const b = el("button", cls);
  b.title = title;
  b.setAttribute("aria-label", title);
  b.append(icon(id));
  b.addEventListener("click", (e) => { e.stopPropagation(); onClick(e); });
  return b;
}

export function ago(t: number, now = Date.now()): string {
  if (!t) return "";
  const s = Math.max(0, (now - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 2) return "yesterday";
  if (s < 86400 * 14) return `${Math.floor(s / 86400)} days ago`;
  return new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function progressText(d: RecentDoc): string {
  const p = d.position;
  if (!p) return "Not started";
  return `${Math.round(p.progress * 100)}% · page ${p.page + 1}${p.pages ? ` of ${p.pages}` : ""}`;
}

export async function renderHome(api: ReadalongApi, h: HomeHandlers, expanded: Set<string>): Promise<void> {
  const list = document.getElementById("home-list")!;
  const cont = document.getElementById("home-continue")!;
  const docs = await api.library();
  list.innerHTML = "";
  cont.innerHTML = "";
  document.getElementById("home-empty")!.hidden = docs.length > 0;
  document.getElementById("home-count")!.textContent = docs.length ? `${docs.length} document${docs.length > 1 ? "s" : ""}` : "";

  // "Continue reading": the most recently opened file that still exists
  const last = [...docs].filter((d) => d.exists).sort((a, b) => b.lastOpened - a.lastOpened)[0];
  if (last) {
    const c = el("div", "continue");
    const meta = el("div", "meta");
    meta.append(el("div", "kicker", "Continue reading"), el("div", "name", last.name), el("div", "where", `${progressText(last)} · ${ago(last.lastOpened)}`));
    const go = el("button", "primary");
    go.append(icon("i-play"), document.createTextNode(last.position ? "Continue" : "Start"));
    go.addEventListener("click", () => h.open(last));
    c.append(icon("i-file"), meta, go);
    cont.append(c);
  }

  for (const d of docs) {
    const card = el("div", "doc");
    const row = el("div", "doc-row");
    const info = el("div", "info");
    info.append(el("div", "name", d.name));
    const folder = el("div", "folder");
    if (d.exists) folder.textContent = `${d.folder} · ${ago(d.lastOpened)}`;
    else {
      folder.append(el("span", "missing", "File not found"), document.createTextNode(` · ${d.path || "unknown location"}`));
    }
    info.append(folder);
    const prog = el("div", "prog");
    prog.append(document.createTextNode(progressText(d)));
    const bar = el("div", "bar");
    const fill = el("span");
    fill.style.width = `${Math.round((d.position?.progress ?? 0) * 100)}%`;
    bar.append(fill);
    prog.append(bar);
    const actions = el("div", "row-actions");
    if (d.bookmarks.length) actions.append(el("span", "chip", `${d.bookmarks.length} bookmark${d.bookmarks.length > 1 ? "s" : ""}`));
    if (!d.exists) {
      const loc = el("button", "ghost sm", "Locate…");
      loc.addEventListener("click", (e) => { e.stopPropagation(); h.locate(d); });
      actions.append(loc);
    }
    actions.append(
      iconButton(d.pinned ? "i-star-on" : "i-star", d.pinned ? "Unpin" : "Pin to the top", async () => { await api.pinRecent(d.key, !d.pinned); h.changed(); }, d.pinned ? "pinned" : ""),
      iconButton("i-chevron", expanded.has(d.key) ? "Hide bookmarks" : "Show bookmarks", () => {
        if (expanded.has(d.key)) expanded.delete(d.key); else expanded.add(d.key);
        h.changed();
      }),
      iconButton("i-x", "Remove from the list (bookmarks are deleted too)", async () => {
        if (d.bookmarks.length && !confirm(`Remove ${d.name} and its ${d.bookmarks.length} bookmark(s) from the list?`)) return;
        await api.removeRecent(d.key);
        h.changed();
      }),
    );
    row.append(icon("i-file"), info, prog, actions);
    row.addEventListener("click", () => (d.exists ? h.open(d) : h.locate(d)));
    card.append(row);
    if (expanded.has(d.key)) {
      const bms = el("div", "doc-bms");
      if (!d.bookmarks.length) bms.append(el("div", "empty-note", "No bookmarks yet. Press Ctrl+B while reading to add one."));
      for (const b of d.bookmarks) {
        const btn = el("button");
        btn.append(document.createTextNode(b.label));
        if (!/\(p\. \d+\)$/.test(b.label)) btn.append(el("span", "pg", `p. ${b.page + 1}`));
        btn.title = b.snippet + (b.note ? `\n\n${b.note}` : "");
        btn.addEventListener("click", () => (d.exists ? h.open(d, b) : h.locate(d)));
        bms.append(btn);
      }
      card.append(bms);
    }
    list.append(card);
  }
}
