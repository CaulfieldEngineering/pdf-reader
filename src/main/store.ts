/** JSON files in the user data folder: the library (recent files, bookmarks) and pronunciations. */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { defaultLexicon, type Lexicon, parseLexicon, STARTER_PACK } from "../shared/lexicon";
import { emptyLibrary, FINGERPRINT_BYTES, fingerprintFrom, type Library, parseLibrary } from "../shared/library";

export function fingerprint(data: Uint8Array): string {
  const head = data.subarray(0, Math.min(data.length, FINGERPRINT_BYTES));
  return fingerprintFrom(createHash("sha1").update(head).digest("hex"), data.length);
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Write through a temporary file so a crash never leaves half a file. */
export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, path);
}

/** A JSON-backed value with debounced saving. */
export class JsonStore<T> {
  value: T;
  private timer: NodeJS.Timeout | null = null;

  constructor(private path: string, load: (json: unknown) => T, fallback: () => T, private enabled = true) {
    let v: T;
    try { v = load(readJson(path)); } catch { v = fallback(); }
    this.value = v;
  }

  save(now = false): void {
    if (!this.enabled) return;
    if (this.timer) clearTimeout(this.timer);
    const write = () => {
      this.timer = null;
      try { writeJson(this.path, this.value); } catch { /* read-only profile */ }
    };
    if (now) write();
    else this.timer = setTimeout(write, 300);
  }

  flush(): void {
    if (this.timer) this.save(true);
  }
}

export function openLibrary(path: string, enabled = true): JsonStore<Library> {
  return new JsonStore(path, parseLibrary, emptyLibrary, enabled);
}

export function openLexicon(path: string, enabled = true): JsonStore<Lexicon> {
  const store = new JsonStore(path, parseLexicon, defaultLexicon, enabled);
  return store;
}

/** Add back starter-pack entries that were deleted (user entries and edits are kept). */
export function restoreStarterPack(lex: Lexicon): number {
  let added = 0;
  for (const e of STARTER_PACK) {
    if (!lex.entries.some((x) => x.id === e.id)) { lex.entries.push({ ...e }); added++; }
  }
  return added;
}
