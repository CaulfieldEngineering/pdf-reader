/** Recent files, positions and bookmarks: storage and keys. */

import { describe, expect, it } from "vitest";
import { fingerprint } from "../src/main/store";
import {
  addBookmark, defaultLabel, emptyLibrary, findDoc, mergeLibrary, parseLibrary, pinDoc, recent, relocate,
  removeBookmark, removeDoc, setPosition, touch, updateBookmark,
} from "../src/shared/library";

const file = (key: string, path: string, size = 1000) => ({ key, path, name: path.split(/[\\/]/).pop()!, size });

describe("document keys", () => {
  it("fingerprints content, not the name", () => {
    const a = new Uint8Array([1, 2, 3, 4]);
    expect(fingerprint(a)).toBe(fingerprint(new Uint8Array([1, 2, 3, 4])));
    expect(fingerprint(a)).not.toBe(fingerprint(new Uint8Array([1, 2, 3, 5])));
    expect(fingerprint(a)).toMatch(/^[0-9a-f]{16}4$/);
  });
  it("matches the v0.1.0 in-page fingerprint, so saved positions carry over", async () => {
    const data = new TextEncoder().encode("%PDF-1.7 sample");
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", data));
    const old = [...digest].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("") + data.length.toString(36);
    expect(fingerprint(data)).toBe(old);
  });
});

describe("recent list", () => {
  it("finds a moved or renamed file by its fingerprint and keeps its bookmarks", () => {
    const lib = emptyLibrary();
    touch(lib, file("k1", "C:\\docs\\a.pdf"), 1);
    addBookmark(lib, "k1", { b: 3, k: 0, page: 1, snippet: "Hello world" }, "", "", 2);
    touch(lib, file("k1", "D:\\moved\\renamed.pdf"), 3);
    expect(lib.docs).toHaveLength(1);
    expect(lib.docs[0].path).toBe("D:\\moved\\renamed.pdf");
    expect(lib.docs[0].name).toBe("renamed.pdf");
    expect(lib.docs[0].bookmarks).toHaveLength(1);
  });
  it("re-keys a file edited in place (same path, new content)", () => {
    const lib = emptyLibrary();
    touch(lib, file("k1", "C:\\docs\\a.pdf"), 1);
    addBookmark(lib, "k1", { b: 1, k: 0, page: 0, snippet: "x" });
    touch(lib, file("k2", "c:/docs/A.pdf"), 2);
    expect(lib.docs).toHaveLength(1);
    expect(lib.docs[0].key).toBe("k2");
    expect(lib.docs[0].bookmarks).toHaveLength(1);
  });
  it("sorts pinned first, then by last opened", () => {
    const lib = emptyLibrary();
    touch(lib, file("a", "a.pdf"), 1);
    touch(lib, file("b", "b.pdf"), 2);
    touch(lib, file("c", "c.pdf"), 3);
    pinDoc(lib, "a", true);
    expect(recent(lib).map((d) => d.key)).toEqual(["a", "c", "b"]);
  });
  it("stores the reading position and can remove a document", () => {
    const lib = emptyLibrary();
    touch(lib, file("a", "a.pdf"));
    setPosition(lib, "a", { b: 10, k: 2, page: 4, pages: 9, progress: 0.4 });
    expect(findDoc(lib, "a")?.position?.page).toBe(4);
    removeDoc(lib, "a");
    expect(lib.docs).toHaveLength(0);
  });
  it("relocates a missing file, merging a record the new location already had", () => {
    const lib = emptyLibrary();
    touch(lib, file("old", "gone.pdf"), 1);
    addBookmark(lib, "old", { b: 1, k: 0, page: 0, snippet: "one" });
    touch(lib, file("new", "here.pdf"), 2);
    addBookmark(lib, "new", { b: 2, k: 0, page: 0, snippet: "two" });
    expect(relocate(lib, "old", file("new", "here.pdf"))).toBe("different");
    expect(lib.docs).toHaveLength(1);
    expect(lib.docs[0].bookmarks.map((m) => m.b)).toEqual([1, 2]);
    expect(relocate(lib, "nope", file("x", "x.pdf"))).toBe("missing");
  });
});

describe("bookmarks", () => {
  it("defaults the label to the first words and the page", () => {
    expect(defaultLabel("The power stage converts the input voltage to a regulated output.", 2)).toBe("The power stage converts the input… (p. 3)");
    expect(defaultLabel("Short one.", 0)).toBe("Short one. (p. 1)");
  });
  it("adds, renames, annotates and deletes; one bookmark per sentence", () => {
    const lib = emptyLibrary();
    touch(lib, file("a", "a.pdf"));
    const b = addBookmark(lib, "a", { b: 5, k: 1, page: 2, snippet: "Some sentence here." })!;
    expect(addBookmark(lib, "a", { b: 5, k: 1, page: 2, snippet: "again" })!.id).toBe(b.id);
    expect(updateBookmark(lib, "a", b.id, { label: "Key result", note: "check later" })).toBe(true);
    expect(findDoc(lib, "a")!.bookmarks[0]).toMatchObject({ label: "Key result", note: "check later" });
    expect(updateBookmark(lib, "a", b.id, { label: "  " })).toBe(true);
    expect(findDoc(lib, "a")!.bookmarks[0].label).toMatch(/\(p\. 3\)$/);
    expect(removeBookmark(lib, "a", b.id)).toBe(true);
    expect(findDoc(lib, "a")!.bookmarks).toHaveLength(0);
  });
  it("survives export and import, merging without duplicates", () => {
    const lib = emptyLibrary();
    touch(lib, file("a", "a.pdf"));
    addBookmark(lib, "a", { b: 1, k: 0, page: 0, snippet: "one" });
    const copy = parseLibrary(JSON.parse(JSON.stringify(lib)));
    addBookmark(copy, "a", { b: 2, k: 0, page: 1, snippet: "two" });
    expect(mergeLibrary(lib, copy)).toBe(1);
    expect(findDoc(lib, "a")!.bookmarks).toHaveLength(2);
    expect(() => parseLibrary({ nope: 1 })).toThrow();
  });
});
