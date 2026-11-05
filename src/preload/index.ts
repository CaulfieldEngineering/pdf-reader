/** The bridge between the sandboxed page and the main process. */

import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { ReadalongApi } from "../shared/ipc";

const on = (channel: string) => (cb: (v: any) => void) => {
  ipcRenderer.on(channel, (_e, v) => cb(v));
};
const invoke = (channel: string) => (...args: unknown[]) => ipcRenderer.invoke(channel, ...args);

const api: ReadalongApi = {
  initial: () => ipcRenderer.invoke("app:initial"),
  openDialog: () => ipcRenderer.invoke("file:dialog"),
  openPath: (path) => ipcRenderer.invoke("file:open", path),
  pathForFile: (file) => webUtils.getPathForFile(file),
  onOpenFile: on("file:open"),
  onCommand: on("command"),
  showMenu: (x, y) => ipcRenderer.send("menu:popup", x, y),

  library: invoke("library:list") as ReadalongApi["library"],
  docRecord: invoke("library:doc") as ReadalongApi["docRecord"],
  openRecent: invoke("library:open") as ReadalongApi["openRecent"],
  locate: invoke("library:locate") as ReadalongApi["locate"],
  removeRecent: invoke("library:remove") as ReadalongApi["removeRecent"],
  pinRecent: invoke("library:pin") as ReadalongApi["pinRecent"],
  setPosition: (key, pos) => ipcRenderer.send("library:position", key, pos),
  addBookmark: invoke("bookmark:add") as ReadalongApi["addBookmark"],
  updateBookmark: invoke("bookmark:update") as ReadalongApi["updateBookmark"],
  removeBookmark: invoke("bookmark:remove") as ReadalongApi["removeBookmark"],
  exportLibrary: invoke("library:export") as ReadalongApi["exportLibrary"],
  importLibrary: invoke("library:import") as ReadalongApi["importLibrary"],

  lexicon: invoke("lexicon:get") as ReadalongApi["lexicon"],
  setLexicon: invoke("lexicon:set") as ReadalongApi["setLexicon"],
  exportLexicon: invoke("lexicon:export") as ReadalongApi["exportLexicon"],
  importLexicon: invoke("lexicon:import") as ReadalongApi["importLexicon"],

  minimize: () => ipcRenderer.send("win:minimize"),
  toggleMaximize: () => ipcRenderer.send("win:maximize"),
  close: () => ipcRenderer.send("win:close"),
  setAlwaysOnTop: (v) => ipcRenderer.send("win:top", v),
  toggleMini: () => ipcRenderer.send("win:mini"),
  onWindowState: on("window:state"),

  ttsStatus: () => ipcRenderer.invoke("tts:status"),
  onTtsStatus: on("tts:status"),
  voices: () => ipcRenderer.invoke("tts:voices"),
  checkVoices: () => ipcRenderer.invoke("tts:check-voices"),
  speak: (tokens, voice, speed) => ipcRenderer.invoke("tts:speak", tokens, voice, speed),
  setDtype: (d) => ipcRenderer.send("tts:dtype", d),
  retryTts: () => ipcRenderer.send("tts:retry"),

  shot: (name) => ipcRenderer.invoke("shot", name),
  shotLog: (msg) => ipcRenderer.send("shot:log", msg),
};

contextBridge.exposeInMainWorld("readalong", api);
