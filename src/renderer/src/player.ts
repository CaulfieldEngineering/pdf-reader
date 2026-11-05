/**
 * Playback: walks the reading queue, asks the voice process for each
 * sentence a few sentences ahead, and plays the clips back to back.
 */

import type { ReadalongApi } from "../../shared/ipc";
import { type Utterance, utteranceText } from "../../shared/reading";

const LOOKAHEAD = 3;
const MAX_CLIPS = 160;

interface Clip {
  state: "pending" | "ready" | "error";
  url?: string;
  starts?: number[];
  duration?: number;
  speed?: number;
  error?: string;
}

export interface PlayerHooks {
  /** The current utterance changed (or was re-shown). */
  position(index: number, scroll: boolean): void;
  /** The word being spoken changed (-1 = none). */
  word(token: number): void;
  /** Playing / waiting state changed. */
  state(playing: boolean, waiting: boolean): void;
  message(text: string): void;
  /** The requested voice couldn't be loaded and the default was used. */
  voiceFallback(info: { requested: string; used: string; reason: string }): void;
  /** Gap after an utterance, in ms at 1x. */
  gapAfter(index: number): number;
}

export class Player {
  queue: Utterance[] = [];
  cur = 0;
  playing = false;
  waiting = false;
  ttsReady = false;
  voice = "af_heart";
  speed = 1;
  /** Bumped when pronunciations change, so cached clips are made again. */
  lexRev = 0;
  private audio = new Audio();
  private clips = new Map<string, Clip>();
  private waiters = new Map<string, ((c: Clip) => void)[]>();
  private inflight = 0;
  private token = 0;
  private curClip: Clip | null = null;
  private curIdx = -1;
  private raf = 0;
  private lastWord = -1;

  constructor(private api: ReadalongApi, private hooks: PlayerHooks) {
    this.audio.preload = "auto";
    this.audio.addEventListener("ended", () => this.ended());
  }

  private kSpeed(): number {
    return Math.round(Math.min(2, Math.max(0.5, this.speed)) * 20) / 20;
  }
  private key(u: Utterance): string {
    return `${this.voice}|${this.kSpeed()}|${this.lexRev}|${utteranceText(u)}`;
  }

  setQueue(queue: Utterance[], cur: number): void {
    this.queue = queue;
    this.cur = Math.min(Math.max(0, cur), Math.max(0, queue.length - 1));
  }

  // ---------------------------------------------------------------- clips

  private pump(): void {
    if (!this.ttsReady || this.inflight >= 1 || !this.queue.length) return;
    for (let i = this.cur; i < Math.min(this.queue.length, this.cur + 1 + LOOKAHEAD); i++) {
      const k = this.key(this.queue[i]);
      if (!this.clips.has(k)) { void this.fetch(this.queue[i], k); return; }
    }
  }

  private async fetch(u: Utterance, k: string): Promise<void> {
    const clip: Clip = { state: "pending" };
    this.clips.set(k, clip);
    this.inflight++;
    const speed = this.kSpeed();
    try {
      const r = await this.api.speak(u.tokens.map((t) => t.t), this.voice, speed);
      if (r.fallback) this.hooks.voiceFallback(r.fallback);
      const blob = new Blob([r.wav as BlobPart], { type: "audio/wav" });
      Object.assign(clip, { state: "ready", url: URL.createObjectURL(blob), starts: r.starts, duration: r.duration, speed });
    } catch (e: any) {
      clip.state = "error";
      clip.error = String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
    }
    this.inflight--;
    const ws = this.waiters.get(k) ?? [];
    this.waiters.delete(k);
    ws.forEach((f) => f(clip));
    this.evict();
    this.pump();
  }

  private wait(k: string): Promise<Clip> {
    const c = this.clips.get(k);
    if (c?.state === "ready") return Promise.resolve(c);
    if (c?.state === "error") this.clips.delete(k);
    return new Promise((res) => {
      if (!this.waiters.has(k)) this.waiters.set(k, []);
      this.waiters.get(k)!.push(res);
      this.pump();
    });
  }

  private evict(): void {
    if (this.clips.size <= MAX_CLIPS) return;
    const keep = new Set<string>();
    for (let i = Math.max(0, this.cur - 5); i < Math.min(this.queue.length, this.cur + LOOKAHEAD + 2); i++) keep.add(this.key(this.queue[i]));
    for (const [k, c] of this.clips) {
      if (this.clips.size <= MAX_CLIPS * 0.75) break;
      if (keep.has(k) || c.state === "pending" || c === this.curClip) continue;
      if (c.url) URL.revokeObjectURL(c.url);
      this.clips.delete(k);
    }
  }

  // ---------------------------------------------------------------- playback

  private setWaiting(w: boolean): void {
    this.waiting = w;
    this.hooks.state(this.playing, w);
  }

  async playAt(i: number, scroll = true): Promise<void> {
    if (!this.queue.length) return;
    this.cur = Math.min(Math.max(0, i), this.queue.length - 1);
    const my = ++this.token;
    this.audio.pause();
    this.curIdx = -1;
    this.lastWord = -1;
    this.hooks.position(this.cur, scroll);
    this.hooks.word(-1);
    if (!this.playing) return;
    if (!this.ttsReady) {
      this.setWaiting(true);
      this.hooks.message("The voice is still loading. Reading starts as soon as it's ready.");
      return;
    }
    this.setWaiting(true);
    const clip = await this.wait(this.key(this.queue[this.cur]));
    if (my !== this.token || !this.playing) return;
    this.setWaiting(false);
    if (clip.state === "error") {
      this.hooks.message("Speech failed: " + clip.error);
      this.playing = false;
      this.hooks.state(false, false);
      return;
    }
    this.curClip = clip;
    this.curIdx = this.cur;
    this.audio.src = clip.url!;
    this.audio.playbackRate = this.speed / (clip.speed ?? 1);
    this.audio.preservesPitch = true;
    try {
      await this.audio.play();
    } catch {
      if (my === this.token) { this.playing = false; this.hooks.state(false, false); }
      return;
    }
    this.loop();
    this.pump();
  }

  private ended(): void {
    if (!this.playing) return;
    const my = this.token;
    const gap = this.hooks.gapAfter(this.cur) / Math.max(0.5, this.speed);
    setTimeout(() => {
      if (my !== this.token || !this.playing) return;
      if (this.cur + 1 < this.queue.length) void this.playAt(this.cur + 1);
      else {
        this.playing = false;
        this.hooks.state(false, false);
        this.hooks.message("End of the document.");
      }
    }, gap);
  }

  private loop(): void {
    cancelAnimationFrame(this.raf);
    const tick = () => {
      if (!this.playing) return;
      this.drawWord();
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  private drawWord(): void {
    if (!this.curClip?.starts || this.curIdx !== this.cur) return;
    const t = this.audio.currentTime;
    const st = this.curClip.starts;
    let k = -1;
    for (let i = 0; i < st.length; i++) { if (st[i] <= t + 0.03) k = i; else break; }
    if (k !== this.lastWord) {
      this.lastWord = k;
      this.hooks.word(k);
    }
  }

  /** Fraction of the current clip played. */
  get clipProgress(): number {
    const d = this.curClip?.duration;
    return d && this.curIdx === this.cur ? Math.min(1, this.audio.currentTime / d) : 0;
  }

  play(): void {
    if (!this.queue.length) return;
    this.playing = true;
    this.hooks.state(true, this.waiting);
    if (this.curClip && this.curIdx === this.cur && !this.audio.ended && this.audio.currentTime > 0) {
      this.audio.play().then(() => this.loop()).catch(() => void this.playAt(this.cur));
    } else {
      void this.playAt(this.cur);
    }
  }

  pause(): void {
    this.playing = false;
    this.token++;
    this.audio.pause();
    this.setWaiting(false);
  }

  stop(): void {
    this.pause();
    this.curClip = null;
    this.curIdx = -1;
  }

  toggle(): void {
    this.playing ? this.pause() : this.play();
  }

  step(d: number): void {
    if (this.queue.length) void this.playAt(this.cur + d);
  }

  para(d: number): void {
    if (!this.queue.length) return;
    const b = this.queue[this.cur].b;
    if (d > 0) {
      let j = this.cur;
      while (j < this.queue.length && this.queue[j].b === b) j++;
      void this.playAt(Math.min(j, this.queue.length - 1));
      return;
    }
    let first = this.cur;
    while (first > 0 && this.queue[first - 1].b === b) first--;
    if (this.cur > first || first === 0) { void this.playAt(first); return; }
    let prev = first - 1;
    const pb = this.queue[prev].b;
    while (prev > 0 && this.queue[prev - 1].b === pb) prev--;
    void this.playAt(prev);
  }

  setSpeed(v: number): void {
    this.speed = v;
    // The sentence playing keeps going at the new rate; later ones are made
    // at the new speed.
    if (this.curClip) this.audio.playbackRate = v / (this.curClip.speed ?? 1);
    this.pump();
  }

  setVoice(v: string): void {
    this.voice = v;
    if (this.playing) void this.playAt(this.cur, false);
  }

  /** Keep playing the current clip if it is still in the queue at `i`. */
  keepCurrentAt(i: number): void {
    this.cur = i;
    this.curIdx = i;
  }

  setReady(ready: boolean): void {
    this.ttsReady = ready;
    if (ready && this.playing && this.curIdx !== this.cur) void this.playAt(this.cur, false);
    this.pump();
  }
}
