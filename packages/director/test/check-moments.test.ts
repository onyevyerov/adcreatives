import path from "node:path";
import {
  CheckReport,
  emptyCounters,
  type LocalStorage,
  type RenderStillOptions,
  revPaths,
  type Scene,
  type ScenePreviewProps,
  type Storyboard,
} from "@adc/shared";
import { fixtureStoryboard } from "@adc/shared/fixtures";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  buildMomentSheet,
  MOMENT_MAX_FRAMES,
  momentSheetLayout,
  momentSheetRows,
  planMoments,
} from "../src/moments.ts";
import { QA_IMAGE_MAX_SIDE } from "../src/sheets.ts";
import { createCheckStage } from "../src/stages/check.ts";
import { exampleSources, makeCtx, PROJECT_ID, seedProject, tmpStorage } from "./helpers.ts";
import { movingEngine, movingPng, sceneIdOf } from "./strip-engine.ts";

const ex = exampleSources();
const CODES = [ex["hook-photo"], ex["offer-price"], ex["cta-logo"]];

/** Проєкт із розкадровкою і кодом сцен (код — з еталонних прикладів по колу), ревізія `rev`. */
async function seeded(storyboard: Storyboard = fixtureStoryboard, rev = 1, storage = tmpStorage()) {
  await seedProject(storage, { storyboard, rev });
  for (const [i, scene] of storyboard.scenes.entries()) {
    await storage.write(revPaths(PROJECT_ID, rev).scene(scene.id), CODES[i % CODES.length] as string);
  }
  return storage;
}

const readCheck = (storage: LocalStorage, rev = 1) =>
  storage.readJson(revPaths(PROJECT_ID, rev).check, (v) => CheckReport.parse(v));

const norm = (p: string) => p.replace(/\\/g, "/");
/** Рендери кадрів моментів: не стіли й не стрічка. */
const momentRenders = (engine: { stills: RenderStillOptions[] }) =>
  engine.stills.filter((o) => !/\/(stills|strips)\//.test(norm(o.out)));
const stripRenders = (engine: { stills: RenderStillOptions[] }) =>
  engine.stills.filter((o) => norm(o.out).includes("/strips/"));
const stillRenders = (engine: { stills: RenderStillOptions[] }) =>
  engine.stills.filter((o) => norm(o.out).includes("/stills/"));
const framesOf = (renders: RenderStillOptions[], sceneId: string) =>
  renders
    .filter((o) => sceneIdOf(o) === sceneId)
    .map((o) => o.frame)
    .sort((a, b) => a - b);

const scene = (id: string) => fixtureStoryboard.scenes.find((s) => s.id === id) as Scene;
const ev = (id: string, at: number, cue: "impact" | "pop" | null = null): Scene["events"][number] => ({
  id,
  at,
  what: `${id} happens.`,
  sound: cue ? { cue, accent: "normal" } : null,
  textIds: [],
});

describe("planMoments", () => {
  it("фікстура s2: рядок на подію і склейка з s3; кадри сцени без дублів", () => {
    const plan = planMoments(scene("s2"), scene("s3"));
    expect(plan.rows).toEqual([
      { kind: "event", eventId: "price-hit", at: 30, cue: "impact", frames: [28, 29, 30, 31, 32] },
      { kind: "event", eventId: "badge-in", at: 60, cue: null, frames: [58, 59, 60, 61, 62] },
      { kind: "join", nextId: "s3", out: [163, 164], in: [0, 1, 2] },
    ]);
    expect(plan.own).toEqual([28, 29, 30, 31, 32, 58, 59, 60, 61, 62, 163, 164]);
    expect(plan.next).toEqual([0, 1, 2]);
    expect(plan.skipped).toEqual([]);
  });

  it("остання сцена — без склейки; без подій і без наступної — порожній план", () => {
    const last = planMoments({ ...scene("s3"), events: [ev("logo-in", 10, "pop")] }, null);
    expect(last.rows.map((r) => r.kind)).toEqual(["event"]);
    expect(last.next).toEqual([]);
    expect(planMoments(scene("s3"), null)).toMatchObject({ rows: [], own: [], next: [] });
  });

  it("сусідні події ділять кадри; кадри обрізано краями сцени", () => {
    const plan = planMoments(
      { id: "x", durationFrames: 12, events: [ev("a", 0), ev("b", 2), ev("c", 11)] },
      { id: "y", durationFrames: 2 },
    );
    expect(plan.rows.map((r) => (r.kind === "event" ? r.frames : [...r.out, ...r.in]))).toEqual([
      [0, 1, 2],
      [0, 1, 2, 3, 4],
      [9, 10, 11],
      [10, 11, 0, 1],
    ]);
    expect(plan.own).toEqual([0, 1, 2, 3, 4, 9, 10, 11]);
    expect(plan.next).toEqual([0, 1]);
  });

  it("ліміт 30 кадрів: склейка завжди, удари першими, далі — раніші; рядки в порядку розкадровки", () => {
    const events = [10, 25, 40, 55, 70, 85, 100, 115].map((at) =>
      ev(`e${at}`, at, at === 70 || at === 100 ? "impact" : at === 115 ? "pop" : null),
    );
    const plan = planMoments({ id: "x", durationFrames: 150, events }, { id: "y", durationFrames: 90 });
    expect(MOMENT_MAX_FRAMES).toBe(30);
    expect(plan.own.length + plan.next.length).toBeLessThanOrEqual(30);
    // удари 70, 100 (10) + склейка (5) + озвучений pop 115 (5) + тихі 10, 25 (10) = 30
    expect(plan.rows.map((r) => (r.kind === "event" ? r.eventId : "join"))).toEqual([
      "e10",
      "e25",
      "e70",
      "e100",
      "e115",
      "join",
    ]);
    expect(plan.skipped).toEqual(["e40", "e55", "e85"]);
  });
});

describe("buildMomentSheet", () => {
  it("JPEG у межах 1568 у кожному форматі; кадр, якого немає, — заглушка", async () => {
    const plan = planMoments(
      { id: "x", durationFrames: 150, events: [10, 30, 50, 70, 90].map((at) => ev(`e${at}`, at)) },
      { id: "y", durationFrames: 90 },
    );
    const own = new Map(plan.own.filter((f) => f !== 30).map((f) => [f, movingPng(f)] as const));
    const next = new Map(plan.next.map((f) => [f, movingPng(f)] as const));
    const rows = momentSheetRows(plan, 30, own, next);
    expect(rows).toHaveLength(6);
    expect(rows[1]?.title).toBe("e30 · 30 · no sound");
    expect(rows[1]?.cells[2]).toMatchObject({ png: null, label: "30 · 1.00s", note: "render error" });
    expect(rows[5]).toMatchObject({ title: "join x → y", splitAt: 2 });
    expect(rows[5]?.cells.map((c) => c.label)).toEqual([
      "148 · 4.93s",
      "149 · 4.97s",
      "→ 0 · 0.00s",
      "→ 1 · 0.03s",
      "→ 2 · 0.07s",
    ]);
    for (const format of ["vertical", "square", "landscape"] as const) {
      const meta = await sharp(await buildMomentSheet(format, rows)).metadata();
      const layout = momentSheetLayout(format, rows);
      expect(meta.format).toBe("jpeg");
      expect({ width: meta.width, height: meta.height }).toEqual({
        width: layout.width,
        height: layout.height,
      });
      expect(Math.max(layout.width, layout.height)).toBeLessThanOrEqual(QA_IMAGE_MAX_SIDE);
    }
  });
});

describe("checkStage: аркуші моментів (мок RenderEngine)", () => {
  it("аркуші в головному форматі для s1 (склейка) і s2 (події + склейка); s3 без подій і остання — без аркуша", async () => {
    const storage = await seeded();
    const engine = movingEngine();
    const res = await createCheckStage({ engine })(makeCtx(storage, "check", { sceneIds: null }));
    expect(res.outputs.failedScenes).toEqual([]);
    const rp = revPaths(PROJECT_ID, 1);
    const report = await readCheck(storage);
    expect(report.moments).toEqual([
      { sceneId: "s1", format: "vertical", path: rp.momentSheet("vertical", "s1") },
      { sceneId: "s2", format: "vertical", path: rp.momentSheet("vertical", "s2") },
    ]);
    expect(res.artifacts).toContain(rp.momentSheet("vertical", "s2"));
    const meta = await sharp(await storage.read(rp.momentSheet("vertical", "s2"))).metadata();
    expect(meta.format).toBe("jpeg");
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(QA_IMAGE_MAX_SIDE);

    // лише головний формат; кадри, що вже є в стрічці (30, 60, 164 у s2; 149 у s1), не рендеряться
    const moments = momentRenders(engine);
    expect(new Set(moments.map((o) => o.format))).toEqual(new Set(["vertical"]));
    expect(moments.every((o) => o.composition === "ScenePreview")).toBe(true);
    expect(framesOf(moments, "s1")).toEqual([148]);
    expect(framesOf(moments, "s2")).toEqual([0, 1, 2, 28, 29, 31, 32, 58, 59, 61, 62, 163]);
    expect(framesOf(moments, "s3")).toEqual([0, 1, 2]);
    // стіли і стрічка не змінились; моменти додають < 40 % рендерів
    expect(stillRenders(engine)).toHaveLength(18);
    expect(stripRenders(engine).filter((o) => sceneIdOf(o) === "s1")).toHaveLength(16);
    expect(moments.length).toBeLessThanOrEqual(0.4 * (engine.stills.length - moments.length));
    // PNG кадрів моментів не зберігаються — лише аркуші
    expect(await storage.list(`${rp.root}/moments`)).toEqual([
      rp.momentSheet("vertical", "s1"),
      rp.momentSheet("vertical", "s2"),
    ]);
  });

  it("6 сцен із 8 подіями кожна: ≤ 30 рендерів моментів на сцену", async () => {
    const events = [10, 25, 40, 55, 70, 85, 100, 115].map((at) =>
      ev(`e${at}`, at, at === 70 ? "impact" : null),
    );
    const base = fixtureStoryboard.scenes;
    const storyboard: Storyboard = {
      ...fixtureStoryboard,
      scenes: Array.from({ length: 6 }, (_, i) => ({
        ...(base[i % base.length] as Scene),
        id: `s${i + 1}`,
        durationFrames: 150,
        events: i === 1 ? (base[1] as Scene).events : events,
      })),
    };
    const storage = await seeded(storyboard);
    const engine = movingEngine();
    const res = await createCheckStage({ engine })(makeCtx(storage, "check", { sceneIds: null }));
    expect(res.outputs.failedScenes).toEqual([]);
    const moments = momentRenders(engine);
    // кадри одного аркуша рендеряться в одну тимчасову теку
    const batches = new Map<string, number>();
    for (const o of moments) batches.set(path.dirname(o.out), (batches.get(path.dirname(o.out)) ?? 0) + 1);
    expect(batches.size).toBe(6);
    for (const n of batches.values()) expect(n).toBeLessThanOrEqual(MOMENT_MAX_FRAMES);
    const report = await readCheck(storage);
    expect(report.moments.map((m) => m.sceneId)).toEqual(["s1", "s2", "s3", "s4", "s5", "s6"]);
  });

  it("кадр моменту не відрендерився → заглушка на аркуші, сцена не падає", async () => {
    const storage = await seeded();
    const engine = movingEngine();
    const render = engine.renderStill.bind(engine);
    engine.renderStill = async (o: RenderStillOptions) => {
      if (sceneIdOf(o) === "s2" && o.frame === 29) throw new Error("TypeError: boom at 29");
      return render(o);
    };
    const res = await createCheckStage({ engine })(makeCtx(storage, "check", { sceneIds: null }));
    expect(res.outputs.failedScenes).toEqual([]);
    const report = await readCheck(storage);
    expect(report.runtimeErrors).toEqual([]);
    expect(report.moments.map((m) => m.sceneId)).toEqual(["s1", "s2"]);
  });

  it("сцена з runtime-помилкою — без аркуша моментів", async () => {
    const storage = await seeded();
    const engine = movingEngine({ fail: { s2: "TypeError: boom" } });
    const res = await createCheckStage({ engine })(makeCtx(storage, "check", { sceneIds: null }));
    expect(res.outputs.failedScenes).toEqual(["s2"]);
    expect((await readCheck(storage)).moments.map((m) => m.sceneId)).toEqual(["s1"]);
    expect(framesOf(momentRenders(engine), "s3")).toEqual([]);
  });

  it("scope лише s2: перші кадри s3 (поза scope) рендеряться для склейки; аркуш s1 лишається", async () => {
    const storage = await seeded();
    await createCheckStage({ engine: movingEngine() })(makeCtx(storage, "check", { sceneIds: null }));
    const engine = movingEngine();
    await createCheckStage({ engine })(makeCtx(storage, "check", { sceneIds: ["s2"] }));
    const moments = momentRenders(engine);
    expect(framesOf(moments, "s3")).toEqual([0, 1, 2]);
    expect(framesOf(moments, "s1")).toEqual([]);
    expect((await readCheck(storage)).moments.map((m) => m.sceneId)).toEqual(["s1", "s2"]);
  });

  it("шаблонна сцена — без аркуша; склейка в неї рендерить її як TemplateScene", async () => {
    const storage = await seeded();
    await storage.writeJson(revPaths(PROJECT_ID, 1).pipeline, { ...emptyCounters(), templateScenes: ["s2"] });
    const engine = movingEngine();
    await createCheckStage({ engine })(makeCtx(storage, "check", { sceneIds: null }));
    expect((await readCheck(storage)).moments.map((m) => m.sceneId)).toEqual(["s1"]);
    const s2 = momentRenders(engine).filter((o) => sceneIdOf(o) === "s2");
    expect(s2.map((o) => o.frame)).toEqual([0, 1, 2]);
    expect(s2.every((o) => (o.inputProps as ScenePreviewProps).useTemplate === true)).toBe(true);
  });

  it("нова ревізія: незмінені сцени — аркуші моментів копіюються з основи без рендера", async () => {
    const storage = await seeded();
    await createCheckStage({ engine: movingEngine() })(makeCtx(storage, "check", { sceneIds: null }));
    await seeded(fixtureStoryboard, 2, storage);
    const engine = movingEngine();
    const res = await createCheckStage({ engine })(
      makeCtx(storage, "check", { sceneIds: null }, [], { rev: 2 }),
    );
    expect(engine.stills).toHaveLength(0);
    expect(res.reused).toBe(true);
    const rp2 = revPaths(PROJECT_ID, 2);
    expect((await readCheck(storage, 2)).moments).toEqual([
      { sceneId: "s1", format: "vertical", path: rp2.momentSheet("vertical", "s1") },
      { sceneId: "s2", format: "vertical", path: rp2.momentSheet("vertical", "s2") },
    ]);
    expect(await storage.exists(rp2.momentSheet("vertical", "s2"))).toBe(true);
  });

  it("check.json без moments парситься; check поверх нього дописує аркуші знятих сцен", async () => {
    const storage = await seeded();
    await createCheckStage({ engine: movingEngine() })(makeCtx(storage, "check", { sceneIds: null }));
    const rp = revPaths(PROJECT_ID, 1);
    const { moments: _, ...old } = await readCheck(storage);
    await storage.writeJson(rp.check, old);
    expect((await readCheck(storage)).moments).toEqual([]);
    await createCheckStage({ engine: movingEngine() })(makeCtx(storage, "check", { sceneIds: ["s2"] }));
    expect((await readCheck(storage)).moments.map((m) => m.sceneId)).toEqual(["s2"]);
  });
});
