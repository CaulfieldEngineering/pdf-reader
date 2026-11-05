/**
 * The library: recent documents, reading positions and bookmarks.
 *
 * Kept in the app's user data (never next to the PDF). A document is keyed by
 * a content fingerprint (hash of its first 4 MB plus its size), with its last
 * known path alongside, so a renamed or moved file keeps its bookmarks once
 * it is opened from (or relocated to) the new place.
 */

export interface Position {
  /** Block id and sentence index in the reading queue. */
  b: number;
  k: number;
  page: number;
  pages: number;
  /** 0..1 through the document's reading queue. */
  progress: number;
}

export interface Bookmark {
  id: string;
  b: number;
  k: number;
  page: number;
  label: string;
  note: string;
  snippet: string;
  created: number;
}

export interface DocRecord {
  key: string;
  path: string;
  name: string;
  size: number;
  lastOpened: number;
  pinned: boolean;
  position?: Position;
  bookmarks: Bookmark[];
}

export interface Library {
  version: 1;
  docs: DocRecord[];
}

export const MAX_RECENT = 50;
export const FINGERPRINT_BYTES = 4 << 20;

export function emptyLibrary(): Library {
  return { version: 1, docs: [] };
}

/** Fingerprint from the SHA-1 hex of the first 4 MB and the file size. */
export function fingerprintFrom(sha1Hex: string, size: number): string {
  return sha1Hex.slice(0, 16) + size.toString(36);
}

const samePath = (a: string, b: string) => a.replace(/\//g, "\\").toLowerCase() === b.replace(/\//g, "\\").toLowerCase();

export function findDoc(lib: Library, key: string): DocRecord | undefined {
  return lib.docs.find((d) => d.key === key);
}

/**
 * Record that a file was opened. Matching is by fingerprint first (so a
 * moved or renamed file finds its record and the path is updated), then by
 * path (the same file edited: the record is re-keyed and keeps its bookmarks).
 */
export function touch(lib: Library, file: { key: string; path: string; name: string; size: number }, now = Date.now()): DocRecord {
  let rec = findDoc(lib, file.key);
  if (!rec && file.path) {
    rec = lib.docs.find((d) => d.path && samePath(d.path, file.path));
    if (rec) rec.key = file.key;
  }
  if (!rec) {
    rec = { key: file.key, path: file.path, name: file.name, size: file.size, lastOpened: now, pinned: false, bookmarks: [] };
    lib.docs.push(rec);
  }
  if (file.path) rec.path = file.path;
  rec.name = file.name;
  rec.size = file.size;
  rec.lastOpened = now;
  // Drop the oldest unpinned records without bookmarks beyond the limit
  const sorted = recent(lib);
  for (const d of sorted.slice(MAX_RECENT)) {
    if (!d.pinned && !d.bookmarks.length) lib.docs.splice(lib.docs.indexOf(d), 1);
  }
  return rec;
}

/** Pinned first, then most recently opened. */
export function recent(lib: Library): DocRecord[] {
  return [...lib.docs].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.lastOpened - a.lastOpened);
}

export function setPosition(lib: Library, key: string, pos: Position): void {
  const rec = findDoc(lib, key);
  if (rec) rec.position = pos;
}

export function defaultLabel(snippet: string, page: number, words = 6): string {
  const w = snippet.split(/\s+/).filter(Boolean);
  const head = w.slice(0, words).join(" ").replace(/[,;:]$/, "");
  return `${head}${w.length > words ? "…" : ""} (p. ${page + 1})`;
}

export function addBookmark(lib: Library, key: string, at: { b: number; k: number; page: number; snippet: string }, label = "", note = "", now = Date.now()): Bookmark | null {
  const rec = findDoc(lib, key);
  if (!rec) return null;
  const existing = rec.bookmarks.find((m) => m.b === at.b && m.k === at.k);
  if (existing) return existing;
  const snippet = at.snippet.replace(/\s+/g, " ").trim().slice(0, 200);
  const bm: Bookmark = {
    id: `bm-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    b: at.b, k: at.k, page: at.page,
    label: label.trim() || defaultLabel(snippet, at.page),
    note: note.trim(),
    snippet,
    created: now,
  };
  rec.bookmarks.push(bm);
  rec.bookmarks.sort((x, y) => x.b - y.b || x.k - y.k);
  return bm;
}

export function updateBookmark(lib: Library, key: string, id: string, patch: { label?: string; note?: string }): boolean {
  const bm = findDoc(lib, key)?.bookmarks.find((m) => m.id === id);
  if (!bm) return false;
  if (patch.label !== undefined) bm.label = patch.label.trim() || defaultLabel(bm.snippet, bm.page);
  if (patch.note !== undefined) bm.note = patch.note.trim();
  return true;
}

export function removeBookmark(lib: Library, key: string, id: string): boolean {
  const rec = findDoc(lib, key);
  if (!rec) return false;
  const n = rec.bookmarks.length;
  rec.bookmarks = rec.bookmarks.filter((m) => m.id !== id);
  return rec.bookmarks.length < n;
}

export function removeDoc(lib: Library, key: string): void {
  lib.docs = lib.docs.filter((d) => d.key !== key);
}

export function pinDoc(lib: Library, key: string, pinned: boolean): void {
  const rec = findDoc(lib, key);
  if (rec) rec.pinned = pinned;
}

/**
 * Point a record at a new path after the user located a moved file. Returns
 * "same" when the content fingerprint matches, "different" when it doesn't
 * (the record still moves, keeping its bookmarks, but they may not line up).
 */
export function relocate(lib: Library, key: string, file: { key: string; path: string; name: string; size: number }): "same" | "different" | "missing" {
  const rec = findDoc(lib, key);
  if (!rec) return "missing";
  const verdict = file.key === key ? "same" : "different";
  // If the located file already has its own record, merge into this one
  const other = findDoc(lib, file.key);
  if (other && other !== rec) {
    rec.bookmarks.push(...other.bookmarks.filter((m) => !rec.bookmarks.some((x) => x.b === m.b && x.k === m.k)));
    rec.position ??= other.position;
    rec.pinned ||= other.pinned;
    removeDoc(lib, other.key);
  }
  Object.assign(rec, { key: file.key, path: file.path, name: file.name, size: file.size });
  return verdict;
}

/** Validate a library read from disk or imported. Unknown fields are dropped. */
export function parseLibrary(json: unknown): Library {
  const docs = (json as { docs?: unknown })?.docs;
  if (!Array.isArray(docs)) throw new Error("Expected a Readalong library or bookmarks file");
  const lib = emptyLibrary();
  for (const d of docs as Partial<DocRecord>[]) {
    if (typeof d?.key !== "string" || !d.key) continue;
    lib.docs.push({
      key: d.key,
      path: typeof d.path === "string" ? d.path : "",
      name: typeof d.name === "string" ? d.name : "document.pdf",
      size: typeof d.size === "number" ? d.size : 0,
      lastOpened: typeof d.lastOpened === "number" ? d.lastOpened : 0,
      pinned: !!d.pinned,
      ...(d.position && typeof d.position.b === "number" ? { position: d.position } : {}),
      bookmarks: Array.isArray(d.bookmarks)
        ? d.bookmarks.filter((m) => m && typeof m.b === "number" && typeof m.k === "number").map((m) => ({
            id: String(m.id ?? `bm-${Math.random().toString(36).slice(2)}`),
            b: m.b, k: m.k, page: Number(m.page) || 0,
            label: String(m.label ?? ""), note: String(m.note ?? ""), snippet: String(m.snippet ?? ""),
            created: Number(m.created) || 0,
          }))
        : [],
    });
  }
  return lib;
}

/** Merge imported records (bookmarks are added, not replaced). */
export function mergeLibrary(into: Library, from: Library): number {
  let added = 0;
  for (const d of from.docs) {
    const rec = findDoc(into, d.key);
    if (!rec) { into.docs.push(d); added += d.bookmarks.length; continue; }
    for (const m of d.bookmarks) {
      if (!rec.bookmarks.some((x) => x.b === m.b && x.k === m.k)) { rec.bookmarks.push(m); added++; }
    }
    rec.bookmarks.sort((x, y) => x.b - y.b || x.k - y.k);
  }
  return added;
}
