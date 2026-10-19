import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { z as zod } from "zod";
import {
  fixtureAssets,
  fixtureAudioManifest,
  fixtureBrandKit,
  fixtureBrandKitFile,
  fixtureProject,
  fixtureSiteData,
  fixtureStoryboard,
} from "../src/fixtures.ts";
import { toStrictJsonSchema, UnsupportedSchemaError } from "../src/llm/structured.ts";
import {
  AssetManifest,
  AudioPlan,
  AutoIssueKind,
  BrandKit,
  BrandKitFile,
  BrandKitPatch,
  ChatEvent,
  ChatIntent,
  CheckReport,
  ClaimsReport,
  CostEvent,
  IntakeFile,
  intentHasEdits,
  MusicMeta,
  normalizeFormats,
  PipelineCounters,
  ProjectState,
  primaryFormat,
  QaIssueKind,
  QaReport,
  RevisionPlan,
  Scene,
  SiteData,
  StatsRow,
  StillRef,
  StillVariant,
  Storyboard,
} from "../src/schemas/index.ts";
import { RenderMeta } from "../src/stage.ts";
import { AudioManifest } from "../src/types/video.ts";

const AT = "2026-10-06T10:00:00.000Z";

function roundTrip<S extends z.ZodType>(schema: S, value: z.input<S>) {
  const parsed = schema.parse(JSON.parse(JSON.stringify(value)));
  expect(parsed).toEqual(value);
}

const audioPlan: z.input<typeof AudioPlan> = {
  compositionPlan: {
    positiveGlobalStyles: ["lo-fi", "instrumental"],
    negativeGlobalStyles: ["vocals", "lyrics"],
    chunks: [
      {
        label: "intro",
        sceneIds: ["s1"],
        durationMs: 5000,
        positiveStyles: ["soft"],
        negativeStyles: [],
        contextAdherence: "high",
      },
    ],
  },
  key: null,
  promptFallback: "warm lo-fi instrumental",
  sfx: [{ cue: "whoosh", text: "soft whoosh", durationSeconds: 0.8, custom: false }],
};

const qaReport: z.input<typeof QaReport> = {
  verdict: "fix",
  summary: "Текст обрізано в s2",
  issues: [
    {
      sceneId: "s2",
      format: "vertical",
      severity: "major",
      kind: "clipped_text",
      description: "Ціна виходить за край",
      fix: "Зменшити розмір шрифту",
    },
  ],
};

const revisionPlan: z.input<typeof RevisionPlan> = {
  summary: "Новий заголовок у s2",
  storyboardPatch: [{ op: "replace", path: "/scenes/1/text/headline", valueJson: '"Новий"', from: null }],
  scenesToRegenerate: [{ sceneId: "s2", instruction: "Інший заголовок" }],
  musicChanged: false,
  durationChanged: false,
};

const chatIntent: z.input<typeof ChatIntent> = {
  kind: "edit",
  answers: [],
  formats: ["vertical", "square"],
  language: null,
  brandEdits: "основний колір темніший",
  edits: null,
  facts: [{ kind: "discount", text: "-15% у вівторок" }],
  durationSeconds: null,
  question: null,
};

describe("schemas round-trip", () => {
  it("crawl", () => {
    roundTrip(SiteData, fixtureSiteData);
    roundTrip(AssetManifest, fixtureAssets);
  });
  it("brandkit", () => {
    roundTrip(BrandKit, fixtureBrandKit);
    roundTrip(BrandKitFile, fixtureBrandKitFile);
    roundTrip(BrandKitPatch, {
      ops: [{ op: "replace", path: "/palette/primary", valueJson: '"#000000"', from: null }],
      summary: "x",
    });
  });
  it("storyboard, audio, qa, claims, revision, intent", () => {
    roundTrip(Storyboard, fixtureStoryboard);
    roundTrip(AudioPlan, audioPlan);
    roundTrip(AudioManifest, fixtureAudioManifest);
    roundTrip(QaReport, qaReport);
    roundTrip(RevisionPlan, revisionPlan);
    roundTrip(ChatIntent, chatIntent);
    roundTrip(CheckReport, {
      compileErrors: [{ sceneId: "s1", message: "TS2322", line: 3, column: 5 }],
      bundleError: null,
      runtimeErrors: [],
      autoIssues: [
        {
          sceneId: "s2",
          format: "vertical",
          kind: "text_overflow",
          component: "FitText",
          detail: "x",
          value: 12,
        },
      ],
      stills: [{ sceneId: "s1", format: "vertical", variant: "a", frame: 75, path: "x.png" }],
      sheets: [{ format: "vertical", path: "sheets/vertical.png" }],
      moments: [{ sceneId: "s1", format: "vertical", path: "moments/vertical/s1.jpg" }],
      durationMs: 1000,
    });
    roundTrip(ClaimsReport, {
      checkedAt: AT,
      brandkitVersion: 1,
      verified: [
        {
          sceneId: "s2",
          field: "headline",
          text: "75 грн",
          kind: "price",
          itemId: null,
          factId: "f1",
          matchedContact: false,
          matchedSite: false,
        },
        {
          sceneId: "s2",
          field: "item",
          itemId: "t2",
          text: "від $300–2000",
          kind: "price",
          factId: null,
          matchedContact: false,
          matchedSite: true,
        },
      ],
      unverified: [],
    });
  });
  it("project, events, cost", () => {
    roundTrip(ProjectState, fixtureProject({ answers: { q1: "так" } }));
    roundTrip(PipelineCounters, {
      attempts: { codegen: 1 },
      fixRounds: { s1: 2 },
      qaRounds: 1,
      reviewRounds: 1,
      templateScenes: ["s1"],
      dirtyScenes: [],
    });
    // Старі файли без нових полів парсяться з дефолтами.
    expect(
      PipelineCounters.parse({
        attempts: {},
        fixRounds: {},
        qaRounds: 0,
        templateScenes: [],
        dirtyScenes: [],
      }).reviewRounds,
    ).toBe(0);
    expect(
      CheckReport.parse({
        compileErrors: [],
        bundleError: null,
        runtimeErrors: [],
        autoIssues: [],
        stills: [],
        sheets: [],
        durationMs: 0,
      }).moments,
    ).toEqual([]);
    const events: z.input<typeof ChatEvent>[] = [
      { type: "message", at: AT, role: "assistant", text: "Привіт", buttons: ["approve", "edit"] },
      { type: "progress", at: AT, stage: "crawl", label: "Сканую", done: 7, total: 25 },
      { type: "state", at: AT, status: "crawling", prev: "intake", rev: 1 },
      { type: "cost", at: AT, totalUsd: 0.42, stage: "brandkit", stageUsd: 0.4 },
      { type: "error", at: AT, stage: "crawl", message: "Сайт недоступний", retryable: true },
      {
        type: "artifact",
        at: AT,
        rev: 1,
        kind: "video",
        url: "/files/x.mp4",
        format: "vertical",
        sceneId: null,
      },
      {
        type: "checkpoint",
        at: AT,
        rev: 1,
        checkpoint: "script",
        payload: {
          checkpoint: "script",
          storyboard: fixtureStoryboard,
          claims: { checkedAt: AT, brandkitVersion: 1, verified: [], unverified: [] },
          thumbnails: [{ url: "/files/a.jpg", assetId: "a01" }],
          musicBrief: fixtureStoryboard.musicBrief,
          durationSeconds: 15,
        },
      },
    ];
    for (const e of events) roundTrip(ChatEvent, e);
    roundTrip(CostEvent, {
      ts: AT,
      projectId: "p1",
      rev: 1,
      stage: "brandkit",
      phase: "first_delivery",
      source: "chat",
      provider: "anthropic",
      model: "claude-opus-5-5",
      promptName: "brandkit",
      promptHash: "abc",
      effort: "high",
      attempt: 1,
      units: { input: 1000, output: 500, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0 },
      unitPrices: { input: 4, output: 20 },
      usd: 0.014,
      exact: true,
      detail: null,
    });
    roundTrip(StatsRow, {
      projectId: "p1",
      createdAt: AT,
      site: "https://zerno.example.com/",
      status: "delivered",
      source: "chat",
      formats: ["vertical"],
      videoSeconds: 15,
      firstDeliveryUsd: 2.5,
      revisionUsd: 0.5,
      totalUsd: 3,
      revisionsCount: 1,
      fixesCount: 2,
      templateScenesCount: 0,
      machineSecondsToFirstDelivery: 300,
      delivered: true,
      overTarget: false,
      chatUrl: "/?project=p1",
    });
  });

  it("rejects invalid values", () => {
    expect(() => Storyboard.parse({ ...fixtureStoryboard, fps: 25 })).toThrow();
    expect(() =>
      BrandKit.parse({ ...fixtureBrandKit, palette: { ...fixtureBrandKit.palette, primary: "brown" } }),
    ).toThrow();
    expect(() => BrandKit.parse({ ...fixtureBrandKit, logoCandidates: ["a", "b", "c", "d", "e"] })).toThrow();
  });
});

describe("formats & intent helpers", () => {
  it("primary format follows canonical order", () => {
    expect(primaryFormat(["landscape", "square"])).toBe("square");
    expect(normalizeFormats(["landscape", "vertical", "vertical"])).toEqual(["vertical", "landscape"]);
    expect(() => primaryFormat([])).toThrow();
  });
  it("mixed message is not an approval", () => {
    expect(intentHasEdits(ChatIntent.parse(chatIntent))).toBe(true);
    expect(
      intentHasEdits({ ...ChatIntent.parse(chatIntent), brandEdits: null, facts: [], formats: ["square"] }),
    ).toBe(false);
  });
});

describe("Крок 0: сумісність зі старими даними", () => {
  it("рядок costs.jsonl без cacheWrite1h парситься з 0", () => {
    const old = {
      ts: AT,
      projectId: "p1",
      rev: 1,
      stage: "codegen",
      phase: "first_delivery",
      source: "chat",
      provider: "anthropic",
      model: "claude-opus-5-5",
      promptName: "codegen",
      promptHash: "abc",
      effort: "high",
      attempt: 1,
      units: { input: 10, output: 20, cacheWrite: 30, cacheRead: 40 },
      unitPrices: { input: 4 },
      usd: 0.1,
      exact: true,
    };
    expect(CostEvent.parse(old).units).toEqual({
      input: 10,
      output: 20,
      cacheWrite: 30,
      cacheWrite1h: 0,
      cacheRead: 40,
    });
    // Не-токенні одиниці лишаються як були.
    expect(CostEvent.parse({ ...old, provider: "remotion", units: { renders: 1 } }).units).toEqual({
      renders: 1,
    });
  });

  it("стіли: варіант e (25%), старий check.json з a/b читається", () => {
    expect(StillVariant.options).toEqual(["e", "a", "b"]);
    expect(
      StillRef.parse({ sceneId: "s1", format: "square", variant: "e", frame: 20, path: "x" }).variant,
    ).toBe("e");
    const oldCheck = {
      compileErrors: [],
      bundleError: null,
      runtimeErrors: [],
      autoIssues: [],
      stills: [
        { sceneId: "s1", format: "vertical", variant: "a", frame: 45, path: "stills/vertical/s1-a.png" },
        { sceneId: "s1", format: "vertical", variant: "b", frame: 81, path: "stills/vertical/s1-b.png" },
      ],
      sheets: [],
      durationMs: 5,
    };
    expect(CheckReport.parse(oldCheck).stills.map((st) => st.variant)).toEqual(["a", "b"]);
    expect(() => StillRef.parse({ ...oldCheck.stills[0], variant: "c" })).toThrow();
  });

  it("QA: late_text; RenderMeta", () => {
    expect(QaIssueKind.options).toContain("late_text");
    expect(
      QaReport.parse({ ...qaReport, issues: [{ ...qaReport.issues[0], kind: "late_text" }] }).issues[0]?.kind,
    ).toBe("late_text");
    roundTrip(RenderMeta, { inputsHash: "0123456789abcdef" });
    expect(() => RenderMeta.parse({ inputsHash: "" })).toThrow();
  });
});

describe("Крок 0 «якість відео»: сумісність зі старими даними", () => {
  /** Storyboard зі старого `storyboard.json`: без items, events і mix. */
  const oldStoryboard = () => {
    const sb = JSON.parse(JSON.stringify(fixtureStoryboard));
    for (const s of sb.scenes) {
      s.items = undefined;
      s.events = undefined;
    }
    for (const part of sb.musicBrief.structure) part.mix = undefined;
    return JSON.parse(JSON.stringify(sb));
  };

  it("старий storyboard без items/events/mix парситься з дефолтами; sfxCue лишається", () => {
    const sb = Storyboard.parse(oldStoryboard());
    expect(sb.scenes.every((s) => s.items.length === 0 && s.events.length === 0)).toBe(true);
    expect(sb.scenes.map((s) => s.sfxCue)).toEqual(["whoosh", "pop", "shimmer"]);
    expect(sb.musicBrief.structure.map((p) => p.mix)).toEqual(["full", "full"]);
  });

  it("round-trip нового storyboard: items, events і mix зберігаються", () => {
    roundTrip(Storyboard, fixtureStoryboard);
    const s2 = Storyboard.parse(JSON.parse(JSON.stringify(fixtureStoryboard))).scenes[1];
    expect(s2?.items.map((i) => i.role)).toEqual(["label", "number", "badge"]);
    expect(s2?.events.map((e) => e.sound?.cue ?? null)).toEqual(["impact", null]);
  });

  it("items/events: id за форматом, дефолти accent/group/factIds/textIds", () => {
    const base = Storyboard.parse(oldStoryboard()).scenes[0];
    if (!base) throw new Error("fixture");
    const parse = (patch: object) => Scene.parse({ ...base, ...patch });
    const item = { id: "t1", role: "item", text: "Крок 1" };
    const event = { id: "step-in", at: 0, what: "x", sound: { cue: "tick" } };
    const ok = parse({ items: [item], events: [event] });
    expect(ok.items[0]).toEqual({ ...item, group: null, factIds: [] });
    expect(ok.events[0]).toEqual({ ...event, sound: { cue: "tick", accent: "normal" }, textIds: [] });
    expect(parse({ events: [{ ...event, sound: undefined }] }).events[0]?.sound).toBeNull();
    expect(() => parse({ items: [{ ...item, id: "x1" }] })).toThrow();
    expect(() => parse({ items: [{ ...item, text: "" }] })).toThrow();
    expect(() => parse({ items: [{ ...item, role: "icon" }] })).toThrow();
    expect(() => parse({ events: [{ ...event, id: "Step_In" }] })).toThrow();
    expect(() => parse({ events: [{ ...event, at: -1 }] })).toThrow();
    expect(() => parse({ events: [{ ...event, sound: { cue: "boom" } }] })).toThrow();
    expect(parse({ layoutIntent: "custom" }).layoutIntent).toBe("custom");
  });

  it("старий claims.json: field headline/sub, без itemId і matchedSite", () => {
    const old = {
      checkedAt: AT,
      brandkitVersion: 1,
      verified: [
        { sceneId: "s2", field: "sub", text: "-10%", kind: "percent", factId: "f2", matchedContact: false },
      ],
      unverified: [],
    };
    expect(ClaimsReport.parse(old).verified[0]).toMatchObject({ itemId: null, matchedSite: false });
    expect(() =>
      ClaimsReport.parse({ ...old, verified: [{ ...old.verified[0], field: "footer" }] }),
    ).toThrow();
  });

  it("тест Epidemic: старі music.json і audio.json без провайдерів — elevenlabs", () => {
    const oldMusic = {
      planHash: "p",
      durationMs: 29_000,
      modelId: "music_v2_5",
      method: "composeDetailed",
      promptUsed: null,
      briefHash: "b",
      createdAt: AT,
    };
    expect(MusicMeta.parse(oldMusic)).toMatchObject({ provider: "elevenlabs", epidemic: null });
    const epidemic = {
      trackId: "t1",
      title: "Track",
      artists: ["Artist"],
      bpm: 92,
      targetBpm: 90,
      tempoWarning: false,
      versionJobId: "job-1",
      candidatesTried: 1,
    };
    expect(MusicMeta.parse({ ...oldMusic, provider: "epidemic", method: "catalog", epidemic })).toMatchObject(
      { provider: "epidemic", method: "catalog", epidemic },
    );
    expect(() => MusicMeta.parse({ ...oldMusic, provider: "suno" })).toThrow();
    expect(() =>
      MusicMeta.parse({ ...oldMusic, provider: "epidemic", epidemic: { ...epidemic, candidatesTried: 0 } }),
    ).toThrow();

    const { providers: _p, epidemic: _e, ...oldManifest } = fixtureAudioManifest;
    expect(AudioManifest.parse(oldManifest)).toMatchObject({
      providers: { music: "elevenlabs", sfx: "elevenlabs" },
      epidemic: null,
    });
    const used = {
      trackId: null,
      sfx: [{ cue: "whoosh", variant: 1, id: "s1", title: "Whoosh" }],
      downloads: 3,
    };
    expect(
      AudioManifest.parse({
        ...oldManifest,
        providers: { music: "elevenlabs", sfx: "epidemic" },
        epidemic: used,
      }),
    ).toMatchObject({ providers: { music: "elevenlabs", sfx: "epidemic" }, epidemic: used });
    expect(() => AudioManifest.parse({ ...oldManifest, epidemic: { ...used, downloads: -1 } })).toThrow();
  });

  it("старий audio.json без mix і audio-plan.json без key", () => {
    const { mix: _mix, ...oldManifest } = fixtureAudioManifest;
    expect(AudioManifest.parse(oldManifest).mix).toBeNull();
    expect(
      AudioManifest.parse({ ...oldManifest, mix: { src: "soundtrack.wav", durationMs: 15000 } }).mix,
    ).toEqual({
      src: "soundtrack.wav",
      durationMs: 15000,
      integratedLufs: null,
      truePeakDbtp: null,
      masterGainDb: null,
    });
    const { key: _key, ...oldPlan } = audioPlan as z.output<typeof AudioPlan>;
    expect(AudioPlan.parse(oldPlan).key).toBeNull();
    expect(AudioPlan.parse({ ...oldPlan, key: "A minor" }).key).toBe("A minor");
  });

  it("якість звуку: старі music.json і audio.json парсяться з новими полями null", () => {
    const oldCheck = {
      bpm: 120,
      kickOnsets: 48,
      beatConfidence: 0.9,
      gaps: [],
      rmsPerSecondDb: [-14],
      ok: true,
    };
    const oldMusic = {
      planHash: "p",
      durationMs: 29_000,
      modelId: "music_v2_5",
      method: "composeDetailed",
      promptUsed: null,
      briefHash: "b",
      createdAt: AT,
      check: oldCheck,
      attempts: 1,
      offsetMs: 0,
    };
    expect(MusicMeta.parse(oldMusic).check).toEqual({
      ...oldCheck,
      keyDetected: null,
      barOffsetMs: null,
      barConfidence: null,
      stereoCorrelation: null,
      lowCorrelation: null,
      integratedLufs: null,
      truePeakDbtp: null,
    });
    const measured = {
      ...oldCheck,
      keyDetected: { root: 9, minor: true, confidence: 0.4 },
      barOffsetMs: 500,
      barConfidence: 0.6,
      stereoCorrelation: 0.99,
      lowCorrelation: 1,
      integratedLufs: -12.2,
      truePeakDbtp: -1.6,
    };
    expect(MusicMeta.parse({ ...oldMusic, check: measured }).check).toEqual(measured);
    expect(() =>
      MusicMeta.parse({
        ...oldMusic,
        check: { ...measured, keyDetected: { root: 12, minor: true, confidence: 1 } },
      }),
    ).toThrow();

    const oldMix = { ...fixtureAudioManifest, mix: { src: "soundtrack.wav", durationMs: 28_000 } };
    expect(AudioManifest.parse(oldMix).mix).toEqual({
      src: "soundtrack.wav",
      durationMs: 28_000,
      integratedLufs: null,
      truePeakDbtp: null,
      masterGainDb: null,
    });
    const mastered = {
      src: "soundtrack.wav",
      durationMs: 28_000,
      integratedLufs: -14,
      truePeakDbtp: -1,
      masterGainDb: 0.8,
    };
    expect(AudioManifest.parse({ ...oldMix, mix: mastered }).mix).toEqual(mastered);
  });

  it("QA: нові види зауважень", () => {
    expect(AutoIssueKind.options).toEqual(expect.arrayContaining(["static_hold", "event_unused"]));
    expect(QaIssueKind.options).toEqual(
      expect.arrayContaining([
        "static_hold",
        "placeholder",
        "dead_half",
        "weak_moment",
        "off_brief",
        "text_too_fast",
        // лишаються для старих даних
        "late_text",
        "too_much_text",
      ]),
    );
  });
});

describe("Крок 0 «прогалини якості»: сумісність зі старими даними", () => {
  /** Об'єкт без поля — як у JSON до цього кроку. */
  const without = <T extends object>(value: T, ...keys: string[]): unknown => {
    const copy = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
    for (const k of keys) delete copy[k];
    return copy;
  };

  it("старий storyboard без throughline парситься з null; новий зберігає об'єкт", () => {
    expect(Storyboard.parse(without(fixtureStoryboard, "throughline")).throughline).toBeNull();
    const throughline = {
      object: "the teal dot",
      states: [
        { sceneId: "s1", state: "a dot on the address bar; becomes the scan line" },
        { sceneId: "s2", state: "the scan line; folds into the price tag" },
      ],
    };
    roundTrip(Storyboard, { ...fixtureStoryboard, throughline });
    expect(() =>
      Storyboard.parse({ ...fixtureStoryboard, throughline: { object: "x", states: [] } }),
    ).toThrow();
  });

  it("старий бренд-кіт без files парситься з []; local зберігає файли", () => {
    const kit = JSON.parse(JSON.stringify(fixtureBrandKitFile));
    delete kit.typography.heading.files;
    delete kit.typography.body.files;
    const parsed = BrandKitFile.parse(kit);
    expect(parsed.typography.heading.files).toEqual([]);
    expect(parsed.typography.body.files).toEqual([]);
    const local = {
      family: "Brand Grotesk",
      weights: [400, 700],
      origin: "local" as const,
      files: [
        {
          weight: 400,
          style: "normal" as const,
          format: "woff2" as const,
          path: "crawl/fonts/brandgrotesk-400.woff2",
        },
        {
          weight: 700,
          style: "normal" as const,
          format: "woff2" as const,
          path: "crawl/fonts/brandgrotesk-700.woff2",
        },
      ],
    };
    roundTrip(BrandKitFile, {
      ...fixtureBrandKitFile,
      typography: { ...fixtureBrandKitFile.typography, heading: local },
    });
  });

  it("старий site.json без fontFaces парситься з []", () => {
    const site = JSON.parse(JSON.stringify(fixtureSiteData));
    delete site.design.fontFaces;
    expect(SiteData.parse(site).design?.fontFaces).toEqual([]);
    const face = {
      family: "Brand Grotesk",
      weight: 400,
      style: "normal" as const,
      format: "woff2" as const,
      url: "https://zerno.example.com/fonts/brand.woff2",
      unicodeRange: "U+0400-04FF",
      path: null,
    };
    const design = fixtureSiteData.design;
    if (!design) throw new Error("fixtureSiteData без design");
    roundTrip(SiteData, { ...fixtureSiteData, design: { ...design, fontFaces: [face] } });
  });
});

describe("Крок 0 «акаунти»: ownerId адитивний", () => {
  it("старі project.json та intake.json без ownerId парсяться, новий ownerId зберігається", () => {
    const { ownerId: _absent, ...oldProject } = fixtureProject();
    expect(ProjectState.parse(oldProject).ownerId).toBeUndefined();
    expect(ProjectState.parse({ ...oldProject, ownerId: "u_owner001" }).ownerId).toBe("u_owner001");
    const oldIntake = {
      projectId: "p1",
      createdAt: AT,
      input: { kind: "site", url: "https://zerno.example.com/", manualText: null },
    };
    const intake = IntakeFile.parse(oldIntake);
    expect(intake.ownerId).toBeUndefined();
    expect(intake.photos).toEqual([]);
    expect(IntakeFile.parse({ ...oldIntake, ownerId: "u_owner001" }).ownerId).toBe("u_owner001");
  });
});

describe("toStrictJsonSchema", () => {
  // AudioPlan — збережений план; LLM-схема стадії — AudioPlanDraft у @adc/audio.
  const llmSchemas = { BrandKit, BrandKitPatch, Storyboard, QaReport, RevisionPlan, ChatIntent };

  for (const [name, schema] of Object.entries(llmSchemas)) {
    it(`${name}: strict, enums kept, no open objects`, () => {
      const json = toStrictJsonSchema(schema);
      const visit = (node: unknown): void => {
        if (!node || typeof node !== "object") return;
        const n = node as Record<string, unknown>;
        if (n.type === "object" || (Array.isArray(n.type) && n.type.includes("object"))) {
          expect(n.additionalProperties).toBe(false);
          expect(Object.keys(n.properties as object).sort()).toEqual([...(n.required as string[])].sort());
        }
        for (const banned of ["minimum", "maximum", "minLength", "maxLength", "pattern", "maxItems"]) {
          expect(n).not.toHaveProperty(banned);
        }
        for (const v of Object.values(n)) {
          if (Array.isArray(v)) v.forEach(visit);
          else visit(v);
        }
      };
      visit(json);
    });
  }

  it("keeps enum and const", () => {
    const json = toStrictJsonSchema(Storyboard) as { properties: Record<string, Record<string, unknown>> };
    expect(json.properties.fps?.const).toBe(30);
    const scene = (
      json.properties.scenes as { items: { properties: Record<string, Record<string, unknown>> } }
    ).items;
    expect(scene.properties.purpose?.enum).toContain("cta");
  });

  it("rejects records and unknown", () => {
    expect(() => toStrictJsonSchema(zod.object({ m: zod.record(zod.string(), zod.string()) }))).toThrow(
      UnsupportedSchemaError,
    );
    expect(() => toStrictJsonSchema(zod.object({ u: zod.unknown() }))).toThrow(UnsupportedSchemaError);
  });
});
