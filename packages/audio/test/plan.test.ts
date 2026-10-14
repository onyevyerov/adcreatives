import { AudioPlan, createPromptLoader, SoundCue } from "@adc/shared";
import { fixtureBrandKit, fixtureStoryboard } from "@adc/shared/fixtures";
import { describe, expect, it } from "vitest";
import { computeChunkLayout } from "../src/chunks.ts";
import {
  audioPlanVars,
  musicPlanHash,
  normalizeAudioPlan,
  planBpm,
  planMatchesLayout,
  planTrackMs,
  planVideoMs,
  referencedCues,
  toCompositionPlan,
  withTrackStructure,
} from "../src/plan.ts";
import { brandTerms, createSanitizer } from "../src/sanitize.ts";
import { loadSfxLibrary, loadStandardCues, parseSfxCues, parseSfxLibrary } from "../src/sfx.ts";
import { draftFor } from "./helpers.ts";

const brand = {
  ...fixtureBrandKit,
  contacts: { ...fixtureBrandKit.contacts, website: "https://zerno.example.com" },
};
const sanitizer = createSanitizer(brandTerms(brand));
const standardCues = loadStandardCues(createPromptLoader());

describe("sanitizer", () => {
  it("collects brand terms: name, logo fallback, site host and its label", () => {
    expect(brandTerms(brand)).toEqual(expect.arrayContaining(["Зерно", "zerno.example.com", "zerno"]));
  });

  it("removes brand names (incl. Cyrillic), artists and 'in the style of' phrases", () => {
    expect(sanitizer.text("Зерно morning jingle")).toBe("morning jingle");
    expect(sanitizer.text("warm lo-fi for zerno café")).toBe("warm lo-fi for café");
    expect(sanitizer.text("cinematic strings in the style of Hans Zimmer, epic")).toBe(
      "cinematic strings, epic",
    );
    expect(sanitizer.text("french house like Daft Punk")).toBe("french house");
    expect(sanitizer.text("inspired by Nujabes")).toBe("");
    expect(sanitizer.text("Ludovico Einaudi piano")).toBe("piano");
  });

  it("keeps ordinary descriptive words", () => {
    expect(sanitizer.text("dreamlike pads, feels like a sunrise")).toBe(
      "dreamlike pads, feels like a sunrise",
    );
    expect(sanitizer.styles(["Warm", "warm", "  ", "Daft Punk", "soft drums"])).toEqual([
      "Warm",
      "soft drums",
    ]);
  });
});

describe("sfx-cues.md", () => {
  it("defines all 8 standard cues with API-valid durations", () => {
    expect(Object.keys(standardCues).sort()).toEqual(
      ["click", "impact", "pop", "riser", "shimmer", "swoosh", "tick", "whoosh"].sort(),
    );
    for (const def of Object.values(standardCues)) {
      expect(def.durationSeconds).toBeGreaterThanOrEqual(0.5);
      expect(def.text.length).toBeGreaterThan(10);
    }
  });

  it("parser rejects a file without all standard cues", () => {
    expect(() => parseSfxCues("- whoosh (0.6 s): air")).toThrow(/немає cue/);
  });

  it("бібліотека подій: усі 30 SoundCue × 5 варіантів, тексти різні, ≥ 0.5 с", () => {
    const library = loadSfxLibrary(createPromptLoader());
    expect(Object.keys(library).sort()).toEqual([...SoundCue.options].sort());
    const texts = new Set<string>();
    for (const [cue, variants] of Object.entries(library)) {
      expect(variants, cue).toHaveLength(5);
      for (const def of variants) {
        expect(def.durationSeconds, cue).toBeGreaterThanOrEqual(0.5);
        expect(def.text, cue).toMatch(/no silence at the beginning/);
        expect(def.text, cue).toMatch(/\bdry\b/);
        texts.add(def.text);
      }
    }
    expect(texts.size).toBe(150);
    // Legacy-шлях sfxCue бере варіант 1 тих самих cue.
    for (const [cue, def] of Object.entries(standardCues)) {
      expect(def).toEqual(library[cue as keyof typeof library][0]);
    }
  });

  it("формат рядка: `cue.N` — варіант N; без номера — варіант 1 (старий формат)", () => {
    const lines = SoundCue.options.map((c) => `- ${c} (0.5 s): ${c} one`);
    const lib = parseSfxLibrary(
      [...lines, "- pop.3 (0.7 s): pop three", "- pop.2 (0.6 s): pop two"].join("\n"),
    );
    expect(lib.pop).toEqual([
      { text: "pop one", durationSeconds: 0.5 },
      { text: "pop two", durationSeconds: 0.6 },
      { text: "pop three", durationSeconds: 0.7 },
    ]);
    expect(lib.slam).toEqual([{ text: "slam one", durationSeconds: 0.5 }]);
    // Старий файл (8 cue без номерів) — валідний для legacy-шляху, але не для бібліотеки подій.
    const legacy = lines.filter((l) => !/ (slam|ding) /.test(l)).join("\n");
    expect(parseSfxCues(legacy).pop).toEqual({ text: "pop one", durationSeconds: 0.5 });
    expect(() => parseSfxLibrary(legacy)).toThrow(/немає cue ding, slam|немає cue slam, ding/);
    expect(() => parseSfxLibrary([...lines, "- pop.1 (0.5 s): again"].join("\n"))).toThrow(/двічі/);
    // Мінімум API — 0.5 с.
    expect(
      parseSfxLibrary(lines.join("\n").replace("pop (0.5 s)", "pop (0.2 s)")).pop[0]?.durationSeconds,
    ).toBe(0.5);
  });
});

describe("normalizeAudioPlan", () => {
  const layout = computeChunkLayout(fixtureStoryboard);

  it("рівно один чанк на весь трек (відео + 8 с), instrumental, vocals/lyrics, contextAdherence high", () => {
    const draft = draftFor(layout);
    // LLM «помилилась»: інші тривалості, без instrumental, з vocals у позитивних.
    draft.compositionPlan.positiveGlobalStyles = ["lo-fi", "warm"];
    draft.compositionPlan.negativeGlobalStyles = ["instrumental"];
    draft.compositionPlan.chunks = draft.compositionPlan.chunks.map((c) => ({
      ...c,
      durationMs: 1_000,
      contextAdherence: "low" as const,
    }));
    const plan = normalizeAudioPlan(draft, {
      layout,
      storyboard: fixtureStoryboard,
      sanitizer,
      standardCues,
    });
    expect(plan.compositionPlan.chunks).toHaveLength(1);
    expect(plan.compositionPlan.chunks[0]).toMatchObject({
      label: "hook+offer+cta",
      section: "hook+offer+cta",
      sceneIds: ["s1", "s2", "s3"],
      durationMs: 23_000,
      contextAdherence: "high",
    });
    expect(plan.compositionPlan.positiveGlobalStyles).toContain("instrumental");
    expect(plan.compositionPlan.negativeGlobalStyles).toEqual(["vocals", "lyrics"]);
    expect(planTrackMs(plan)).toBe(layout.trackMs);
    expect(planVideoMs(plan)).toBe(layout.videoMs);
    expect(planBpm(plan)).toBe(85);
  });

  it("багаточанкова чернетка (старий формат відповіді) → усе одно один чанк", () => {
    const draft = draftFor(layout);
    draft.compositionPlan.chunks = ["s1", "s2", "s3"].map((id) => ({
      label: id,
      section: "",
      sceneIds: [id],
      durationMs: 5_000,
      positiveStyles: [],
      negativeStyles: [],
      contextAdherence: "low" as const,
    }));
    const plan = normalizeAudioPlan(draft, {
      layout,
      storyboard: fixtureStoryboard,
      sanitizer,
      standardCues,
    });
    expect(plan.compositionPlan.chunks).toHaveLength(1);
    expect(plan.compositionPlan.chunks[0]).toMatchObject({ section: "main groove", durationMs: 23_000 });
    expect(plan.compositionPlan.chunks[0]?.positiveStyles.length).toBeGreaterThan(0);
  });

  it("старий багаточанковий план читається, але не відтворюється: не збігається з каркасом", () => {
    const old = AudioPlan.parse({
      compositionPlan: {
        positiveGlobalStyles: ["lo-fi", "85 BPM", "instrumental"],
        negativeGlobalStyles: ["vocals", "lyrics"],
        chunks: [4_500, 5_000, 6_500].map((durationMs, i) => ({
          label: `c${i}`,
          sceneIds: [`s${i + 1}`],
          durationMs,
          positiveStyles: [],
          negativeStyles: [],
          contextAdherence: "high",
        })),
      },
      promptFallback: "lo-fi, instrumental",
      sfx: [],
    });
    expect(planTrackMs(old)).toBe(16_000);
    // Старі плани мали запас 1 с.
    expect(planVideoMs(old)).toBe(15_000);
    expect(planMatchesLayout(old, layout, fixtureStoryboard)).toBe(false);
  });

  it("промпт compose: темп, тональність, 4/4, фрази по 4 такти, без брейку/філу/стопу в перших N с", () => {
    const plan = normalizeAudioPlan(draftFor(layout), {
      layout,
      storyboard: fixtureStoryboard,
      sanitizer,
      standardCues,
    });
    const p = plan.promptFallback;
    expect(p.startsWith("Warm lo-fi hip hop at 85 BPM with rhodes and soft drums, instrumental")).toBe(true);
    for (const phrase of [
      "in A minor",
      "4/4 time",
      "phrases of 4 bars",
      "kick on every beat",
      "no breakdown",
      "no fill",
      "no stop in the first 15 seconds",
    ]) {
      expect(p).toContain(phrase);
    }
    expect(p.match(/85 BPM/g)).toHaveLength(1);
  });

  it("withTrackStructure: чужий темп і чужий N виправляються, наявне не дублюється", () => {
    const fixed = withTrackStructure(
      "Funk at 100 bpm in 4/4, phrases of 4 bars, kick on every beat, no breakdown, no fill, no stop in the first 9 seconds, instrumental.",
      { bpm: 92, key: null, videoMs: 20_500 },
    );
    expect(fixed).toBe(
      "Funk at 92 BPM in 4/4, phrases of 4 bars, kick on every beat, no breakdown, no fill, no stop in the first 21 seconds, instrumental",
    );
    expect(withTrackStructure("", { bpm: 120, key: "D major", videoMs: 15_000 })).toBe(
      "120 BPM, in D major, 4/4 time, phrases of 4 bars, kick on every beat, no breakdown, no fill, no stop in the first 15 seconds, instrumental",
    );
  });

  it("темп — рівно musicBrief.bpm; одна розпізнана тональність — у key і в стилях", () => {
    const draft = draftFor(layout, { key: "F# minor" });
    draft.compositionPlan.positiveGlobalStyles = ["lo-fi hip hop", "95 BPM", "rhodes"];
    const plan = normalizeAudioPlan(draft, {
      layout,
      storyboard: fixtureStoryboard,
      sanitizer,
      standardCues,
    });
    expect(plan.key).toBe("F# minor");
    expect(plan.compositionPlan.positiveGlobalStyles).toEqual([
      "lo-fi hip hop",
      "rhodes",
      "85 BPM",
      "F# minor",
      "instrumental",
    ]);
    const vague = normalizeAudioPlan(draftFor(layout, { key: "warm and cozy" }), {
      layout,
      storyboard: fixtureStoryboard,
      sanitizer,
      standardCues,
    });
    expect(vague.key).toBeNull();
    // Старий план без key парситься (key: null → пентатоніка ля мінору у зведенні).
    const { key: _drop, ...old } = plan;
    expect(AudioPlan.parse(old).key).toBeNull();
  });

  it("strips brand and artist names from styles and the fallback prompt", () => {
    const draft = draftFor(layout, {
      promptFallback: "Upbeat Зерно theme in the style of Daft Punk, 85 BPM",
    });
    draft.compositionPlan.positiveGlobalStyles = ["Zerno vibe", "Hans Zimmer strings", "lo-fi"];
    const first = draft.compositionPlan.chunks[0];
    if (first) first.positiveStyles = ["like Coldplay", "intro build"];
    const plan = normalizeAudioPlan(draft, {
      layout,
      storyboard: fixtureStoryboard,
      sanitizer,
      standardCues,
    });
    const all = JSON.stringify(toCompositionPlan(plan)) + plan.promptFallback;
    for (const banned of ["Зерно", "Zerno", "Daft Punk", "Hans Zimmer", "Coldplay"]) {
      expect(all.toLowerCase()).not.toContain(banned.toLowerCase());
    }
    expect(plan.promptFallback).toMatch(/instrumental/);
    expect(plan.compositionPlan.chunks[0]?.positiveStyles).toEqual(["intro build"]);
  });

  it("falls back to brief-based styles when the draft has nothing usable", () => {
    const draft = draftFor(layout, { promptFallback: "Daft Punk" });
    draft.compositionPlan.positiveGlobalStyles = [];
    draft.compositionPlan.chunks = [];
    const plan = normalizeAudioPlan(draft, {
      layout,
      storyboard: fixtureStoryboard,
      sanitizer,
      standardCues,
    });
    expect(plan.compositionPlan.positiveGlobalStyles).toEqual(
      expect.arrayContaining(["lo-fi hip hop", "85 BPM", "instrumental"]),
    );
    expect(plan.compositionPlan.chunks).toHaveLength(1);
    expect(plan.compositionPlan.chunks[0]?.section).toBe("main groove");
    expect(plan.compositionPlan.chunks.every((c) => c.positiveStyles.length > 0)).toBe(true);
    expect(plan.promptFallback).toMatch(/lo-fi hip hop.*instrumental/);
  });

  it("SFX: standard cues come from the library, custom ones are clamped to 0.5–1.5 s, max 3", () => {
    const storyboard = {
      ...fixtureStoryboard,
      scenes: fixtureStoryboard.scenes.map((s, i) => ({ ...s, sfxCue: i === 0 ? "whoosh" : `custom-${i}` })),
    };
    const draft = draftFor(computeChunkLayout(storyboard), {
      sfx: [
        { cue: "custom-1", text: "cup clink on Зерно table", durationSeconds: 4, custom: true },
        { cue: "custom-2", text: "espresso machine hiss", durationSeconds: 0.1, custom: true },
      ],
    });
    const plan = normalizeAudioPlan(draft, {
      layout: computeChunkLayout(storyboard),
      storyboard,
      sanitizer,
      standardCues,
    });
    expect(plan.sfx).toEqual([
      {
        cue: "whoosh",
        text: standardCues.whoosh.text,
        durationSeconds: standardCues.whoosh.durationSeconds,
        custom: false,
      },
      { cue: "custom-1", text: "cup clink on table", durationSeconds: 1.5, custom: true },
      { cue: "custom-2", text: "espresso machine hiss", durationSeconds: 0.5, custom: true },
    ]);
    const many = { scenes: ["a", "b", "c", "d"].map((c) => ({ sfxCue: `custom-${c}` })) };
    expect(referencedCues(many as never).custom).toHaveLength(3);
  });

  it("toCompositionPlan maps to music_v2_5 chunks; plan hash is stable and content-sensitive", () => {
    const plan = normalizeAudioPlan(draftFor(layout), {
      layout,
      storyboard: fixtureStoryboard,
      sanitizer,
      standardCues,
    });
    const api = toCompositionPlan(plan);
    expect(api.chunks).toHaveLength(1);
    expect(api.chunks[0]).toMatchObject({
      text: "[hook+offer+cta]",
      durationMs: 23_000,
      contextAdherence: "high",
      positiveStyles: expect.arrayContaining(["instrumental", "hook+offer+cta groove"]),
      negativeStyles: expect.arrayContaining(["vocals", "lyrics"]),
    });
    expect(musicPlanHash(plan)).toBe(musicPlanHash(structuredClone(plan)));
    const changed = structuredClone(plan);
    changed.promptFallback = "something else, instrumental";
    expect(musicPlanHash(changed)).not.toBe(musicPlanHash(plan));
  });

  it("prompt vars never include the brand name", () => {
    const vars = audioPlanVars(brand, fixtureStoryboard, layout, sanitizer);
    const text = JSON.stringify(vars);
    expect(text).not.toContain("Зерно");
    expect(vars.chunks).toHaveLength(1);
    expect(vars.steadySeconds).toBe(15);
    // Промпт рендериться без пропущених змінних.
    const prompt = createPromptLoader().load("audio-plan", vars);
    expect(prompt.model).toBe("claude-opus-5-5");
    expect(prompt.user).toContain('"durationMs": 23000');
    expect(prompt.user).toContain("Track duration: 23000 ms");
    expect(prompt.user).toContain('"no stop in the first N seconds": 15');
    expect(prompt.system).toMatch(/no breakdown, no fill, no stop in the first N seconds/);
  });
});
