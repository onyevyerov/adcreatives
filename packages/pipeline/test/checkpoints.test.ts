import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CheckpointPayload,
  type ClaimsReport,
  type FilmReview,
  LocalStorage,
  projectPaths,
  type QaReport,
  type ReviewIssue,
  type Storyboard,
  t,
} from "@adc/shared";
import { fixtureProject, fixtureStoryboard } from "@adc/shared/fixtures";
import { describe, expect, it } from "vitest";
import {
  buildScriptCheckpoint,
  buildStoryboardCheckpoint,
  formatReviewWarning,
  formatSceneItems,
  reviewWarnings,
} from "../src/checkpoints.ts";

const NOW = "2026-10-06T10:00:00.000Z";

function claim(over: Partial<ClaimsReport["unverified"][number]>): ClaimsReport["unverified"][number] {
  return {
    sceneId: "s2",
    field: "headline",
    itemId: null,
    text: "-10%",
    kind: "percent",
    factId: null,
    matchedContact: false,
    matchedSite: false,
    ...over,
  };
}

async function scriptMessage(
  unverified: ClaimsReport["unverified"],
  storyboard: Storyboard = fixtureStoryboard,
) {
  const storage = new LocalStorage(mkdtempSync(path.join(tmpdir(), "adc-checkpoints-")));
  const project = fixtureProject({ status: "awaiting_script", brandkitVersion: 1 });
  const rp = projectPaths(project.id).rev(1);
  await storage.writeJson(rp.storyboard, storyboard);
  const claims: ClaimsReport = { checkedAt: NOW, brandkitVersion: 1, verified: [], unverified };
  await storage.writeJson(rp.claims, claims);
  const events = await buildScriptCheckpoint(storage, project, 1, NOW);
  const message = events[0];
  if (message?.type !== "message") throw new Error("немає повідомлення чекпоінта 2");
  return { text: message.text, events };
}

describe("чекпоінт 2: тексти items", () => {
  it("під рядком сцени — тексти items; непідтверджене в пункті позначене ⚠ біля пункту", async () => {
    const { text, events } = await scriptMessage([claim({ field: "item", itemId: "t3" })]);
    const lines = text.split("\n");
    const s2 = lines.findIndex((l) => l.startsWith("2. "));
    expect(lines[s2]).toContain("Капучино — 75 грн / -10% на каву з собою до 10:00");
    expect(lines[s2]).not.toContain("⚠");
    expect(lines[s2 + 1]).toBe("   · Спешелті еспресо з молоком · 75 грн · -10% ⚠");
    // Сцени без items — без додаткового рядка.
    const s1 = lines.findIndex((l) => l.startsWith("1. "));
    expect(lines[s1 + 1]?.startsWith("2. ")).toBe(true);
    expect(text).toContain("- ⚠ «-10%»");
    const checkpoint = events[1];
    expect(checkpoint?.type === "checkpoint" && checkpoint.payload.checkpoint === "script").toBe(true);
  });

  it("непідтверджене в headline/sub — ⚠ у рядку сцени, пункти без позначок", async () => {
    const { text } = await scriptMessage([claim({ field: "sub" })]);
    const lines = text.split("\n");
    const s2 = lines.findIndex((l) => l.startsWith("2. "));
    expect(lines[s2]?.endsWith(" ⚠")).toBe(true);
    expect(lines[s2 + 1]).toBe("   · Спешелті еспресо з молоком · 75 грн · -10%");
  });

  it("formatSceneItems: null без items; старі claims без itemId не позначають пункти", () => {
    expect(formatSceneItems({ id: "s1", items: [] }, [])).toBeNull();
    const scene = fixtureStoryboard.scenes[1] as (typeof fixtureStoryboard.scenes)[number];
    expect(formatSceneItems(scene, [claim({})])).toBe("· Спешелті еспресо з молоком · 75 грн · -10%");
  });
});

describe("чекпоінт 2: наскрізний об'єкт", () => {
  it("рядок «Наскрізний об'єкт: …» одразу під концептом, коли throughline є", async () => {
    const storyboard: Storyboard = {
      ...fixtureStoryboard,
      throughline: {
        object: "the teal dot",
        states: fixtureStoryboard.scenes.map((s) => ({ sceneId: s.id, state: "The dot carries over." })),
      },
    };
    const { text } = await scriptMessage([], storyboard);
    const lines = text.split("\n");
    const concept = lines.indexOf(`**${fixtureStoryboard.concept}**`);
    expect(concept).toBeGreaterThan(0);
    expect(lines[concept + 1]).toBe("Наскрізний об'єкт: the teal dot");
    expect(lines[concept + 2]).toBe("");
  });

  it("без throughline (старі розкадровки) — рядка немає", async () => {
    const { text } = await scriptMessage([], { ...fixtureStoryboard, throughline: null });
    const lines = text.split("\n");
    const concept = lines.indexOf(`**${fixtureStoryboard.concept}**`);
    expect(lines[concept + 1]).toBe("");
    expect(text).not.toContain("Наскрізний об'єкт");
  });
});

describe("чекпоінт 3: зауваження рецензента", () => {
  function issue(over: Partial<ReviewIssue>): ReviewIssue {
    return {
      scope: "scene",
      sceneId: "s1",
      nextSceneId: null,
      eventId: null,
      frame: null,
      format: null,
      severity: "major",
      kind: "low_contrast",
      description: "опис",
      fix: "інструкція",
      ...over,
    };
  }
  function filmReview(issues: ReviewIssue[]): FilmReview {
    return {
      version: 1,
      round: 1,
      inputsHash: "h",
      verdict: "fix",
      score: 7,
      issues,
      summary: "Історія читається, склейка 2→3 рве рух.",
      routes: { fix: [], sfx: [], music: 0 },
    };
  }
  async function storyboardMessage(review: FilmReview | string | null, templateScenes: string[] = []) {
    const storage = new LocalStorage(mkdtempSync(path.join(tmpdir(), "adc-checkpoints-")));
    const project = fixtureProject({ status: "awaiting_storyboard" });
    const rp = projectPaths(project.id).rev(1);
    await storage.writeJson(rp.storyboard, fixtureStoryboard);
    const qa: QaReport = {
      verdict: "pass",
      summary: "ok",
      issues: [
        {
          sceneId: "s1",
          format: "vertical",
          severity: "minor",
          kind: "low_contrast",
          description: "блідий підзаголовок",
          fix: "темніше",
        },
      ],
    };
    await storage.writeJson(rp.qa, qa);
    if (typeof review === "string") await storage.write(rp.review, review);
    else if (review) await storage.writeJson(rp.review, review);
    const events = await buildStoryboardCheckpoint(storage, project, 1, {
      templateScenes,
      changedScenes: null,
    });
    const message = events[0];
    if (message?.type !== "message") throw new Error("немає повідомлення чекпоінта 3");
    const checkpoint = events[1];
    if (checkpoint?.type !== "checkpoint") throw new Error("немає події чекпоінта 3");
    // Через схему події: payload.review має пережити ChatEvent.parse емітера.
    const payload = CheckpointPayload.parse(checkpoint.payload);
    if (payload.checkpoint !== "storyboard") throw new Error("не чекпоінт 3");
    return { text: message.text, payload };
  }

  it("major/critical з маршрутом, без minor і template-сцен; рядок оцінки; після попереджень QA", async () => {
    const review = filmReview([
      issue({ sceneId: "s1", kind: "low_contrast", description: "заголовок зливається з фоном" }),
      issue({
        scope: "join",
        sceneId: "s2",
        nextSceneId: "s3",
        severity: "critical",
        kind: "join_break",
        description: "крапка зникає на склейці",
      }),
      issue({ sceneId: "s2", kind: "sfx_missing", description: "удар без звуку" }),
      issue({ scope: "film", sceneId: null, kind: "music_mismatch", description: "трек млявий для бренду" }),
      issue({ sceneId: "s1", severity: "minor", description: "дрібниця" }),
      issue({ sceneId: "s3", kind: "sfx_level", description: "на template-сцені" }),
    ]);
    const { text, payload } = await storyboardMessage(review, ["s3"]);
    const lines = text.split("\n");
    const qaAt = lines.indexOf(t("qaWarnings", { count: 1 }));
    const header = lines.indexOf(t("reviewWarnings", { count: 4 }));
    expect(qaAt).toBeGreaterThan(0);
    expect(header).toBeGreaterThan(qaAt);
    expect(lines.slice(header + 1, header + 5)).toEqual([
      "- s1 [fix]: заголовок зливається з фоном",
      "- s2 → s3 [fix]: крапка зникає на склейці",
      "- s2 [sfx]: удар без звуку",
      "- [music]: трек млявий для бренду",
    ]);
    expect(text).not.toContain("дрібниця");
    expect(text).not.toContain("на template-сцені");
    expect(lines).toContain(t("reviewScore", { score: 7, summary: review.summary }));
    expect(text).toContain(t("templateScenesNote", { scenes: "s3" }));
    expect(payload.review?.score).toBe(7);
    expect(payload.review?.summary).toBe(review.summary);
    expect(payload.review?.issues.map((i) => [i.sceneId, i.route])).toEqual([
      ["s1", "fix"],
      ["s2", "fix"],
      ["s2", "sfx"],
      [null, "music"],
    ]);
    expect(payload.warnings).toHaveLength(1);
  });

  it("не більше 10 зауважень у тексті; лічильник — усі", async () => {
    const many = Array.from({ length: 12 }, (_, i) => issue({ description: `зауваження ${i + 1}` }));
    const { text } = await storyboardMessage(filmReview(many));
    expect(text).toContain(t("reviewWarnings", { count: 12 }));
    expect(text).toContain("зауваження 10");
    expect(text).not.toContain("зауваження 11");
  });

  it("pass без зауважень — лише рядок оцінки; без review.json чи з битим — як раніше", async () => {
    const clean = await storyboardMessage({ ...filmReview([]), verdict: "pass", score: 9 });
    expect(clean.text).not.toContain(t("reviewWarnings", { count: 0 }));
    expect(clean.text).toContain("Оцінка рецензента: 9/10");
    expect(clean.payload.review).toEqual({ score: 9, summary: expect.any(String), issues: [] });
    for (const review of [null, "{не json"]) {
      const { text, payload } = await storyboardMessage(review);
      expect(payload.review).toBeNull();
      expect(text).not.toContain("Оцінка рецензента");
      expect(text).not.toContain("Зауваження рецензента");
    }
  });

  it("reviewWarnings/formatReviewWarning: маршрут за типом, фільм без сцени", () => {
    const ws = reviewWarnings(
      { issues: [issue({ kind: "pace" }), issue({ kind: "music_level", sceneId: null, scope: "film" })] },
      [],
    );
    expect(ws.map((w) => w.route)).toEqual(["fix", "music"]);
    expect(ws.map(formatReviewWarning)).toEqual(["- s1 [fix]: опис", "- [music]: опис"]);
  });
});
