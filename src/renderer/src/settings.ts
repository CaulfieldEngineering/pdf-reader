/** User preferences, kept in localStorage (the app's own profile). */

import type { SkipSettings } from "../../shared/reading";

export interface Settings {
  voice: string;
  speed: number;
  skip: SkipSettings;
  showSkipped: boolean;
  wordHl: boolean;
  follow: boolean;
  darkPages: boolean;
  theme: "system" | "light" | "dark";
  zoom: number;
  sidebar: boolean;
}

const KEY = "readalong.settings";
const POS = "readalong.pos.";
const DEFAULTS: Settings = {
  voice: "af_heart",
  speed: 1,
  skip: {},
  showSkipped: true,
  wordHl: true,
  follow: true,
  darkPages: true,
  theme: "system",
  zoom: 1,
  sidebar: true,
};

export function loadSettings(): Settings {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || "{}");
    return { ...DEFAULTS, ...s, skip: { ...(s.skip || {}) } };
  } catch {
    return { ...DEFAULTS, skip: {} };
  }
}

export function saveSettings(s: Settings): void {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* storage full or blocked */ }
}

/** Reading position per document (keyed by a content fingerprint). */
export function savePosition(docKey: string, b: number, k: number): void {
  try { localStorage.setItem(POS + docKey, JSON.stringify({ b, k })); } catch { /* ignore */ }
}
export function loadPosition(docKey: string): { b: number; k: number } | null {
  try {
    const p = JSON.parse(localStorage.getItem(POS + docKey) || "null");
    return p && typeof p.b === "number" ? p : null;
  } catch {
    return null;
  }
}
