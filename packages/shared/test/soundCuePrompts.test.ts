import { describe, expect, it } from "vitest";
import {
  createPromptLoader,
  GRID_SOUND_CUES,
  HIT_SOUND_CUES,
  PITCHED_SOUND_CUES,
  SOUND_CUE_TRAITS,
  SoundCue,
} from "../src/index.ts";

// Промпти LLM мають знати кожен cue з enum і ту саму поведінку, що й таблиця SOUND_CUE_TRAITS.
// Списки cue беруться з @adc/shared, а не з тесту, щоб промпти не розходились з enum.

const cues = SoundCue.options;
const where = (pred: (c: SoundCue) => boolean) => cues.filter(pred).sort();
const peakCues = where((c) => SOUND_CUE_TRAITS[c].anchor === "peak");
const endCues = where((c) => SOUND_CUE_TRAITS[c].anchor === "end");

// Будь-яка {{змінна}} підставляється плейсхолдером: тест читає правила, а не дані стадії.
const anyVars = new Proxy({} as Record<string, unknown>, {
  has: () => true,
  get: (_, key) => (typeof key === "string" ? `<${key}>` : undefined),
});
const loader = createPromptLoader();
const systemOf = (name: string) => loader.load(name, anyVars).system;

/** Назви в бектиках (`pop`, `pop`s) — слово всередині іншого (`popup`, popular) не рахується. */
const ticked = (text: string) => [...new Set([...text.matchAll(/`([a-z]+)`/g)].map((m) => m[1] as string))];
const tickedCues = (text: string) => ticked(text).filter((t): t is SoundCue => SoundCue.safeParse(t).success);

/** Шматок тексту від `start` (включно) до першого `end` після нього. */
function between(text: string, start: string, end: string | RegExp): string {
  const from = text.indexOf(start);
  expect(from, `немає «${start}»`).toBeGreaterThanOrEqual(0);
  const rest = text.slice(from);
  const to = typeof end === "string" ? rest.indexOf(end, start.length) : rest.slice(start.length).search(end);
  expect(to, `немає кінця шматка після «${start}»`).toBeGreaterThanOrEqual(0);
  return typeof end === "string" ? rest.slice(0, to) : rest.slice(0, start.length + to);
}

describe("промпти знають усі 30 SoundCue", () => {
  it("перевірки не порожні: 30 cue, є peak- і end-cue", () => {
    expect(cues).toHaveLength(30);
    expect(peakCues.length).toBeGreaterThan(0);
    expect(endCues.length).toBeGreaterThan(0);
  });

  const storyboard = systemOf("storyboard");
  const events = between(storyboard, "# Moments: `events`", /\n# /);

  it("storyboard: список `cue` — рівно enum", () => {
    expect(tickedCues(between(events, "`cue` is one of", ";")).sort()).toEqual([...cues].sort());
    // Нічого, крім cue, у списку немає (наприклад, вигаданого звуку).
    expect(ticked(between(events, "`cue` is one of", ";")).filter((t) => t !== "cue")).toHaveLength(30);
  });

  it("storyboard: «коли який» — рядок на кожен cue", () => {
    for (const c of cues) expect(events, c).toMatch(new RegExp(`^- \`${c}\`: \\S`, "m"));
  });

  it("storyboard: якір — riser закінчується на at, peak-cue мають пік на at", () => {
    const anchors = between(events, "The sound is placed", "every other cue starts on `at`");
    const peak = between(anchors, "ends exactly on `at`;", "peak on `at`");
    expect(tickedCues(peak).sort()).toEqual(peakCues);
    expect(tickedCues(between(anchors, "The sound is placed", "ends exactly")).sort()).toEqual(endCues);
  });

  it("storyboard: правило дисципліни називає кожен важкий удар і лише їх", () => {
    const discipline = between(events, "Sound discipline:", "\n");
    const hits = between(discipline, "Sound discipline:", "structural hits.");
    expect(tickedCues(hits).sort()).toEqual([...HIT_SOUND_CUES].sort());
    for (const c of ["cash", "cheer", "scratch", "glitch"]) expect(tickedCues(discipline)).toContain(c);
  });

  it("storyboard: сітка — поза сіткою рівно cue з grid: false; тональні — рівно PITCHED_SOUND_CUES", () => {
    const grid = between(events, "Every appearance that matters", "\n");
    expect(tickedCues(between(grid, "at once.", "stay exactly")).sort()).toEqual(
      where((c) => !GRID_SOUND_CUES.has(c)),
    );
    expect(tickedCues(between(grid, "Successive", "key of the music")).sort()).toEqual(
      [...PITCHED_SOUND_CUES].sort(),
    );
  });

  it("revise: список cue у рядку про events — рівно enum", () => {
    const line = between(systemOf("revise"), "- Моменти (`events`)", "\n");
    expect(tickedCues(between(line, "(cue:", "; accent")).sort()).toEqual([...cues].sort());
  });

  it("audio-plan, пункт 3: список cue — рівно enum, дакінг під важкими ударами, тональні — PITCHED", () => {
    const item = between(systemOf("audio-plan"), "3. **Sound events", "\n");
    expect(tickedCues(between(item, "gives a sound (", ")")).sort()).toEqual([...cues].sort());
    expect(item).toContain("Code ducks the music under impacts, slams and drops.");
    expect(tickedCues(between(item, "Pitched events (", ")")).sort()).toEqual([...PITCHED_SOUND_CUES].sort());
  });

  for (const name of ["author", "codegen"]) {
    it(`${name}: абзац про events називає peak- і end-cue, без переліку решти`, () => {
      const rule = between(systemOf(name), "so the picture must hit exactly there:", "starts on it.");
      expect(tickedCues(between(rule, "there:", "ends on the frame")).sort()).toEqual(endCues);
      expect(tickedCues(between(rule, "ends on the frame", "peak on it")).sort()).toEqual(peakCues);
      expect(tickedCues(rule).sort()).toEqual([...endCues, ...peakCues].sort());
    });
  }
});
