/** Pronunciations, phoneme-to-word mapping and the speech front end. */

import { describe, expect, it } from "vitest";
import { normalizeToken, phonemizeTokens } from "../src/main/tts/kokoro-text";
import { cleanToken } from "../src/shared/analysis/text";
import { applyLexicon, defaultLexicon, orderedEntries, parseLexicon, type PronEntry, STARTER_PACK } from "../src/shared/lexicon";
import { alignPhonemes } from "../src/shared/tts-align";

const speak = (text: string, entries: PronEntry[] = STARTER_PACK) => applyLexicon(text.split(" "), orderedEntries(entries)).map(cleanToken).join(" ");
const user = (written: string, spoken: string, opts: Partial<PronEntry> = {}): PronEntry => ({
  id: `u-${written}`, written, spoken, enabled: true, wholeWord: true, caseSensitive: true, afterNumber: false, ...opts,
});

describe("units after numbers", () => {
  it("expands units with and without a space, with singular after 1", () => {
    expect(speak("The stage delivers 5 kW today")).toBe("The stage delivers 5 kilowatts today");
    expect(speak("A 5kW stage")).toBe("A 5 kilowatts stage");
    expect(speak("only 1 kW left")).toBe("only 1 kilowatt left");
    expect(speak("a 48 V rail and 1 V ripple")).toBe("a 48 volts rail and 1 volt ripple");
    expect(speak("timing of 60 ns, then 1 s")).toBe("timing of 60 nanoseconds, then 1 second");
  });
  it("reads ranges as 'to' with the plural unit", () => {
    expect(speak("tuned to 4.8–7.1 MHz.")).toBe("tuned to 4.8 to 7.1 megahertz.");
    expect(speak("from 4.8–7.1MHz")).toBe("from 4.8 to 7.1 megahertz");
  });
  it("keeps the punctuation around a unit", () => {
    expect(speak("(10 mA), then")).toBe("(10 milliamps), then");
    expect(speak("at 25 °C.")).toBe("at 25 degrees Celsius.");
  });
  it("treats the micro sign and Greek mu alike, and the ohm sign and omega alike", () => {
    expect(speak("a 10 µH coil")).toBe("a 10 microhenries coil");
    expect(speak("a 10 μH coil")).toBe("a 10 microhenries coil");
    expect(speak("a 4.7 kΩ resistor")).toBe("a 4.7 kilohms resistor");
    expect(speak("a 4.7 kΩ resistor")).toBe("a 4.7 kilohms resistor");
  });
});

describe("case sensitivity and standalone letters", () => {
  it("tells mA from MA and mH from MH", () => {
    expect(speak("draws 3 mA")).toBe("draws 3 milliamps");
    expect(speak("based in MA")).toBe("based in MA");
    expect(speak("a 2 mH choke")).toBe("a 2 millihenries choke");
    expect(speak("MH series")).toBe("MH series");
  });
  it("leaves lone letters in prose alone", () => {
    expect(speak("Plan A failed, so V and W went home")).toBe("Plan A failed, so V and W went home");
    expect(speak("The s in seconds")).toBe("The s in seconds");
    expect(speak("in the 1990s")).toBe("in the 1990s");
  });
  it("leaves acronyms like GaN, ZVS and PCB alone by default", () => {
    expect(speak("GaN ZVS PCB")).toBe("GaN ZVS PCB");
  });
});

describe("user entries", () => {
  it("override the starter pack", () => {
    const mine = user("kW", "kay double-you");
    expect(speak("5 kW", [...STARTER_PACK, mine])).toBe("5 kay double-you");
  });
  it("can be disabled, case-insensitive, or inside words", () => {
    expect(speak("5 kW", STARTER_PACK.map((e) => (e.written === "kW" ? { ...e, enabled: false } : e)))).toBe("5 kW");
    expect(speak("gan GaN", [user("gan", "gallium nitride", { caseSensitive: false })])).toBe("gallium nitride gallium nitride");
    expect(speak("subPCBs", [user("PCB", "P C B", { wholeWord: false })])).toBe("subP C Bs");
  });
  it("supports a regex entry", () => {
    expect(speak("rev A3 and rev B12", [user("^([A-Z])(\\d+)$", "$1 $2", { regex: true, wholeWord: false })])).toBe("rev A 3 and rev B 12");
  });
  it("round-trips through JSON import", () => {
    const lex = parseLexicon(JSON.parse(JSON.stringify(defaultLexicon())));
    expect(lex.entries.length).toBe(STARTER_PACK.length);
    expect(() => parseLexicon({ entries: [{ written: "x" }] })).toThrow(/needs/);
  });
});

describe("phoneme to word mapping", () => {
  it("splits merged words back to their tokens", () => {
    // espeak says "have been" as one word in context: hɐvbɪn
    const owner = alignPhonemes(["hˈæv", "bˈɪn"], "hɐvbɪn");
    expect(owner).toEqual([0, 0, 0, 1, 1, 1]);
  });
  it("keeps the mapping monotonic and covers every character", () => {
    const owner = alignPhonemes(["fˈaɪv", "kˈɪləwˌɑːts"], "fˈaɪv kˈɪləwˌɑːts");
    expect(owner.every((t, i) => i === 0 || t >= owner[i - 1])).toBe(true);
    expect(owner[0]).toBe(0);
    expect(owner[owner.length - 1]).toBe(1);
  });
  it("gives each expanded token its own phonemes, so 'kW' is highlighted while 'kilowatts' is said", async () => {
    const tokens = "The stage delivers 5 kW at 4.8–7.1 MHz, and have been fine.".split(" ");
    const spoken = applyLexicon(tokens, STARTER_PACK).map(cleanToken);
    const pieces = await phonemizeTokens(spoken, "en-us");
    const byToken = new Map<number, string>();
    for (const p of pieces) byToken.set(p.token, (byToken.get(p.token) ?? "") + p.text);
    // Every spoken token got phonemes, in order
    tokens.forEach((_, i) => expect(byToken.get(i)?.trim().length, tokens[i]).toBeGreaterThan(0));
    expect(pieces.map((p) => p.token)).toEqual([...pieces.map((p) => p.token)].sort((a, b) => a - b));
    expect(byToken.get(tokens.indexOf("kW"))).toMatch(/kˈɪləwˌɑːts/);
    expect(byToken.get(tokens.indexOf("MHz,"))).toMatch(/mˈɛɡəhˌɜːts/);
    // The range token carries all of "four point eight to seven point one"
    expect(byToken.get(tokens.indexOf("4.8–7.1"))!.split(/\s+/).filter(Boolean).length).toBeGreaterThanOrEqual(6);
  });
  it("normalises like kokoro-js", () => {
    expect(normalizeToken("4.8")).toBe("4 point 8");
    expect(normalizeToken("Dr.", "Smith")).toBe("Doctor");
    expect(normalizeToken("2020")).toBe("20 20");
  });
});
