import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { makeGradientPng } from "@adc/render/testing";
import {
  emptyCounters,
  FilmReview,
  type FilmReviewDraft,
  GRID_SOUND_CUES,
  type LocalStorage,
  type LogMeta,
  noopLogger,
  type ReviewIssue,
  readTuning,
  revPaths,
  SoundCue,
  StageError,
  Storyboard,
} from "@adc/shared";
import { fixtureStoryboard } from "@adc/shared/fixtures";
import { describe, expect, it } from "vitest";
import {
  createReviewStage,
  NO_SOUND_SHEET,
  reviewStage,
  routesOf,
  sanitizeIssues,
} from "../src/stages/review.ts";
import { makeCtx, type Reply, seedProject, systemText, tmpStorage, userText } from "./helpers.ts";

const FIXTURES = path.join(import.meta.dirname, "fixtures", "review");
const COLORS: Record<string, [string, string]> = {
  s1: ["#6B3E26", "#E85D2A"],
  s2: ["#1D3557", "#A8DADC"],
  s3: ["#2A9D8F", "#E9C46A"],
};

/** Розкадровка «Зерна» з подіями фікстури рецензента. */
function reviewStoryboard(): Storyboard {
  const sb = structuredClone(fixtureStoryboard);
  const events = JSON.parse(readFileSync(path.join(FIXTURES, "events.json"), "utf8")) as Record<
    string,
    unknown
  >;
  for (const scene of sb.scenes) (scene as { events: unknown }).events = events[scene.id] ?? [];
  return Storyboard.parse(sb);
}

interface SeedRevOptions {
  /** Звукова відомість зведення (дефолт — є). */
  soundSheet?: boolean;
  sfxPlan?: boolean;
  templates?: string[];
}

/**
 * Ревізія після зведення: розкадровка, check.json зі стрічками обох форматів, загальними аркушами й
 * аркушами моментів (s1, s2 у vertical), відомість звуку, план звукорежисера, qa.json.
 */
async function seedRev(storage: LocalStorage, rev: number, opts: SeedRevOptions = {}): Promise<void> {
  const rp = revPaths("p1", rev);
  await storage.writeJson(rp.storyboard, reviewStoryboard());
  const raw = readFileSync(path.join(FIXTURES, "check.json"), "utf8").replaceAll("REV/", `${rp.root}/`);
  const check = JSON.parse(raw) as {
    stills: Array<{ sceneId: string; format: "vertical" | "square"; path: string }>;
    sheets: Array<{ format: string; path: string }>;
    moments: Array<{ sceneId: string; path: string }>;
  };
  await storage.writeJson(rp.check, check);
  for (const s of check.stills) {
    const [a, b] = COLORS[s.sceneId] ?? ["#000000", "#ffffff"];
    await storage.write(s.path, makeGradientPng(90, 160, a, b));
    await storage.write(rp.stripSheet(s.format, s.sceneId), makeGradientPng(200, 120, a, b));
  }
  for (const s of check.sheets) await storage.write(s.path, makeGradientPng(300, 200, "#111111", "#eeeeee"));
  for (const m of check.moments) {
    const [a, b] = COLORS[m.sceneId] ?? ["#000000", "#ffffff"];
    await storage.write(m.path, makeGradientPng(240, 150, b, a));
  }
  if (opts.soundSheet !== false) {
    await storage.write(rp.soundSheet, readFileSync(path.join(FIXTURES, "sound-sheet.json")));
  }
  if (opts.sfxPlan !== false) {
    await storage.writeJson(rp.sfxPlan, {
      version: 1,
      inputsHash: "sfx-hash",
      sceneIds: ["s1", "s2", "s3"],
      decisions: [
        {
          sceneId: "s2",
          eventId: "coins",
          sound: { cue: "cash", accent: "hard" },
          reason: "Coins drop into the cup.",
        },
      ],
      notes: "Три удари: чашка, ціна, кнопка; монети — підпис бренду.",
    });
  }
  await storage.writeJson(rp.qa, {
    verdict: "pass",
    issues: [
      {
        sceneId: "s2",
        format: "square",
        severity: "minor",
        kind: "overlap",
        description: "бейдж трохи заходить на ціну",
        fix: "зсунь бейдж",
      },
    ],
    summary: "Showreel bar 3.8/5",
  });
  if (opts.templates) {
    await storage.writeJson(rp.pipeline, { ...emptyCounters(), templateScenes: opts.templates });
  }
}

const issue = (over: Partial<ReviewIssue> & Pick<ReviewIssue, "kind">): ReviewIssue => ({
  scope: "scene",
  sceneId: "s1",
  nextSceneId: null,
  eventId: null,
  frame: null,
  format: null,
  severity: "major",
  description: `${over.kind}: опис`,
  fix: `${over.kind}: інструкція`,
  fixSceneId: null,
  ...over,
});

const reply = (issues: ReviewIssue[], verdict: FilmReviewDraft["verdict"] = "pass", score = 7): Reply => ({
  json: { verdict, score, issues, summary: "Ролик тримається, склейка s1→s2 рве чашку." },
});

function callImages(params: unknown): number {
  const p = params as { messages: Array<{ content: Array<{ type: string }> }> };
  return (p.messages[0]?.content ?? []).filter((c) => c.type === "image").length;
}

async function readReview(storage: LocalStorage, rev = 1): Promise<FilmReview> {
  return storage.readJson(revPaths("p1", rev).review, (v) => FilmReview.parse(v));
}

async function readHistory(storage: LocalStorage, round: number, rev = 1): Promise<FilmReview> {
  return storage.readJson(revPaths("p1", rev).reviewHistory(round), (v) => FilmReview.parse(v));
}

/** Стадія з режимом склейок `ADC_REVIEW_JOIN_SIDE`, решта перемикачів — дефолт. */
const stageWith = (reviewJoinSide: "both" | "one") =>
  createReviewStage({ tuning: () => ({ ...readTuning({}), reviewJoinSide }) });

function captureWarnings(ctx: { logger: typeof noopLogger }): Array<{ msg: string; meta?: LogMeta }> {
  const warnings: Array<{ msg: string; meta?: LogMeta }> = [];
  ctx.logger = {
    ...noopLogger,
    warn: (msg, meta) => {
      warnings.push(meta ? { msg, meta } : { msg });
    },
  };
  return warnings;
}

/** Відповідь моделі для першого тесту: склейка, звук, музика, невідома сцена, кадр поза сценою. */
const MIXED: ReviewIssue[] = [
  issue({ scope: "join", sceneId: "s1", kind: "join_break", frame: 149 }),
  issue({ sceneId: "s3", eventId: "cta-in", kind: "sfx_level" }),
  issue({ sceneId: "s2", eventId: "coins", kind: "sfx_missing", severity: "minor" }),
  issue({ scope: "film", sceneId: null, kind: "music_level", severity: "minor" }),
  issue({ sceneId: "s9", kind: "off_brief" }),
  issue({ sceneId: "s3", kind: "weak_moment", severity: "minor", frame: 999 }),
];

describe("reviewStage", () => {
  it("пише review.json: маршрути й вердикт коду, join — обидві сцени, невідомі сцени відкинуто", async () => {
    const storage = tmpStorage();
    await seedProject(storage, { storyboard: null });
    await seedRev(storage, 1);
    const ctx = makeCtx(storage, "review", { round: 0 }, [reply(MIXED, "pass", 6)]);
    const warnings = captureWarnings(ctx);
    const res = await reviewStage(ctx);

    expect(ctx.anthropic.calls).toHaveLength(1);
    expect(res.reused).toBeUndefined();
    expect(res.artifacts).toEqual([revPaths("p1", 1).review]);
    // модель сказала pass, але join_break major і sfx_level major → fix
    expect(res.outputs).toEqual({
      verdict: "fix",
      score: 6,
      routes: { fix: ["s1", "s2"], sfx: ["s3"], music: 1 },
    });

    const review = await readReview(storage);
    expect(review).toMatchObject({
      version: 1,
      round: 0,
      verdict: "fix",
      score: 6,
      inputsHash: res.inputsHash,
    });
    expect(review.summary).toBe("Ролик тримається, склейка s1→s2 рве чашку.");
    expect(review.issues.map((i) => `${i.kind}:${i.sceneId}`)).toEqual([
      "join_break:s1",
      "sfx_level:s3",
      "sfx_missing:s2",
      "music_level:null",
      "weak_moment:s3",
    ]);
    // join без nextSceneId отримує наступну сцену; кадр поза сценою → null
    expect(review.issues[0]).toMatchObject({ scope: "join", sceneId: "s1", nextSceneId: "s2", frame: 149 });
    expect(review.issues[4]?.frame).toBeNull();
    expect(warnings.find((w) => w.msg.startsWith("review: відкинуто"))?.meta).toEqual({
      dropped: ["unknown_scene: off_brief s9"],
    });

    const call = ctx.anthropic.calls[0]?.params;
    // головний формат: 3 стрічки + аркуші моментів s1, s2 + загальний аркуш square
    expect(callImages(call)).toBe(6);
    const text = userText(call);
    expect(text).toContain("Image 1: scene s1, format vertical, strip of 10 frames");
    expect(text).toContain("Image 2: Moment sheet · scene s1 · vertical");
    expect(text).toContain("- join: 148 · 4.93s | 149 · 4.97s → next scene frames 0 | 1 | 2");
    expect(text).toContain("Image 5: scene s3, format vertical");
    expect(text).toContain("Image 6: contact sheet of the whole film, format square");
    expect(text).not.toContain("Image 7:");
    expect(text).not.toContain("format square, strip");
    // відомість звуку текстом, нотатки звукорежисера, відкриті зауваження QA
    expect(text).toContain("events: scene | event | cue/accent | frame");
    expect(text).toContain("s3 | cta-in | slam/hard | 315 | 0.0 | -34.5 | no | none");
    expect(text).not.toContain(NO_SOUND_SHEET);
    expect(text).toContain("Три удари: чашка, ціна, кнопка; монети — підпис бренду.");
    expect(text).toContain("- [minor, square, overlap] s2: бейдж трохи заходить на ціну");
    expect(text).toContain("<previous_review>\n(none)\n</previous_review>");
    // розкадровка з ефективним звуком (план звукорежисера) і місцем сцени в ролику
    expect(text).toMatch(/"id": "coins",[\s\S]*?"sound": "cash"/);
    expect(text).toMatch(
      /"id": "s3",[\s\S]*?"startFrame": 285,\s*"startSec": 9.5,\s*"musicMix": "breakdown"/,
    );
    expect(text).toContain("Template scenes (do not judge): (none).");
    expect(text).toContain("Review round: 0.");
    const system = systemText(call);
    expect(system).toContain("You are the studio's head director.");
    const grid = SoundCue.options.filter((c) => GRID_SOUND_CUES.has(c));
    expect(grid.length).toBeGreaterThan(0);
    expect(system).toContain(`(\`${grid.join(", ")}\` snap to the half-beat grid`);
    expect(system).toContain("in the language of the video (uk)");
    expect(ctx.emitted.events.filter((e) => e.type === "progress")).toEqual([
      expect.objectContaining({ stage: "review", step: "review", label: "Рецензент дивиться ролик" }),
    ]);
  });

  it("лише minor і музика → pass навіть якщо модель сказала fix; minor не тягне сцену на коло", async () => {
    const storage = tmpStorage();
    await seedProject(storage, { storyboard: null });
    await seedRev(storage, 1);
    const ctx = makeCtx(storage, "review", { round: 0 }, [
      reply(
        [
          issue({ sceneId: "s2", kind: "pace", severity: "minor" }),
          issue({ scope: "film", sceneId: null, kind: "music_mismatch", severity: "critical" }),
        ],
        "fix",
        8,
      ),
    ]);
    const res = await reviewStage(ctx);
    expect(res.outputs).toEqual({ verdict: "pass", score: 8, routes: { fix: [], sfx: [], music: 1 } });
  });

  it("без звукової відомості: промпт попереджає, sfx_*/music_* відфільтровано з логом", async () => {
    const storage = tmpStorage();
    await seedProject(storage, { storyboard: null });
    await seedRev(storage, 1, { soundSheet: false, sfxPlan: false });
    const ctx = makeCtx(storage, "review", { round: 0 }, [
      reply([
        issue({ sceneId: "s3", eventId: "cta-in", kind: "sfx_level", severity: "critical" }),
        issue({ scope: "film", sceneId: null, kind: "music_mismatch" }),
        issue({ scope: "join", sceneId: "s2", nextSceneId: "s3", kind: "join_break" }),
      ]),
    ]);
    const warnings = captureWarnings(ctx);
    const res = await reviewStage(ctx);

    const text = userText(ctx.anthropic.calls[0]?.params);
    expect(text).toContain(`<sound_sheet>\n${NO_SOUND_SHEET}\n</sound_sheet>`);
    expect(text).toContain("<sfx_notes>\n(none)\n</sfx_notes>");
    expect(res.outputs).toEqual({
      verdict: "fix",
      score: 7,
      routes: { fix: ["s2", "s3"], sfx: [], music: 0 },
    });
    expect((await readReview(storage)).issues.map((i) => i.kind)).toEqual(["join_break"]);
    expect(warnings.map((w) => w.msg)).toContain("review: немає звукової відомості — звук не оцінюється");
    expect(warnings.find((w) => w.msg.startsWith("review: відкинуто"))?.meta).toEqual({
      dropped: ["no_sound_sheet: sfx_level s3, event cta-in", "no_sound_sheet: music_mismatch film"],
    });
  });

  it("повтор із тими самими входами — reused без виклику; нове коло — новий виклик із попередніми зауваженнями", async () => {
    const storage = tmpStorage();
    await seedProject(storage, { storyboard: null });
    await seedRev(storage, 1);
    const first = await reviewStage(makeCtx(storage, "review", { round: 0 }, [reply(MIXED)]));
    const r0 = await readReview(storage);
    expect(await readHistory(storage, 0)).toEqual(r0);

    // перевикористана рецензія теж пише історію (знімок стерто — повтор його відновлює)
    rmSync(storage.absPath(revPaths("p1", 1).reviewHistory(0)));
    const again = makeCtx(storage, "review", { round: 0 }, []);
    const second = await reviewStage(again);
    expect(again.anthropic.calls).toHaveLength(0);
    expect(second.reused).toBe(true);
    expect(second.inputsHash).toBe(first.inputsHash);
    expect(second.outputs).toEqual(first.outputs);
    expect(await readHistory(storage, 0)).toEqual(r0);

    // коло 1: інші входи (round) → виклик; модель бачить зауваження кола 0
    const round1 = makeCtx(storage, "review", { round: 1 }, [reply([], "pass", 9)]);
    const third = await reviewStage(round1);
    expect(round1.anthropic.calls).toHaveLength(1);
    const text = userText(round1.anthropic.calls[0]?.params);
    expect(text).toMatch(
      /<previous_review>\n- \[join_break, major\] join s1 → s2, frame 149: join_break: опис → join_break: інструкція\n/,
    );
    expect(text).toContain("Review round: 1.");
    expect(third.outputs).toEqual({ verdict: "pass", score: 9, routes: { fix: [], sfx: [], music: 0 } });
    expect((await readReview(storage)).round).toBe(1);
    // історія кіл: review-r0.json і review-r1.json, r0 не перезаписано колом 1
    expect(await readHistory(storage, 0)).toEqual(r0);
    expect(await readHistory(storage, 1)).toEqual(await readReview(storage));

    // повтор кола 1 — reused, хоча review.json тепер уже кола 1
    const round1Again = makeCtx(storage, "review", { round: 1 }, []);
    const fourth = await reviewStage(round1Again);
    expect(round1Again.anthropic.calls).toHaveLength(0);
    expect(fourth.reused).toBe(true);
    expect(fourth.inputsHash).toBe(third.inputsHash);

    // нова відомість звуку — нові входи
    const rp = revPaths("p1", 1);
    const sheet = JSON.parse(readFileSync(path.join(FIXTURES, "sound-sheet.json"), "utf8"));
    await storage.writeJson(rp.soundSheet, { ...sheet, integratedLufs: -12 });
    const changed = makeCtx(storage, "review", { round: 1 }, [reply([])]);
    expect((await reviewStage(changed)).reused).toBeUndefined();
    expect(changed.anthropic.calls).toHaveLength(1);
  });

  it("нова ревізія з тими самими входами бере рецензію ревізії-основи", async () => {
    const storage = tmpStorage();
    await seedProject(storage, { rev: 2, storyboard: null });
    await seedRev(storage, 1);
    await seedRev(storage, 2);
    const base = await reviewStage(makeCtx(storage, "review", { round: 0 }, [reply(MIXED)]));
    const ctx = makeCtx(storage, "review", { round: 0 }, [], { rev: 2 });
    const res = await reviewStage(ctx);
    expect(ctx.anthropic.calls).toHaveLength(0);
    expect(res.reused).toBe(true);
    expect(res.outputs).toEqual(base.outputs);
    expect(await readReview(storage, 2)).toEqual(await readReview(storage, 1));
    expect(await readHistory(storage, 0, 2)).toEqual(await readReview(storage, 1));
  });

  it("ADC_REVIEW_JOIN_SIDE=one: join лише в сцену fixSceneId, joinSide у review.json і в хеші входів", async () => {
    const issues = [
      issue({ scope: "join", sceneId: "s2", nextSceneId: "s3", fixSceneId: "s3", kind: "join_break" }),
      issue({ scope: "join", sceneId: "s1", fixSceneId: null, kind: "throughline_lost" }),
    ];
    const both = tmpStorage();
    await seedProject(both, { storyboard: null });
    await seedRev(both, 1);
    const resBoth = await stageWith("both")(makeCtx(both, "review", { round: 0 }, [reply(issues)]));
    expect(resBoth.outputs.routes.fix).toEqual(["s1", "s2", "s3"]);
    expect((await readReview(both)).joinSide).toBe("both");
    expect((await readReview(both)).issues.map((i) => i.fixSceneId)).toEqual(["s3", null]);

    const one = tmpStorage();
    await seedProject(one, { storyboard: null });
    await seedRev(one, 1);
    const resOne = await stageWith("one")(makeCtx(one, "review", { round: 0 }, [reply(issues)]));
    // s2→s3 править лише s3; склейка s1→s2 без fixSceneId — обидві сторони, як у both
    expect(resOne.outputs.routes.fix).toEqual(["s1", "s2", "s3"]);
    const reviewOne = await readReview(one);
    expect(reviewOne.joinSide).toBe("one");
    expect(await readHistory(one, 0)).toEqual(reviewOne);
    expect(resOne.inputsHash).not.toBe(resBoth.inputsHash);

    // з тими самими входами рецензію не перевикористати між режимами
    const switched = makeCtx(one, "review", { round: 0 }, [reply([issues[0] as ReviewIssue])]);
    const resSwitched = await stageWith("both")(switched);
    expect(resSwitched.reused).toBeUndefined();
    expect(switched.anthropic.calls).toHaveLength(1);
    expect(resSwitched.inputsHash).toBe(resBoth.inputsHash);
    expect(resSwitched.outputs.routes.fix).toEqual(["s2", "s3"]);

    const onlyJoin = tmpStorage();
    await seedProject(onlyJoin, { storyboard: null });
    await seedRev(onlyJoin, 1);
    const resOnly = await stageWith("one")(
      makeCtx(onlyJoin, "review", { round: 0 }, [reply([issues[0] as ReviewIssue])]),
    );
    expect(resOnly.outputs.routes.fix).toEqual(["s3"]);
  });

  it("дефолт (both) — хеш як без перемикача; старий review.json без нових полів читається як both і перевикористовується", async () => {
    const storage = tmpStorage();
    await seedProject(storage, { storyboard: null });
    await seedRev(storage, 1);
    const first = await stageWith("both")(makeCtx(storage, "review", { round: 0 }, [reply(MIXED)]));
    const rp = revPaths("p1", 1);
    const raw = (await storage.readJson(rp.review, (v) => v)) as Record<string, unknown> & {
      issues: Array<Record<string, unknown>>;
    };
    const { joinSide: _joinSide, ...old } = raw;
    await storage.writeJson(rp.review, {
      ...old,
      issues: old.issues.map(({ fixSceneId: _fixSceneId, ...i }) => i),
    });

    const again = makeCtx(storage, "review", { round: 0 }, []);
    const res = await reviewStage(again);
    expect(again.anthropic.calls).toHaveLength(0);
    expect(res.reused).toBe(true);
    expect(res.inputsHash).toBe(first.inputsHash);
    const read = await readReview(storage);
    expect(read.joinSide).toBe("both");
    expect(read.issues.every((i) => i.fixSceneId === null)).toBe(true);

    // той самий старий файл у режимі one — новий виклик
    const one = makeCtx(storage, "review", { round: 0 }, [reply([])]);
    expect((await stageWith("one")(one)).reused).toBeUndefined();
    expect(one.anthropic.calls).toHaveLength(1);
  });

  it("template-сцени: позначені в легенді, зауваження на них відкинуто, у маршрути не потрапляють", async () => {
    const storage = tmpStorage();
    await seedProject(storage, { storyboard: null });
    await seedRev(storage, 1, { templates: ["s3"] });
    const ctx = makeCtx(storage, "review", { round: 0 }, [
      reply([
        issue({ sceneId: "s3", kind: "clipped_text", severity: "critical" }),
        issue({ scope: "join", sceneId: "s2", nextSceneId: "s3", kind: "join_break" }),
        issue({ sceneId: "s3", eventId: "cta-in", kind: "sfx_wrong_cue" }),
      ]),
    ]);
    const warnings = captureWarnings(ctx);
    const res = await reviewStage(ctx);
    const text = userText(ctx.anthropic.calls[0]?.params);
    expect(text).toMatch(
      /Image 5: scene s3, format vertical, strip of 11 frames[^\n]*\(template scene: context only, do not judge\)/,
    );
    expect(text).toContain("Template scenes (do not judge): s3.");
    expect(text).toMatch(/"id": "s3",[\s\S]*?"template": true/);
    expect(res.outputs.routes).toEqual({ fix: ["s2"], sfx: [], music: 0 });
    expect((await readReview(storage)).issues.map((i) => i.kind)).toEqual(["join_break"]);
    expect(warnings.find((w) => w.msg.startsWith("review: відкинуто"))?.meta).toEqual({
      dropped: ["template_scene: clipped_text s3", "template_scene: sfx_wrong_cue s3, event cta-in"],
    });
  });

  it("без check.json — StageError check_missing (не retryable)", async () => {
    const storage = tmpStorage();
    await seedProject(storage, { storyboard: null });
    await storage.writeJson(revPaths("p1", 1).storyboard, reviewStoryboard());
    const err = await reviewStage(makeCtx(storage, "review", { round: 0 })).catch((e) => e);
    expect(err).toBeInstanceOf(StageError);
    expect(err).toMatchObject({ code: "check_missing", retryable: false });
  });
});

describe("маршрути рецензента", () => {
  const sb = reviewStoryboard();

  it("routesOf: join — обидві сторони, порядок розкадровки, film сцен не додає, minor не маршрутизується", () => {
    const routes = routesOf(
      sb,
      [
        issue({ scope: "join", sceneId: "s2", nextSceneId: "s3", kind: "throughline_lost" }),
        issue({ sceneId: "s1", kind: "rhythm" }),
        issue({ scope: "film", sceneId: null, kind: "pace" }),
        issue({ scope: "join", sceneId: "s1", nextSceneId: "s2", kind: "sfx_excess" }),
        issue({ sceneId: "s3", kind: "sfx_off_beat", severity: "minor" }),
        issue({ scope: "film", sceneId: null, kind: "music_mismatch", severity: "minor" }),
      ],
      new Set(),
    );
    expect(routes).toEqual({ fix: ["s1", "s2", "s3"], sfx: ["s1", "s2"], music: 1 });
  });

  it("sanitizeIssues: join — завжди з наступною сценою розкадровки (в останньої — без); film скидає сцену й кадр", () => {
    const { kept, dropped } = sanitizeIssues(
      sb,
      [
        issue({ scope: "join", sceneId: "s3", kind: "join_break" }),
        issue({ scope: "film", sceneId: "s2", frame: 10, kind: "pace" }),
        issue({ scope: "join", sceneId: "s1", nextSceneId: "s7", kind: "join_break" }),
      ],
      new Set(),
      true,
    );
    expect(dropped).toEqual([]);
    expect(kept.map((i) => [i.scope, i.sceneId, i.nextSceneId, i.frame])).toEqual([
      ["join", "s3", null, null],
      ["film", null, null, null],
      ["join", "s1", "s2", null],
    ]);
  });
});
