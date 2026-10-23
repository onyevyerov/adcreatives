import {
  type ChatEvent,
  CheckReport,
  type LocalStorage,
  type RenderStillOptions,
  revPaths,
  STAGE_STEPS,
  stripFrames,
} from "@adc/shared";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { QA_IMAGE_MAX_SIDE, stripSheetLayout } from "../src/sheets.ts";
import {
  createCheckStage,
  eventUnusedIssues,
  findStaticHolds,
  framesAlike,
  STATIC_HOLD_MIN_FRAMES,
  STATIC_HOLD_MIN_FRAMES_FINAL_CTA,
  STRIP_STEP,
  staticHoldThreshold,
  unusedEvents,
} from "../src/stages/check.ts";
import { codegenStage } from "../src/stages/codegen.ts";
import { exampleSources, fileBlocks, makeCtx, PROJECT_ID, seedProject, tmpStorage } from "./helpers.ts";
import { movingEngine, sceneIdOf } from "./strip-engine.ts";

type ProgressEvent = Extract<ChatEvent, { type: "progress" }>;

const ex = exampleSources();
const CODE: Record<string, string> = { s1: ex["hook-photo"], s2: ex["offer-price"], s3: ex["cta-logo"] };

async function generated(): Promise<LocalStorage> {
  const storage = tmpStorage();
  await seedProject(storage);
  await codegenStage(
    makeCtx(
      storage,
      "codegen",
      { sceneIds: null, instructions: [] },
      Object.entries(CODE).map(([id, code]) => ({ text: fileBlocks({ [id]: code }) })),
    ),
  );
  return storage;
}

const readCheck = (storage: LocalStorage) =>
  storage.readJson(revPaths(PROJECT_ID, 1).check, (v) => CheckReport.parse(v));

/** Кадр «стоїть» у [from, to] сцени `sceneId`: пишеться PNG кадру `from`. */
const freeze =
  (sceneId: string, from: number, to: number) =>
  (o: RenderStillOptions): number | null =>
    sceneIdOf(o) === sceneId && o.frame >= from && o.frame <= to ? from : null;

/** `o.out` — абсолютний шлях ОС: на Windows роздільник `\`. */
const norm = (p: string) => p.replace(/\\/g, "/");

const thumb = (v: number, n = 96 * 171) => new Uint8Array(n * 3).fill(v);

describe("static_hold: детектор", () => {
  it("пороги — константи: 45 кадрів (1.5 с), фінальна cta — 75", () => {
    expect(STRIP_STEP).toBe(15);
    expect(STATIC_HOLD_MIN_FRAMES).toBe(45);
    expect(STATIC_HOLD_MIN_FRAMES_FINAL_CTA).toBe(75);
    expect(staticHoldThreshold({ purpose: "cta" }, true)).toBe(75);
    expect(staticHoldThreshold({ purpose: "cta" }, false)).toBe(45);
    expect(staticHoldThreshold({ purpose: "hook" }, true)).toBe(45);
  });

  it("framesAlike: дрібні зміни — однакові, помітні — ні", () => {
    const a = thumb(100);
    const b = thumb(100);
    b[0] = 255; // один піксель — шум
    expect(framesAlike(a, b)).toBe(true);
    expect(framesAlike(a, thumb(106))).toBe(true); // ≤ STATIC_PIXEL_DELTA
    expect(framesAlike(a, thumb(140))).toBe(false);
    const c = thumb(100);
    c.fill(255, 0, 3 * 200); // 200 пікселів (> 0.2%) змінилися
    expect(framesAlike(a, c)).toBe(false);
  });

  it("серія ≥ порогу → діапазон кадрів; коротша — ні; повільний дрейф не накопичується", () => {
    const frames = stripFrames(150, STRIP_STEP);
    expect(frames).toEqual([15, 30, 45, 60, 75, 90, 105, 120, 135, 149]);
    // після кадру 30 нічого не рухається 90 кадрів
    const still = frames.map((f) => thumb(f >= 30 && f <= 120 ? 30 : f));
    expect(findStaticHolds(frames, still, 45)).toEqual([{ from: 30, to: 120, frames: 90 }]);
    // 30 кадрів (45–75) — менше порогу
    const short = frames.map((f) => thumb(f >= 45 && f <= 75 ? 45 : f));
    expect(findStaticHolds(frames, short, 45)).toEqual([]);
    // дрейф по 5 на кадр стрічки: сусіди «однакові», але від початку серії — ні
    const drift = frames.map((_, i) => thumb(100 + i * 5));
    expect(findStaticHolds(frames, drift, 45)).toEqual([]);
    // поріг cta: 90 кадрів ≥ 75
    expect(findStaticHolds(frames, still, 75)).toHaveLength(1);
  });
});

describe("event_unused", () => {
  const scene = {
    id: "s2",
    events: [
      { id: "price-hit", at: 30, what: "The price lands.", sound: null, textIds: [] },
      { id: "badge-in", at: 60, what: "The badge fades in.", sound: null, textIds: [] },
      { id: "arrive", at: 0, what: "The scene arrives.", sound: null, textIds: [] },
    ],
  };

  it("id події має траплятися рядковим літералом у коді; legacy arrive на кадрі 0 — не вимагається", () => {
    const code = `const hit = eventFrame(props.scene, "price-hit");\nconst x = "badge-inner";`;
    expect(unusedEvents(scene, code).map((e) => e.id)).toEqual(["badge-in"]);
    expect(unusedEvents(scene, "const ids = ['price-hit', `badge-in`];")).toEqual([]);
    const issues = eventUnusedIssues(scene, "", "vertical");
    expect(issues.map((i) => [i.kind, i.sceneId, i.format, i.frame])).toEqual([
      ["event_unused", "s2", "vertical", 30],
      ["event_unused", "s2", "vertical", 60],
    ]);
    expect(issues[0]?.detail).toContain('eventFrame(props.scene, "price-hit")');
  });
});

describe("checkStage: стрічка кадрів (мок RenderEngine)", () => {
  it("кадри стрічки в усіх форматах (збіг зі стілом — копія), аркуш ≤ 1568, без зайвих autoIssues", async () => {
    const storage = await generated();
    const engine = movingEngine();
    const res = await createCheckStage({ engine })(makeCtx(storage, "check", { sceneIds: null }));
    expect(res.outputs.failedScenes).toEqual([]);
    const rp = revPaths(PROJECT_ID, 1);
    const frames = stripFrames(150, STRIP_STEP);
    for (const format of ["vertical", "square"] as const) {
      for (const f of frames) expect(await storage.exists(rp.strip(format, "s1", f))).toBe(true);
      const sheet = await sharp(await storage.read(rp.stripSheet(format, "s1"))).metadata();
      expect(sheet.format).toBe("jpeg");
      expect(Math.max(sheet.width ?? 0, sheet.height ?? 0)).toBeLessThanOrEqual(QA_IMAGE_MAX_SIDE);
      const layout = stripSheetLayout(format, frames.length);
      expect({ width: sheet.width, height: sheet.height }).toEqual({
        width: layout.width,
        height: layout.height,
      });
    }
    // s1: 10 кадрів стрічки, 75 і 135 збігаються зі стілами → 8 рендерів на формат
    const s1Strip = engine.stills.filter((o) => sceneIdOf(o) === "s1" && norm(o.out).includes("/strips/"));
    expect(s1Strip).toHaveLength(16);
    expect(s1Strip.every((o) => o.composition === "ScenePreview" && o.inputProps.qa === true)).toBe(true);
    expect(new Set(s1Strip.map((o) => o.frame))).toEqual(new Set([15, 30, 45, 60, 90, 105, 120, 149]));
    // сцени рухаються → static_hold немає; лишається лише event_unused сцени s2
    const report = await readCheck(storage);
    expect(report.autoIssues.map((i) => i.kind)).toEqual(["event_unused", "event_unused"]);
  });

  it("прогрес: крок check (код, бандл), далі stills з лічильником; без однакових подій поспіль", async () => {
    const storage = await generated();
    const ctx = makeCtx(storage, "check", { sceneIds: null });
    await createCheckStage({ engine: movingEngine() })(ctx);
    const events = ctx.emitted.events.filter((e): e is ProgressEvent => e.type === "progress");
    const label = (id: string) => STAGE_STEPS.directing.find((s) => s.id === id)?.label as string;

    expect(events.every((e) => e.stage === "check")).toBe(true);
    expect(events.slice(0, 2).map((e) => [e.step, e.label])).toEqual([
      ["check", label("check")],
      ["check", "Збираю відео-проєкт…"],
    ]);
    const stills = events.slice(2);
    expect(stills.length).toBeGreaterThan(0);
    for (const e of stills) {
      expect(e.step).toBe("stills");
      expect(e.label).toBe(`${label("stills")} ${e.done}/${e.total}`);
    }
    expect(stills.at(-1)?.done).toBe(stills.at(-1)?.total);
    for (let i = 1; i < events.length; i++) {
      const [a, b] = [events[i - 1] as ProgressEvent, events[i] as ProgressEvent];
      expect(`${a.step}|${a.label}`).not.toBe(`${b.step}|${b.label}`);
    }
  });

  it("після кадру 30 нічого не рухається 90 кадрів → static_hold з діапазоном кадрів у кожному форматі", async () => {
    const storage = await generated();
    const engine = movingEngine({ frozen: freeze("s1", 30, 120) });
    const res = await createCheckStage({ engine })(makeCtx(storage, "check", { sceneIds: null }));
    const report = await readCheck(storage);
    const holds = report.autoIssues.filter((i) => i.kind === "static_hold");
    expect(holds.map((i) => [i.sceneId, i.format, i.frame, i.value])).toEqual([
      ["s1", "vertical", 30, 90],
      ["s1", "square", 30, 90],
    ]);
    expect(holds[0]?.detail).toContain("frames 30–120 (1.0–4.0 s)");
    expect(res.outputs.issueScenes).toContain("s1");
  });

  it("фінальна сцена cta: 60 кадрів без руху — ще не static_hold (поріг 75), звичайна сцена — так", async () => {
    const storage = await generated();
    const both = (o: RenderStillOptions) => freeze("s1", 45, 105)(o) ?? freeze("s3", 45, 105)(o);
    await createCheckStage({ engine: movingEngine({ frozen: both }) })(
      makeCtx(storage, "check", { sceneIds: null }),
    );
    const holds = (await readCheck(storage)).autoIssues.filter((i) => i.kind === "static_hold");
    expect(holds.map((i) => i.sceneId)).toEqual(["s1", "s1"]);

    const storage2 = await generated();
    await createCheckStage({ engine: movingEngine({ frozen: freeze("s3", 30, 120) }) })(
      makeCtx(storage2, "check", { sceneIds: null }),
    );
    const holds2 = (await readCheck(storage2)).autoIssues.filter((i) => i.kind === "static_hold");
    expect(holds2.map((i) => [i.sceneId, i.value])).toEqual([
      ["s3", 90],
      ["s3", 90],
    ]);
  });

  it("сцена з подією, id якої немає в коді → event_unused", async () => {
    const storage = await generated();
    await createCheckStage({ engine: movingEngine() })(makeCtx(storage, "check", { sceneIds: null }));
    const unused = (await readCheck(storage)).autoIssues.filter((i) => i.kind === "event_unused");
    expect(unused.map((i) => [i.sceneId, i.format, i.frame])).toEqual([
      ["s2", "vertical", 30],
      ["s2", "vertical", 60],
    ]);
    expect(unused.map((i) => i.detail).join("\n")).toMatch(/"price-hit"[\s\S]*"badge-in"/);
  });

  it("помилка рендера на кадрі стрічки → runtime-помилка сцени; аркуш із заглушкою є", async () => {
    const storage = await generated();
    const engine = movingEngine();
    const render = engine.renderStill.bind(engine);
    engine.renderStill = async (o: RenderStillOptions) => {
      if (sceneIdOf(o) === "s1" && o.frame === 90) throw new Error("TypeError: boom at 90");
      return render(o);
    };
    const res = await createCheckStage({ engine })(makeCtx(storage, "check", { sceneIds: null }));
    expect(res.outputs.failedScenes).toEqual(["s1"]);
    const report = await readCheck(storage);
    expect(report.runtimeErrors.map((e) => [e.sceneId, e.format, e.frame])).toEqual([
      ["s1", "vertical", 90],
      ["s1", "square", 90],
    ]);
    expect(report.autoIssues.filter((i) => i.sceneId === "s1" && i.kind === "static_hold")).toEqual([]);
    expect(await storage.exists(revPaths(PROJECT_ID, 1).stripSheet("vertical", "s1"))).toBe(true);
  });
});
