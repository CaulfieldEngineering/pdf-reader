/** The Bookmarks tab in the sidebar. */

import type { Bookmark } from "../../shared/ipc";

export interface BookmarkHandlers {
  jump(b: Bookmark): void;
  edit(b: Bookmark): void;
  /** Save edits; an empty patch just closes the editor. */
  save(b: Bookmark, patch: { label?: string; note?: string }): void;
  remove(b: Bookmark): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function iconButton(id: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = el("button");
  b.title = title;
  b.setAttribute("aria-label", title);
  b.innerHTML = `<svg><use href="#${id}"/></svg>`;
  b.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
  return b;
}

export function renderBookmarks(box: HTMLElement, list: Bookmark[], h: BookmarkHandlers, editing: string | null): void {
  box.innerHTML = "";
  if (!list.length) {
    box.append(el("div", "empty-note", "No bookmarks in this document. Press Ctrl+B, or the bookmark button, to mark the sentence being read."));
    return;
  }
  for (const b of list) {
    const item = el("div", "bm");
    item.dataset.id = b.id;
    if (editing === b.id) {
      const form = el("div", "bm-edit");
      const label = el("input");
      label.value = b.label;
      label.placeholder = "Name";
      const note = el("textarea");
      note.value = b.note;
      note.placeholder = "Note (optional)";
      const btns = el("div", "btns");
      const cancel = el("button", "ghost sm", "Cancel");
      const ok = el("button", "primary", "Save");
      ok.style.height = "28px";
      cancel.addEventListener("click", () => h.save(b, {}));
      ok.addEventListener("click", () => h.save(b, { label: label.value, note: note.value }));
      form.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter" && (e.ctrlKey || e.target === label)) { e.preventDefault(); ok.click(); }
        if (e.key === "Escape") cancel.click();
      });
      btns.append(cancel, ok);
      form.append(label, note, btns);
      item.append(form);
      box.append(item);
      requestAnimationFrame(() => { label.focus(); label.select(); });
      continue;
    }
    const label = el("div", "bm-label", b.label);
    const meta = el("div", "bm-meta", `Page ${b.page + 1}${b.created ? ` · added ${new Date(b.created).toLocaleDateString(undefined, { day: "numeric", month: "short" })}` : ""}`);
    const snip = el("div", "bm-snippet", b.snippet);
    item.append(label, meta, snip);
    if (b.note) item.append(el("div", "bm-note", b.note));
    const actions = el("div", "bm-actions");
    actions.append(
      iconButton("i-edit", "Rename or add a note", () => h.edit(b)),
      iconButton("i-trash", "Delete bookmark", () => h.remove(b)),
    );
    item.append(actions);
    for (const t of [label, snip]) t.addEventListener("click", () => h.jump(b));
    item.title = "Click to read from here";
    box.append(item);
  }
}
