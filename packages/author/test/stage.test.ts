import { readLedger } from "@adc/director";
import { QA_LOG_PREFIX, readCosts, revPaths, StageError } from "@adc/shared";
import { describe, expect, it } from "vitest";
import { createDeadline, stopReason } from "../src/budget.ts";
import { AuthorReport, authorLogKey, authorReportKey, createAuthorStage } from "../src/index.ts";
import { audioEventsTable } from "../src/tools/meta.ts";
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
});
