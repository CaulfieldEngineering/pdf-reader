/** The Pronunciations card in Settings. */

import { type Lexicon, type PronEntry, STARTER_PACK } from "../../shared/lexicon";

export interface PronHandlers {
  save(lex: Lexicon): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

export class PronEditor {
  lex: Lexicon = { version: 1, entries: [] };
  private editing: string | null = null;
  private query = "";

  constructor(private box: HTMLElement, private h: PronHandlers) {}

  set(lex: Lexicon): void {
    this.lex = lex;
    this.render();
  }

  search(q: string): void {
    this.query = q.trim().toLowerCase();
    this.render();
  }

  add(): void {
    const e: PronEntry = { id: `user-${Date.now().toString(36)}`, written: "", spoken: "", enabled: true, wholeWord: true, caseSensitive: true, afterNumber: false };
    this.lex.entries.unshift(e);
    this.editing = e.id;
    this.query = "";
    this.render();
  }

  restore(): number {
    let n = 0;
    for (const e of STARTER_PACK) {
      if (!this.lex.entries.some((x) => x.id === e.id)) { this.lex.entries.push({ ...e }); n++; }
    }
    if (n) this.commit();
    return n;
  }

  private commit(): void {
    this.lex.entries = this.lex.entries.filter((e) => e.written.trim() || e.id === this.editing);
    this.h.save({ version: 1, entries: this.lex.entries.filter((e) => e.written.trim()) });
    this.render();
  }

  render(): void {
    const box = this.box;
    box.innerHTML = "";
    const q = this.query;
    const shown = this.lex.entries.filter((e) => !q || e.written.toLowerCase().includes(q) || e.spoken.toLowerCase().includes(q));
    if (!shown.length) {
      box.append(el("div", "empty-note", q ? "No matches." : "No pronunciations. Add one, or restore the engineering units."));
      return;
    }
    for (const e of shown) {
      if (this.editing === e.id) { box.append(this.form(e)); continue; }
      const row = el("div", "pron" + (e.enabled ? "" : " off"));
      const cb = el("input");
      cb.type = "checkbox";
      cb.checked = e.enabled;
      cb.title = e.enabled ? "On" : "Off";
      cb.addEventListener("change", () => { e.enabled = cb.checked; this.commit(); });
      const map = el("div", "map");
      map.append(el("span", "w", e.written), el("span", "arrow", "→"), document.createTextNode(e.spoken));
      const flags = [e.afterNumber ? "after a number" : "", !e.caseSensitive ? "any case" : "", !e.wholeWord ? "inside words" : "", e.regex ? "regex" : "", e.pack ? "built-in" : ""].filter(Boolean).join(" · ");
      if (flags) map.append(el("span", "flagset", flags));
      map.title = `${e.written} → ${e.spoken}${e.singular ? ` (after 1: ${e.singular})` : ""}`;
      const actions = el("div", "row-actions");
      const edit = el("button");
      edit.title = "Edit";
      edit.innerHTML = `<svg><use href="#i-edit"/></svg>`;
      edit.addEventListener("click", () => { this.editing = e.id; this.render(); });
      const del = el("button");
      del.title = "Delete";
      del.innerHTML = `<svg><use href="#i-trash"/></svg>`;
      del.addEventListener("click", () => { this.lex.entries = this.lex.entries.filter((x) => x !== e); this.commit(); });
      actions.append(edit, del);
      row.append(cb, map, actions);
      box.append(row);
    }
  }

  private form(e: PronEntry): HTMLElement {
    const f = el("div", "pron-form");
    const field = (ph: string, v: string) => { const i = el("input"); i.placeholder = ph; i.value = v; i.spellcheck = false; return i; };
    const written = field("Written (e.g. kW)", e.written);
    const spoken = field("Spoken (e.g. kilowatts)", e.spoken);
    const singular = field("After 1 (e.g. kilowatt), optional", e.singular ?? "");
    const two = el("div", "two");
    two.append(written, spoken);
    const opts = el("div", "opts");
    const opt = (label: string, v: boolean, title: string) => {
      const l = el("label");
      const c = el("input");
      c.type = "checkbox";
      c.checked = v;
      l.title = title;
      l.append(c, document.createTextNode(label));
      opts.append(l);
      return c;
    };
    const whole = opt("Whole word", e.wholeWord, "Match only the whole word, not inside longer words");
    const cs = opt("Match case", e.caseSensitive, "mA is not MA");
    const after = opt("Only after a number", e.afterNumber, '"5 V" becomes "5 volts"; a lone V is left alone');
    const rx = opt("Regex", !!e.regex, "Written form is a regular expression; Spoken can use $1");
    const btns = el("div", "btns");
    const cancel = el("button", "ghost sm", "Cancel");
    const ok = el("button", "ghost sm", "Save");
    cancel.addEventListener("click", () => { this.editing = null; this.commit(); });
    ok.addEventListener("click", () => {
      if (!written.value.trim() || !spoken.value.trim()) { written.focus(); return; }
      if (rx.checked) { try { new RegExp(written.value); } catch { written.setCustomValidity("Not a valid regular expression"); written.reportValidity(); return; } }
      Object.assign(e, {
        written: written.value.trim(), spoken: spoken.value.trim(), wholeWord: whole.checked, caseSensitive: cs.checked,
        afterNumber: after.checked, regex: rx.checked || undefined, singular: singular.value.trim() || undefined,
      });
      this.editing = null;
      this.commit();
    });
    f.addEventListener("keydown", (ev) => {
      ev.stopPropagation();
      if (ev.key === "Enter") { ev.preventDefault(); ok.click(); }
      if (ev.key === "Escape") cancel.click();
    });
    btns.append(cancel, ok);
    f.append(two, singular, opts, btns);
    requestAnimationFrame(() => written.focus());
    return f;
  }
}
