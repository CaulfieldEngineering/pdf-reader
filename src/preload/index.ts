/** The bridge between the sandboxed page and the main process. */

import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { ReadalongApi } from "../shared/ipc";

const on = (channel: string) => (cb: (v: any) => void) => {
  ipcRenderer.on(channel, (_e, v) => cb(v));
};

const api: ReadalongApi = {
  initial: () => ipcRenderer.invoke("app:initial"),
  openDialog: () => ipcRenderer.invoke("file:dialog"),
  openPath: (path) => ipcRenderer.invoke("file:open", path),
  pathForFile: (file) => webUtils.getPathForFile(file),
  recent: () => ipcRenderer.invoke("file:recent"),
  onOpenFile: on("file:open"),
  onCommand: on("command"),
  showMenu: (x, y) => ipcRenderer.send("menu:popup", x, y),

  minimize: () => ipcRenderer.send("win:minimize"),
  toggleMaximize: () => ipcRenderer.send("win:maximize"),
  close: () => ipcRenderer.send("win:close"),
  setAlwaysOnTop: (v) => ipcRenderer.send("win:top", v),
  toggleMini: () => ipcRenderer.send("win:mini"),
  onWindowState: on("window:state"),

  ttsStatus: () => ipcRenderer.invoke("tts:status"),
  onTtsStatus: on("tts:status"),
  voices: () => ipcRenderer.invoke("tts:voices"),
  speak: (tokens, voice, speed) => ipcRenderer.invoke("tts:speak", tokens, voice, speed),
  setDtype: (d) => ipcRenderer.send("tts:dtype", d),
  retryTts: () => ipcRenderer.send("tts:retry"),

  shotReady: (name) => ipcRenderer.send("shot:ready", name),
};

contextBridge.exposeInMainWorld("readalong", api);
