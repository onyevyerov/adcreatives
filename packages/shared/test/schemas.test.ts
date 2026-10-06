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
  BrandKit,
  BrandKitFile,
  BrandKitPatch,
  ChatEvent,
  ChatIntent,
  CheckReport,
  ClaimsReport,
  CostEvent,
  intentHasEdits,
  normalizeFormats,
  PipelineCounters,
  ProjectState,
  primaryFormat,
  QaReport,
  RevisionPlan,
  SiteData,
  StatsRow,
  Storyboard,
} from "../src/schemas/index.ts";
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
          factId: "f1",
          matchedContact: false,
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
      templateScenes: ["s1"],
      dirtyScenes: [],
    });
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
      units: { input: 1000, output: 500, cacheWrite: 0, cacheRead: 0 },
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

describe("toStrictJsonSchema", () => {
  const llmSchemas = { BrandKit, BrandKitPatch, Storyboard, AudioPlan, QaReport, RevisionPlan, ChatIntent };

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
