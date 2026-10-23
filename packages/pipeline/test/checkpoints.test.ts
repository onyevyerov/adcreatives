import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ChatEvent,
  type ChatEventInput,
  CheckpointPayload,
  type ClaimsReport,
  type FilmReview,
  type Format,
  LocalStorage,
  type Logger,
  noopLogger,
  projectPaths,
  type QaReport,
  type ReviewIssue,
  type Storyboard,
  t,
} from "@adc/shared";
import { fixtureBrandKitFile, fixtureProject, fixtureStoryboard } from "@adc/shared/fixtures";
import { describe, expect, it } from "vitest";
import {
  buildBrandCheckpoint,
  buildPreviewEvent,
  buildScriptCheckpoint,
  buildStoryboardCheckpoint,
  reviewWarnings,
} from "../src/checkpoints.ts";

const NOW = "2026-10-06T10:00:00.000Z";

/** Повідомлення і payload чекпоінта: payload — через схему події, як його пише емітер. */
function split(events: ChatEventInput[]) {
  const [message, checkpoint] = events;
  if (message?.type !== "message") throw new Error("немає повідомлення чекпоінта");
  if (checkpoint?.type !== "checkpoint") throw new Error("немає події чекпоінта");
  const lines = message.text.split("\n");
  // Витяжка без порожніх рядків-розділювачів.
  expect(lines.every((l) => l.trim() !== "")).toBe(true);
  return {
    text: message.text,
    lines,
    buttons: message.buttons,
    payload: CheckpointPayload.parse(checkpoint.payload),
  };
}

describe("чекпоінт 1: бренд", () => {
  it("у чаті — один рядок-відсилка до панелі; бренд-кіт, формати й мови — у payload", async () => {
    const storage = new LocalStorage(mkdtempSync(path.join(tmpdir(), "adc-checkpoints-")));
    const project = fixtureProject({
      status: "awaiting_brand",
      brandkitVersion: 1,
      formats: ["vertical", "square"],
    });
    await storage.writeJson(projectPaths(project.id).brandkit(1), fixtureBrandKitFile);
    const { lines, buttons, payload } = split(await buildBrandCheckpoint(storage, project, 1));
    expect(lines).toEqual([t("brandCheckpointShort")]);
    expect(buttons).toEqual(["approve", "edit"]);
    if (payload.checkpoint !== "brand") throw new Error("не чекпоінт 1");
    expect(payload.brandkit).toEqual(fixtureBrandKitFile);
    expect(payload.formats).toEqual(["vertical", "square"]);
    expect(payload.languageOptions.length).toBeGreaterThan(0);
  });
});

describe("чекпоінт 2: витяжка сценарію", () => {
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
  async function scriptCheckpoint(
    unverified: ClaimsReport["unverified"],
    storyboard: Storyboard = fixtureStoryboard,
  ) {
    const storage = new LocalStorage(mkdtempSync(path.join(tmpdir(), "adc-checkpoints-")));
    const project = fixtureProject({ status: "awaiting_script", brandkitVersion: 1 });
    const rp = projectPaths(project.id).rev(1);
    await storage.writeJson(rp.storyboard, storyboard);
    const claims: ClaimsReport = { checkedAt: NOW, brandkitVersion: 1, verified: [], unverified };
    await storage.writeJson(rp.claims, claims);
    const out = split(await buildScriptCheckpoint(storage, project, 1, NOW));
    if (out.payload.checkpoint !== "script") throw new Error("не чекпоінт 2");
    return { ...out, payload: out.payload };
  }

  it("усе підтверджено — один рядок: сцени, тривалість, жанр музики", async () => {
    const { lines, buttons } = await scriptCheckpoint([]);
    // 150 + 165 + 165 − 15 − 15 = 450 кадрів = 15 с.
    expect(lines).toEqual([
      t("scriptCheckpointSummary", { scenes: 3, seconds: "15", music: "lo-fi hip hop" }),
    ]);
    expect(buttons).toEqual(["approve", "edit"]);
  });

  it("musicNote (українською) замість жанру; дробова тривалість — з комою", async () => {
    const storyboard: Storyboard = {
      ...fixtureStoryboard,
      musicNote: "Теплий lo-fi, спокійний ранковий настрій",
      scenes: fixtureStoryboard.scenes.map((s) => (s.id === "s3" ? { ...s, durationFrames: 180 } : s)),
    };
    const { lines } = await scriptCheckpoint([], storyboard);
    expect(lines[0]).toBe(
      t("scriptCheckpointSummary", {
        scenes: 3,
        seconds: "15,5",
        music: "Теплий lo-fi, спокійний ранковий настрій",
      }),
    );
  });

  it("непідтверджені — другим рядком лічильник, без самих тверджень (вони в payload)", async () => {
    const unverified = [claim({ field: "item", itemId: "t3" }), claim({ field: "sub", text: "до 10:00" })];
    const { text, lines, payload } = await scriptCheckpoint(unverified);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe(t("scriptUnverifiedShort", { count: 2 }));
    expect(text).not.toContain("«-10%»");
    expect(text).not.toContain("до 10:00");
    expect(payload.claims.unverified).toEqual(unverified);
  });

  it("без концепту, headline, items, URL і наскрізного об'єкта в чаті — усе це в payload", async () => {
    const storyboard: Storyboard = {
      ...fixtureStoryboard,
      scenes: fixtureStoryboard.scenes.map((s, i) => ({
        ...s,
        text: { ...s.text, headline: `Roasted in-house ${i + 1}`, sub: "https://zerno.example.com/menu" },
      })),
      throughline: {
        object: "the teal dot",
        states: fixtureStoryboard.scenes.map((s) => ({ sceneId: s.id, state: "The dot carries over." })),
      },
    };
    const { text, lines, payload } = await scriptCheckpoint([claim({})], storyboard);
    expect(lines.length).toBeLessThanOrEqual(4);
    for (const gone of [
      "Roasted in-house",
      "http",
      fixtureStoryboard.concept,
      "Спешелті еспресо",
      "the teal dot",
      "BPM",
    ]) {
      expect(text).not.toContain(gone);
    }
    expect(payload.storyboard.concept).toBe(fixtureStoryboard.concept);
    expect(payload.storyboard.throughline?.object).toBe("the teal dot");
    expect(payload.storyboard.scenes.map((s) => s.text.headline)).toEqual([
      "Roasted in-house 1",
      "Roasted in-house 2",
      "Roasted in-house 3",
    ]);
    expect(payload.storyboard.scenes[1]?.items.map((i) => i.text)).toContain("Спешелті еспресо з молоком");
    expect(payload.musicBrief).toEqual(fixtureStoryboard.musicBrief);
    expect(payload.durationSeconds).toBe(15);
  });
});

describe("чекпоінт 3: витяжка розкадровки", () => {
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
  const QA_ISSUE: QaReport["issues"][number] = {
    sceneId: "s1",
    format: "vertical",
    severity: "minor",
    kind: "low_contrast",
    description: "блідий підзаголовок",
    fix: "темніше",
  };
  async function storyboardCheckpoint(
    review: FilmReview | string | null,
    opts: { templateScenes?: string[]; changedScenes?: string[] | null; qa?: QaReport["issues"] } = {},
  ) {
    const storage = new LocalStorage(mkdtempSync(path.join(tmpdir(), "adc-checkpoints-")));
    const project = fixtureProject({ status: "awaiting_storyboard" });
    const rp = projectPaths(project.id).rev(1);
    await storage.writeJson(rp.storyboard, fixtureStoryboard);
    const qa: QaReport = { verdict: "pass", summary: "ok", issues: opts.qa ?? [QA_ISSUE] };
    await storage.writeJson(rp.qa, qa);
    if (typeof review === "string") await storage.write(rp.review, review);
    else if (review) await storage.writeJson(rp.review, review);
    const events = await buildStoryboardCheckpoint(storage, project, 1, {
      templateScenes: opts.templateScenes ?? [],
      changedScenes: opts.changedScenes ?? null,
      preview: null,
    });
    const out = split(events);
    if (out.payload.checkpoint !== "storyboard") throw new Error("не чекпоінт 3");
    return { ...out, payload: out.payload };
  }

  it("підсумок, лічильник зауважень (QA + рецензент), оцінка, шаблонні сцени — без переліку", async () => {
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
    const { text, lines, buttons, payload } = await storyboardCheckpoint(review, { templateScenes: ["s3"] });
    expect(lines).toEqual([
      t("storyboardCheckpointSummary", { scenes: 3 }),
      t("storyboardIssuesShort", { count: 5, qa: 1, review: 4 }),
      t("storyboardScoreShort", { score: 7 }),
      t("templateScenesNote", { scenes: "s3" }),
    ]);
    expect(buttons).toEqual(["approve", "edit"]);
    for (const gone of [
      "заголовок зливається",
      "крапка зникає",
      "удар без звуку",
      "трек млявий",
      "блідий підзаголовок",
      review.summary,
    ]) {
      expect(text).not.toContain(gone);
    }
    // Прибране з чату — у payload: зауваження з маршрутом, резюме рецензента, попередження QA.
    expect(payload.review?.score).toBe(7);
    expect(payload.review?.summary).toBe(review.summary);
    expect(payload.review?.issues.map((i) => [i.sceneId, i.route, i.description])).toEqual([
      ["s1", "fix", "заголовок зливається з фоном"],
      ["s2", "fix", "крапка зникає на склейці"],
      ["s2", "sfx", "удар без звуку"],
      [null, "music", "трек млявий для бренду"],
    ]);
    expect(payload.warnings.map((w) => w.description)).toEqual(["блідий підзаголовок"]);
    expect(payload.templateScenes).toEqual(["s3"]);
  });

  it("лічильник — усі зауваження, у payload — усі без обрізання", async () => {
    const many = Array.from({ length: 12 }, (_, i) => issue({ description: `зауваження ${i + 1}` }));
    const { lines, text, payload } = await storyboardCheckpoint(filmReview(many), { qa: [] });
    expect(lines[1]).toBe(t("storyboardIssuesShort", { count: 12, qa: 0, review: 12 }));
    expect(text).not.toContain("зауваження 1");
    expect(payload.review?.issues).toHaveLength(12);
  });

  it("без зауважень — підсумок і оцінка; без review.json чи з битим — лише підсумок", async () => {
    const clean = await storyboardCheckpoint({ ...filmReview([]), verdict: "pass", score: 9 }, { qa: [] });
    expect(clean.lines).toEqual([
      t("storyboardCheckpointSummary", { scenes: 3 }),
      t("storyboardScoreShort", { score: 9 }),
    ]);
    expect(clean.payload.review).toEqual({ score: 9, summary: expect.any(String), issues: [] });
    for (const review of [null, "{не json"]) {
      const { lines, payload } = await storyboardCheckpoint(review, { qa: [] });
      expect(payload.review).toBeNull();
      expect(lines).toEqual([t("storyboardCheckpointSummary", { scenes: 3 })]);
    }
  });

  it("після правки — кількість змінених сцен (кадри лише їх)", async () => {
    const { lines, payload } = await storyboardCheckpoint(null, { changedScenes: ["s2"], qa: [] });
    expect(lines).toEqual([t("storyboardCheckpointSummary", { scenes: 1 })]);
    expect(payload.changedScenes).toEqual(["s2"]);
  });

  it("reviewWarnings: маршрут за типом, без minor і template-сцен", () => {
    const ws = reviewWarnings(
      {
        issues: [
          issue({ kind: "pace" }),
          issue({ kind: "music_level", sceneId: null, scope: "film" }),
          issue({ severity: "minor" }),
          issue({ sceneId: "s3" }),
        ],
      },
      ["s3"],
    );
    expect(ws.map((w) => [w.sceneId, w.route])).toEqual([
      ["s1", "fix"],
      [null, "music"],
    ]);
  });
});

describe("чекпоінт 3: таймінг сцен і відео-превʼю", () => {
  function setup() {
    const storage = new LocalStorage(mkdtempSync(path.join(tmpdir(), "adc-checkpoints-")));
    const project = fixtureProject({ status: "awaiting_storyboard" });
    return { storage, project, rp: projectPaths(project.id).rev(1) };
  }
  function recordingLogger() {
    const warns: Array<{ msg: string; meta: unknown }> = [];
    const logger: Logger = {
      ...noopLogger,
      warn: (msg, meta) => {
        warns.push({ msg, meta });
      },
    };
    return { logger, warns };
  }
  /** Подія чекпоінта 3 через схему чату (як її пише емітер). */
  async function checkpointPayload(
    storage: LocalStorage,
    project: ReturnType<typeof fixtureProject>,
    opts: Parameters<typeof buildStoryboardCheckpoint>[3],
  ) {
    const events = await buildStoryboardCheckpoint(storage, project, 1, opts);
    const parsed = ChatEvent.parse({ ...events[1], at: NOW });
    if (parsed.type !== "checkpoint" || parsed.payload.checkpoint !== "storyboard") {
      throw new Error("не чекпоінт 3");
    }
    return parsed.payload;
  }

  it("timeline — для всіх сцен (і після правки), з перекриттям переходів; preview — формат", async () => {
    const { storage, project, rp } = setup();
    await storage.writeJson(rp.storyboard, fixtureStoryboard);
    const payload = await checkpointPayload(storage, project, {
      templateScenes: [],
      changedScenes: ["s2"],
      preview: "vertical",
    });
    // 30 fps: s1 150 кадрів; s2 і s3 по 165 з переходом 15 → старт s2 = 150 − 15 = 135 кадрів.
    expect(payload.timeline).toEqual([
      { sceneId: "s1", fromMs: 0, durationMs: 5000 },
      { sceneId: "s2", fromMs: 4500, durationMs: 5500 },
      { sceneId: "s3", fromMs: 9500, durationMs: 5500 },
    ]);
    expect(payload.preview).toEqual({ format: "vertical" });
    expect(payload.changedScenes).toEqual(["s2"]);
  });

  it("без превʼю — preview: null; timeline однаково є", async () => {
    const { storage, project, rp } = setup();
    await storage.writeJson(rp.storyboard, fixtureStoryboard);
    const payload = await checkpointPayload(storage, project, {
      templateScenes: [],
      changedScenes: null,
      preview: null,
    });
    expect(payload.preview).toBeNull();
    expect(payload.timeline).toHaveLength(3);
  });

  it("таймінг не порахувався (TimelineError) — timeline: [] і попередження в лог, чекпоінт є", async () => {
    const { storage, project, rp } = setup();
    const broken: Storyboard = {
      ...fixtureStoryboard,
      scenes: fixtureStoryboard.scenes.map((s) => (s.id === "s2" ? { ...s, transitionFrames: 160 } : s)),
    };
    await storage.writeJson(rp.storyboard, broken);
    const { logger, warns } = recordingLogger();
    const payload = await checkpointPayload(storage, project, {
      templateScenes: [],
      changedScenes: null,
      preview: "vertical",
      logger,
    });
    expect(payload.timeline).toEqual([]);
    expect(payload.preview).toEqual({ format: "vertical" });
    expect(warns).toEqual([
      { msg: expect.stringContaining("таймінг"), meta: expect.objectContaining({ projectId: project.id }) },
    ]);
  });
});

describe("подія відео-превʼю ЧП3", () => {
  async function previewEvent(opts: { ok: boolean; mp4: boolean; format?: Format }) {
    const storage = new LocalStorage(mkdtempSync(path.join(tmpdir(), "adc-checkpoints-")));
    const project = fixtureProject({ status: "awaiting_storyboard", formats: ["vertical", "square"] });
    const format = opts.format ?? "vertical";
    const key = projectPaths(project.id).rev(2).render(format);
    if (opts.mp4) await storage.write(key, "mp4");
    const ev = await buildPreviewEvent(storage, project, 2, format, opts.ok);
    // Через схему чату: подія має пережити ChatEvent.parse емітера.
    return { event: ChatEvent.parse({ ...ev, at: NOW }), url: storage.publicUrl(key) };
  }

  it("ok і mp4 є — ready з URL файлу", async () => {
    const { event, url } = await previewEvent({ ok: true, mp4: true, format: "square" });
    expect(event).toEqual({ type: "preview", at: NOW, rev: 2, format: "square", state: "ready", url });
    expect(url).toMatch(/^\/files\/.+\/rev\/2\/renders\/square\.mp4$/);
  });

  it("ok, але mp4 немає — failed без URL", async () => {
    const { event } = await previewEvent({ ok: true, mp4: false });
    expect(event).toMatchObject({ type: "preview", rev: 2, format: "vertical", state: "failed", url: null });
  });

  it("рендер упав (ok: false) — failed, навіть якщо старий mp4 лежить", async () => {
    const { event } = await previewEvent({ ok: false, mp4: true });
    expect(event).toMatchObject({ state: "failed", url: null });
  });
});
