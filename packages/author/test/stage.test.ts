import { readLedger } from "@adc/director";
import {
  createPromptLoader,
  projectPaths,
  QA_LOG_PREFIX,
  readCosts,
  revPaths,
  StageError,
} from "@adc/shared";
import { fixtureAudioManifest } from "@adc/shared/fixtures";
import { describe, expect, it } from "vitest";
import { createDeadline, stopReason } from "../src/budget.ts";
import { AuthorReport, authorLogKey, authorReportKey, createAuthorStage } from "../src/index.ts";
import type { AuthorSession } from "../src/session.ts";
import { audioEventsTable, audioEventsTool } from "../src/tools/meta.ts";
import { cleanCode, unusedEventIds } from "../src/tools/writeScene.ts";
import {
  BAD_SCENE,
  examples,
  makeCtx,
  mockEngine,
  PROJECT_ID,
  seedProject,
  testTuning,
  tmpStorage,
  twoScenes,
} from "./helpers.ts";

/** Правила R1–R4, R6 (ТЗ «прогалини якості» §2.7) — у промпті дослівно. */
const FILM_RULES = [
  "Nothing enters at rest and nothing leaves at rest. An element is already moving on its first visible frame (it arrives from off-frame, from a smaller scale, from behind a mask or a colour field) and it leaves accelerating (`easings.in`-like, never slowing down and fading out in place). A hit may land up to one frame before its event frame, never after it: the landing is seen on the beat, the sound is on the event frame.",
  "In an interface mock nothing changes by itself. Every change of state (a field filling, a toggle, a row selected, a slider moved, a button pressed) is caused by the `Cursor`: it travels to the control (`path`), grows on arrival (`hoverAt`), squeezes on the click (`clickAt`), and the control reacts on that same frame. One cursor per scene, one action at a time; a mock that changes without the cursor is `off_brief`.",
  "`Camera` is the scene's virtual camera. It pushes into the active zone of a mock (the field being typed, the row being ticked) and pulls back out. Never two camera moves at once and never a camera move during a cursor move: the push starts after the cursor arrives, the pull-back after the control has reacted. Text that must be read stays inside the camera's rectangle for its reading time.",
  "`MotionBlur` wraps fast moves (a card flying in, a colour field pushing, kinetic text on an energetic brand) so they read as motion, not as a strobe. Use it on elements that travel more than about a quarter of the frame within six frames; never on text while it is being read; never on the whole scene; at most two `MotionBlur` wrappers active in one frame (each multiplies the render cost of its subtree by `samples`).",
  "Build the throughline literally. In every scene the object named in `<storyboard>.throughline` is on screen in the state its entry gives, and at the join it transforms into its next state (`MorphShape`, `DrawPath`, `LogoPath`, your own `<svg>`): the same geometry, colour and position on the last frame of one scene and the first frame of the next. When `throughline` is null, keep the match cuts as before.",
];
const FILM_CHECKLIST =
  "the throughline object is in the frame in its state and transforms at the join; every mock change is caused by the cursor; no two camera moves overlap";

const qaLine = `${QA_LOG_PREFIX}${JSON.stringify({ kind: "text_overflow", component: "Headline", detail: "too long", value: 30, frame: 30 })}`;

describe("authorStage", () => {
  it("2 сцени: guard-помилка виправлена, стрип з авто-перевірками, finish → done", async () => {
    const storage = tmpStorage();
    await seedProject(storage);
    const engine = mockEngine({ logs: { s1: [qaLine] } });
    const ctx = makeCtx(storage, { sceneIds: null, instructions: [] }, [
      { tool: "audio_events", input: {} },
      { tool: "write_scene", input: { sceneId: "s1", code: examples["hook-photo"] } },
      { tool: "write_scene", input: { sceneId: "s2", code: `\`\`\`tsx\n${BAD_SCENE}\n\`\`\`` } },
      { tool: "render_strip", input: { sceneId: "s2" } },
      (calls) => ({
        tool: "write_scene",
        input: {
          sceneId: "s2",
          code: calls.at(-2)?.text?.includes("REJECTED") ? examples["offer-price"] : BAD_SCENE,
        },
      }),
      { tool: "render_strip", input: { sceneId: "s1" } },
      { tool: "finish", input: { summary: "Фільм із двох сцен." } },
      { finish: "Готово." },
    ]);
    const stage = createAuthorStage({ engine: () => engine, tuning: () => testTuning() });
    const res = await stage(ctx);

    expect(res.outputs).toEqual({
      sceneIds: ["s1", "s2"],
      iterations: 7,
      renders: 10, // стрічка s1: 150 кадрів кожні 15 → 15…135 і 149
      usd: 0,
      stoppedBy: "done",
    });
    const texts = ctx.agent.calls.map((c) => c.text ?? "");
    expect(texts[0]).toContain("s2 | price-hit | 30 | 5.50 s | impact (hard)");
    expect(texts[1]).toContain("guard: ok.");
    expect(texts[1]).toContain("types: ok.");
    expect(texts[2]).toContain("guard: REJECTED");
    expect(texts[3]).toContain("error: s2: its current code fails the guard");
    expect(texts[4]).toContain("s2 saved as version v2");
    expect(texts[5]).toContain("strip of 10 frames");
    expect(texts[5]).toContain("text_overflow (Headline): too long");
    expect(ctx.agent.calls[5]?.images).toHaveLength(1);
    expect(engine.bundles).toHaveLength(2); // після правки s2 бандл перезібрано
    expect(engine.closed).toBe(1);

    // Журнал версій: origin author, відхилена версія не в video/scenes.
    const ledger = await readLedger(storage, PROJECT_ID, 1);
    expect(ledger.scenes.s2?.versions.map((v) => [v.v, v.origin, v.guardOk])).toEqual([
      [1, "author", false],
      [2, "author", true],
    ]);
    const rp = revPaths(PROJECT_ID, 1);
    expect(await storage.readText(rp.scene("s2"))).toBe(`${examples["offer-price"].trim()}\n`);
    expect(await storage.readText(rp.scenesIndex)).toContain("s1: S1, s2: S2");
    expect(res.artifacts).toEqual(expect.arrayContaining([rp.scene("s1"), rp.scene("s2"), rp.scenesIndex]));

    // Лог викликів: без коду, з ітерацією; рендери — у costs.jsonl як remotion.
    const log = (await storage.readText(authorLogKey(PROJECT_ID, 1)))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(log.map((l) => l.tool)).toEqual([
      "audio_events",
      "write_scene",
      "write_scene",
      "render_strip",
      "write_scene",
      "render_strip",
      "finish",
    ]);
    expect(log[1].input.code).toMatchObject({ chars: expect.any(Number) });
    expect(JSON.stringify(log)).not.toContain("export default");
    expect(log[3].ok).toBe(false);
    expect(log[5]).toMatchObject({ ok: true, images: 1, renders: 10 });
    const costs = await readCosts(storage, PROJECT_ID);
    expect(costs.filter((c) => c.provider === "remotion").map((c) => [c.detail, c.units])).toEqual([
      ["author:strip:s1", { renders: 10 }],
    ]);

    const report = AuthorReport.parse(await storage.readJson(authorReportKey(PROJECT_ID, 1), (v) => v));
    expect(report).toMatchObject({
      finished: true,
      summary: "Фільм із двох сцен.",
      missing: [],
      written: ["s1", "s2"],
    });

    // Промпт відрендерено з усіма змінними, бюджет — з Tuning.
    const run = ctx.agent.runs[0];
    expect(run?.opts).toMatchObject({ maxIterations: 40, tokenBudget: 3_000_000, costDetail: "author" });
    expect(run?.vars).toMatchObject({ mode: "film", targets: "s1, s2", currentScenes: "(немає)" });
    expect(run?.opts.tools.map((t) => t.name)).toEqual([
      "write_scene",
      "render_strip",
      "render_frames",
      "contact_sheet",
      "audio_events",
      "finish",
    ]);

    // Правила ритму, курсора, камери, blur і наскрізного об'єкта — у system; throughline — у <storyboard>.
    const prompt = createPromptLoader().load("author", run?.vars ?? {});
    for (const rule of FILM_RULES) expect(prompt.system).toContain(rule);
    expect(prompt.system).toContain(FILM_CHECKLIST);
    expect(prompt.user).toContain('"throughline": null');
  }, 120_000);

  it("зупинка за ітераціями без finish: сцена без коду — missing, реєстр лише з готових", async () => {
    const storage = tmpStorage();
    await seedProject(storage);
    const step = { tool: "audio_events", input: {} };
    const ctx = makeCtx(storage, { sceneIds: null, instructions: [] }, [
      { tool: "write_scene", input: { sceneId: "s1", code: examples["hook-photo"] } },
      step,
      step,
      step,
      step,
      step,
    ]);
    const stage = createAuthorStage({
      engine: mockEngine(),
      tuning: () => testTuning({ authorMaxIterations: 5 }),
    });
    const res = await stage(ctx);
    expect(res.outputs).toMatchObject({ sceneIds: ["s1", "s2"], iterations: 5, stoppedBy: "iterations" });
    const ledger = await readLedger(storage, PROJECT_ID, 1);
    expect(ledger.scenes.s2?.versions).toMatchObject([
      { v: 1, origin: "author", missing: true, guardOk: false },
    ]);
    const rp = revPaths(PROJECT_ID, 1);
    expect(await storage.readText(rp.scenesIndex)).toContain("export default { s1: S1 }");
    const report = AuthorReport.parse(await storage.readJson(authorReportKey(PROJECT_ID, 1), (v) => v));
    expect(report).toMatchObject({ finished: false, missing: ["s2"], stoppedBy: "iterations" });
  }, 120_000);

  it("finish з незавершеними сценами спершу попереджає", async () => {
    const storage = tmpStorage();
    await seedProject(storage);
    const ctx = makeCtx(storage, { sceneIds: null, instructions: [] }, [
      { tool: "write_scene", input: { sceneId: "s1", code: examples["hook-photo"] } },
      { tool: "finish", input: { summary: "x" } },
      { tool: "finish", input: { summary: "все одно" } },
      { finish: "" },
    ]);
    await createAuthorStage({ engine: mockEngine(), tuning: () => testTuning() })(ctx);
    expect(ctx.agent.calls[1]?.text).toContain("not finished: s2");
    expect(ctx.agent.calls[2]?.text).toContain("Finished.");
  }, 120_000);

  it("правка (subset): код переноситься з основи, нецільові — тільки читання, інструкції в промпті", async () => {
    const storage = tmpStorage();
    await seedProject(storage, { rev: 2 });
    const rp1 = revPaths(PROJECT_ID, 1);
    await storage.write(rp1.scene("s1"), examples["hook-photo"]);
    await storage.write(rp1.scene("s2"), examples["offer-price"]);
    const ctx = makeCtx(
      storage,
      { sceneIds: ["s2"], instructions: [{ sceneId: "s2", instruction: "ціну крупніше" }] },
      [
        { tool: "write_scene", input: { sceneId: "s1", code: examples["hook-photo"] } },
        { tool: "write_scene", input: { sceneId: "s2", code: examples["offer-price"] } },
        { tool: "finish", input: { summary: "ціну збільшено" } },
        { finish: "ок" },
      ],
      { rev: 2 },
    );
    const res = await createAuthorStage({ engine: mockEngine(), tuning: () => testTuning() })(ctx);
    expect(res.outputs).toMatchObject({ sceneIds: ["s2"], stoppedBy: "done" });
    expect(ctx.agent.calls[0]?.text).toContain("error: s1 is read-only");
    const vars = ctx.agent.runs[0]?.vars as Record<string, string>;
    expect(vars.mode).toBe("edit");
    expect(vars.instructions).toBe("- s2: ціну крупніше");
    expect(vars.currentScenes).toContain('<file name="s1.tsx" role="read-only">');
    expect(vars.currentScenes).toContain('<file name="s2.tsx" role="yours">');
    const ledger = await readLedger(storage, PROJECT_ID, 2);
    expect(ledger.scenes.s1?.versions.map((v) => v.origin)).toEqual(["carry"]);
    expect(ledger.scenes.s2?.versions.map((v) => v.origin)).toEqual(["carry", "author"]);
    const report = AuthorReport.parse(await storage.readJson(authorReportKey(PROJECT_ID, 2), (v) => v));
    expect(report.carried).toEqual(["s1", "s2"]);
  }, 120_000);

  it("агент не написав жодної сцени — StageError author_no_scenes", async () => {
    const storage = tmpStorage();
    await seedProject(storage);
    const ctx = makeCtx(storage, { sceneIds: null, instructions: [] }, [{ finish: "нічого" }]);
    const err = await createAuthorStage({ engine: mockEngine(), tuning: () => testTuning() })(ctx).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(StageError);
    expect(err).toMatchObject({ code: "author_no_scenes", retryable: true });
  }, 60_000);
});

describe("author: бюджет і допоміжне", () => {
  it("ліміт часу → сигнал і stoppedBy time; сигнал стадії пробрасується", async () => {
    const d = createDeadline(5);
    await new Promise((r) => setTimeout(r, 20));
    expect(d.signal.aborted).toBe(true);
    expect(d.timedOut()).toBe(true);
    expect(stopReason("signal", d.timedOut())).toBe("time");
    d.dispose();

    const parent = new AbortController();
    const d2 = createDeadline(60_000, parent.signal);
    parent.abort();
    expect(d2.signal.aborted).toBe(true);
    expect(d2.timedOut()).toBe(false);
    d2.dispose();
    expect(stopReason("budget", false)).toBe("budget");
    expect(stopReason("iterations", false)).toBe("iterations");
  });

  it("таблиця звукових подій, огорожа коду, невикористані події", () => {
    const table = audioEventsTable(twoScenes);
    expect(table).toContain("s1 | arrive | 0 | 0.00 s | whoosh");
    expect(table).toContain("s2 | badge-in | 60 | 6.50 s | —");
    expect(cleanCode("```tsx\nconst a = 1;\n```")).toBe("const a = 1;\n");
    expect(unusedEventIds(twoScenes.scenes[1]?.events ?? [], 'eventFrame(props.scene, "price-hit")')).toEqual(
      ["badge-in"],
    );
  });

  it("audio_events: заголовок із треком — темп, тональності, LUFS, долі/такти, ширина; без треку — не падає", async () => {
    const storage = tmpStorage();
    const session = {
      ctx: { storage, projectId: PROJECT_ID, rev: 1 },
      storyboard: twoScenes,
    } as unknown as AuthorSession;
    const tool = audioEventsTool(session);
    // Гілка звуку ще не дійшла: ні плану, ні треку, ні зведення.
    const before = (await tool.run({})).text ?? "";
    expect(before).toContain("key planned none");
    expect(before).toContain("track check: not available yet");
    expect(before).toContain("mix: not built yet");
    expect(before).toContain("s1 | arrive | 0 | 0.00 s | whoosh");

    const paths = projectPaths(PROJECT_ID);
    await storage.writeJson(paths.rev(1).audioPlan, { key: "A minor" });
    await storage.writeJson(paths.rev(1).audio, {
      ...fixtureAudioManifest,
      music: { ...fixtureAudioManifest.music, planHash: "ph1" },
      mix: {
        src: "soundtrack.wav",
        durationMs: 9000,
        integratedLufs: -14.2,
        truePeakDbtp: -1.1,
        masterGainDb: 3,
      },
    });
    await storage.writeJson(paths.musicMeta("ph1"), {
      planHash: "ph1",
      durationMs: 16_000,
      modelId: "music_v2_5",
      method: "compose",
      promptUsed: null,
      briefHash: "b",
      createdAt: "2026-10-13T00:00:00.000Z",
      check: {
        bpm: 120,
        kickOnsets: 30,
        beatConfidence: 0.91,
        gaps: [],
        rmsPerSecondDb: [-14],
        ok: true,
        keyDetected: { root: 2, minor: false, confidence: 0.35 },
        barOffsetMs: 0,
        barConfidence: 0.77,
        stereoCorrelation: 0.99,
        lowCorrelation: 1,
        integratedLufs: -11.5,
        truePeakDbtp: -0.3,
      },
    });
    const text = (await tool.run({})).text ?? "";
    expect(text).toContain(
      "track: 120 bpm, key planned A minor, detected in the track D major (confidence 0.35)",
    );
    expect(text).toContain("beat confidence 0.91, bar (downbeat) confidence 0.77, raw loudness -11.5 LUFS");
    expect(text).toContain("stereo width almost mono (L/R correlation 0.99, below 150 Hz 1.00; 1 = mono)");
    expect(text).toContain("mix: -14.2 LUFS, true peak -1.1 dBTP");
    expect(text).toContain("s2 | price-hit | 30 | 5.50 s | impact (hard)");
  });
});
