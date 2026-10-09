import { createPromptLoader } from "@adc/shared";
import { fixtureBrandKit, fixtureStoryboard } from "@adc/shared/fixtures";
import { describe, expect, it } from "vitest";
import { computeChunkLayout } from "../src/chunks.ts";
import {
  audioPlanVars,
  musicPlanHash,
  normalizeAudioPlan,
  planTrackMs,
  referencedCues,
  toCompositionPlan,
} from "../src/plan.ts";
import { brandTerms, createSanitizer } from "../src/sanitize.ts";
import { loadStandardCues, parseSfxCues } from "../src/sfx.ts";
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
});

describe("normalizeAudioPlan", () => {
  const layout = computeChunkLayout(fixtureStoryboard);

  it("enforces timeline chunks, instrumental, vocals/lyrics and contextAdherence high", () => {
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
    expect(plan.compositionPlan.chunks.map((c) => c.durationMs)).toEqual([4_500, 5_000, 6_500]);
    expect(plan.compositionPlan.chunks.every((c) => c.contextAdherence === "high")).toBe(true);
    expect(plan.compositionPlan.positiveGlobalStyles).toContain("instrumental");
    expect(plan.compositionPlan.negativeGlobalStyles).toEqual(["vocals", "lyrics"]);
    expect(planTrackMs(plan)).toBe(layout.trackMs);
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
    expect(plan.compositionPlan.chunks).toHaveLength(3);
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
      { cue: "whoosh", text: standardCues.whoosh.text, durationSeconds: 0.6, custom: false },
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
    expect(api.chunks[0]).toMatchObject({
      text: "[hook]",
      durationMs: 4_500,
      contextAdherence: "high",
      positiveStyles: expect.arrayContaining(["instrumental", "hook groove"]),
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
    expect(vars.chunks).toHaveLength(3);
    // Промпт рендериться без пропущених змінних.
    const prompt = createPromptLoader().load("audio-plan", vars);
    expect(prompt.model).toBe("claude-opus-5-5");
    expect(prompt.user).toContain('"durationMs": 4500');
  });
});
