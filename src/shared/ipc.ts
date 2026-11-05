/** Types shared by the main process, the preload bridge and the renderer. */

import type { Bookmark, DocRecord, Position } from "./library";
import type { Lexicon } from "./lexicon";

export type { Bookmark, DocRecord, Position } from "./library";

export interface FileData {
  path: string;
  name: string;
  data: Uint8Array;
  /** Content fingerprint (library key). */
  key: string;
}

/** A library record as shown on the home view. */
export interface RecentDoc extends DocRecord {
  exists: boolean;
  folder: string;
}

export interface RecentFile {
  path: string;
  name: string;
  openedAt: number;
}

export interface WindowState {
  maximized: boolean;
  alwaysOnTop: boolean;
  focused: boolean;
  mini: boolean;
}

export type TtsState = "idle" | "downloading" | "loading" | "ready" | "error";

export interface TtsStatus {
  state: TtsState;
  progress: number;
  message: string;
  dtype: string;
  rtf: number;
  downloadedMB?: number;
  totalMB?: number;
}

export interface VoiceInfo {
  id: string;
  name: string;
  accent: string;
  gender: string;
  grade: string;
}

export interface SpeakReply {
  wav: Uint8Array;
  starts: number[];
  duration: number;
  rtf: number;
  /** The requested voice couldn't be loaded; the default was used instead. */
  fallback?: { requested: string; used: string; reason: string };
}

export type Command =
  | "toggle-play" | "next" | "prev" | "open" | "settings" | "sidebar" | "mini" | "zoom-in" | "zoom-out" | "home" | "bookmark";

export interface InitialInfo {
  version: string;
  mica: boolean;
  window: WindowState;
  file: FileData | null;
  screenshot: boolean;
}

export interface ReadalongApi {
  initial(): Promise<InitialInfo>;
  openDialog(): Promise<FileData | null>;
  openPath(path: string): Promise<FileData | null>;
  pathForFile(file: File): string;
  /** Recent documents, pinned first, with whether each file still exists. */
  library(): Promise<RecentDoc[]>;
  docRecord(key: string): Promise<DocRecord | null>;
  openRecent(key: string): Promise<FileData | null>;
  locate(key: string): Promise<{ verdict: "same" | "different"; file: FileData } | null>;
  removeRecent(key: string): Promise<void>;
  pinRecent(key: string, pinned: boolean): Promise<void>;
  setPosition(key: string, pos: Position): void;
  addBookmark(key: string, at: { b: number; k: number; page: number; snippet: string }, label?: string, note?: string): Promise<Bookmark | null>;
  updateBookmark(key: string, id: string, patch: { label?: string; note?: string }): Promise<boolean>;
  removeBookmark(key: string, id: string): Promise<boolean>;
  exportLibrary(): Promise<string | null>;
  importLibrary(): Promise<number | null>;

  lexicon(): Promise<Lexicon>;
  setLexicon(lex: Lexicon): Promise<void>;
  exportLexicon(): Promise<string | null>;
  importLexicon(): Promise<Lexicon | null>;
  onOpenFile(cb: (f: FileData) => void): void;
  onCommand(cb: (c: Command) => void): void;
  showMenu(x: number, y: number): void;

  minimize(): void;
  toggleMaximize(): void;
  close(): void;
  setAlwaysOnTop(on: boolean): void;
  toggleMini(): void;
  onWindowState(cb: (s: WindowState) => void): void;

  ttsStatus(): Promise<TtsStatus>;
  onTtsStatus(cb: (s: TtsStatus) => void): void;
  voices(): Promise<VoiceInfo[]>;
  speak(tokens: string[], voice: string, speed: number): Promise<SpeakReply>;
  setDtype(dtype: string): void;
  retryTts(): void;

  /** Every offered voice and whether its file is in place. */
  checkVoices(): Promise<{ id: string; file: string; present: boolean }[]>;

  /** Screenshot self-test: capture the staged view (test mode only). */
  shot(name: string): Promise<void>;
  shotLog(msg: string): void;
}
