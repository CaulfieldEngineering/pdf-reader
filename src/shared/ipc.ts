/** Types shared by the main process, the preload bridge and the renderer. */

export interface FileData {
  path: string;
  name: string;
  data: Uint8Array;
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
}

export type Command =
  | "toggle-play" | "next" | "prev" | "open" | "settings" | "sidebar" | "mini" | "zoom-in" | "zoom-out";

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
  recent(): Promise<RecentFile[]>;
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

  /** Screenshot self-test: tell the main process the page is ready. */
  shotReady(name: string): void;
}
