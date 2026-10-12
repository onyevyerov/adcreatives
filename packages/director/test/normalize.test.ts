import { computeTimeline, Storyboard } from "@adc/shared";
import { fixtureStoryboard } from "@adc/shared/fixtures";
import { describe, expect, it } from "vitest";
import { checkCopy, normalizeStoryboard } from "../src/normalize.ts";

const ASSETS = ["a01", "a02"];

function sb(scenes: Array<Partial<Storyboard["scenes"][number]>>): Storyboard {
  const base = fixtureStoryboard.scenes[0] as Storyboard["scenes"][number];
  return {
    ...structuredClone(fixtureStoryboard),
    scenes: scenes.map((s, i) => ({ ...structuredClone(base), id: `s${i + 1}`, ...s })),
  };
}

describe("normalizeStoryboard", () => {
  it("фікстура: темп 85 → 90 BPM, сцени — цілі долі (20 кадрів), загальна довжина та сама", () => {
    const res = normalizeStoryboard(fixtureStoryboard, { assetIds: ASSETS });
    expect(res.storyboard.musicBrief.bpm).toBe(90);
    expect(res.totalFrames).toBe(computeTimeline(fixtureStoryboard).totalFrames);
    expect(res.storyboard.scenes.map((s) => s.durationFrames)).toEqual([160, 160, 160]);
    expect(res.changes).toContain("musicBrief.bpm 85 → 90");
  });

  it("bpm 120: тривалості сцен кратні 15 кадрам, загальна довжина точна (остача — остання сцена)", () => {
    const base = sb([
      { durationFrames: 100, transitionFrames: 0, transitionIn: "cut" },
      { durationFrames: 140, transitionFrames: 0, transitionIn: "cut" },
      { durationFrames: 113, transitionFrames: 0, transitionIn: "cut" },
      { durationFrames: 121, transitionFrames: 0, transitionIn: "cut" },
    ]);
    base.musicBrief.bpm = 120;
    const res = normalizeStoryboard(base, { assetIds: ASSETS });
    expect(res.totalFrames).toBe(474);
    const d = res.storyboard.scenes.map((s) => s.durationFrames);
    for (const v of d.slice(0, -1)) expect(v % 15).toBe(0);
    expect(d.reduce((a, b) => a + b, 0)).toBe(474);
    // Межі сцен (склейки) — на долях.
    for (const ts of computeTimeline(res.storyboard).scenes.slice(1)) expect(ts.from % 15).toBe(0);

    // Бажана тривалість клієнта: точно 600 кадрів, сцени — цілі долі.
    const exact = normalizeStoryboard(
      { ...structuredClone(fixtureStoryboard), musicBrief: { ...fixtureStoryboard.musicBrief, bpm: 120 } },
      { assetIds: ASSETS, durationSeconds: 20 },
    );
    expect(exact.totalFrames).toBe(600);
    expect(computeTimeline(exact.storyboard).totalFrames).toBe(600);
    for (const s of exact.storyboard.scenes.slice(0, -1)) expect(s.durationFrames % 15).toBe(0);
  });

  it("події: у межах сцени, без дублікатів, пропорційно до тривалості; удари — на восьму, tick — на місці", () => {
    const base = sb([
      {
        durationFrames: 300,
        sfxCue: null,
        items: [{ id: "t1", role: "item", text: "Пункт", group: null, factIds: [] }],
        events: [
          {
            id: "hit",
            at: 47,
            what: "Hit.",
            sound: { cue: "impact", accent: "hard" },
            textIds: ["t1", "t9"],
          },
          { id: "hit", at: 10, what: "Duplicate.", sound: null, textIds: [] },
          { id: "type", at: 47, what: "Typing.", sound: { cue: "tick", accent: "soft" }, textIds: [] },
          { id: "late", at: 999, what: "Too late.", sound: null, textIds: [] },
        ],
      },
      { durationFrames: 150, transitionFrames: 0, transitionIn: "cut", sfxCue: null },
    ]);
    base.musicBrief.bpm = 120; // восьма = 7.5 кадра
    const res = normalizeStoryboard(base, { assetIds: ASSETS });
    const s1 = res.storyboard.scenes[0] as Storyboard["scenes"][number];
    expect(s1.durationFrames).toBe(300);
    expect(s1.events.map((e) => [e.id, e.at])).toEqual([
      ["hit", 45],
      ["type", 47],
      ["late", 299],
    ]);
    expect(s1.events[0]?.textIds).toEqual(["t1"]);
    expect(res.changes).toContain("s1: дублікат події «hit» викинуто");

    // Сцену розтягнуто вдвічі (бажана тривалість) — кадри подій їдуть разом зі сценою.
    const stretched = normalizeStoryboard(
      sb([
        {
          durationFrames: 150,
          sfxCue: null,
          events: [{ id: "mid", at: 60, what: "Middle.", sound: null, textIds: [] }],
        },
        { durationFrames: 150, transitionFrames: 0, transitionIn: "cut", sfxCue: null },
      ]),
      { assetIds: ASSETS, durationSeconds: 20 },
    );
    expect(stretched.storyboard.scenes[0]?.durationFrames).toBe(300);
    expect(stretched.storyboard.scenes[0]?.events[0]?.at).toBe(120);
  });

  it("items: trim, порожні викинуто, унікальні id, відомі factIds; legacy sfxCue → подія arrive", () => {
    const res = normalizeStoryboard(
      sb([
        {
          sfxCue: "pop",
          items: [
            { id: "t1", role: "label", text: "  Крок 1  ", group: " ", factIds: ["f1", "f9"] },
            { id: "t1", role: "label", text: "Крок 2", group: "list:кроки", factIds: [] },
            { id: "t2", role: "label", text: "   ", group: null, factIds: [] },
          ],
        },
      ]),
      { assetIds: ASSETS, factIds: ["f1"] },
    );
    const s1 = res.storyboard.scenes[0] as Storyboard["scenes"][number];
    expect(s1.items).toEqual([
      { id: "t1", role: "label", text: "Крок 1", group: null, factIds: ["f1"] },
      { id: "t3", role: "label", text: "Крок 2", group: "list:кроки", factIds: [] },
    ]);
    expect(s1.events).toEqual([
      {
        id: "arrive",
        at: 0,
        what: "The scene arrives.",
        sound: { cue: "pop", accent: "normal" },
        textIds: [],
      },
    ]);
    expect(s1.sfxCue).toBe("pop");
  });

  it("старий storyboard без items/events проходить нормалізацію без змін текстів", () => {
    const raw = JSON.parse(JSON.stringify(fixtureStoryboard)) as Record<string, unknown> & {
      scenes: Array<Record<string, unknown>>;
      musicBrief: { structure: Array<Record<string, unknown>> };
    };
    for (const s of raw.scenes) {
      delete s.items;
      delete s.events;
    }
    for (const p of raw.musicBrief.structure) delete p.mix;
    const old = Storyboard.parse(raw);
    const res = normalizeStoryboard(old, { assetIds: ASSETS, factIds: ["f1", "f2"] });
    expect(res.storyboard.scenes.map((s) => s.text)).toEqual(fixtureStoryboard.scenes.map((s) => s.text));
    expect(res.storyboard.scenes.map((s) => s.items)).toEqual([[], [], []]);
    expect(res.storyboard.scenes.map((s) => s.events.map((e) => [e.id, e.at, e.sound?.cue]))).toEqual([
      [["arrive", 0, "whoosh"]],
      [["arrive", 0, "pop"]],
      [["arrive", 0, "shimmer"]],
    ]);
    expect(res.textIssues).toEqual([]);
    expect(res.totalFrames).toBe(450);
  });

  it("закоротке відео масштабується до 450 кадрів, сцена ≥ 45", () => {
    const res = normalizeStoryboard(
      sb([
        { durationFrames: 20, transitionFrames: 0, transitionIn: "cut" },
        { durationFrames: 60, transitionFrames: 10, transitionIn: "fade" },
        { durationFrames: 90, transitionFrames: 10, transitionIn: "slide" },
      ]),
      { assetIds: ASSETS },
    );
    expect(res.totalFrames).toBe(450);
    for (const s of res.storyboard.scenes) expect(s.durationFrames).toBeGreaterThanOrEqual(45);
    // пропорції збережено: третя сцена довша за другу
    const [a, b, c] = res.storyboard.scenes.map((s) => s.durationFrames) as [number, number, number];
    expect(c).toBeGreaterThan(b);
    expect(b).toBeGreaterThanOrEqual(a);
  });

  it("задовге відео стискається до 900", () => {
    const res = normalizeStoryboard(
      sb([
        { durationFrames: 400, transitionFrames: 0 },
        { durationFrames: 400, transitionFrames: 20, transitionIn: "fade" },
        { durationFrames: 400, transitionFrames: 20, transitionIn: "fade" },
      ]),
      { assetIds: ASSETS },
    );
    expect(res.totalFrames).toBe(900);
  });

  it("бажана тривалість клієнта (20 с) → рівно 600 кадрів", () => {
    const res = normalizeStoryboard(fixtureStoryboard, { assetIds: ASSETS, durationSeconds: 20 });
    expect(res.totalFrames).toBe(600);
    expect(computeTimeline(res.storyboard).totalFrames).toBe(600);
  });

  it("перехід ≤ третини коротшої сусідньої сцени; cut ⇔ 0", () => {
    const res = normalizeStoryboard(
      sb([
        { durationFrames: 300, transitionFrames: 30 },
        { durationFrames: 60, transitionFrames: 50, transitionIn: "wipe" },
        { durationFrames: 200, transitionFrames: 25, transitionIn: "cut" },
        { durationFrames: 200, transitionFrames: 0, transitionIn: "fade" },
      ]),
      { assetIds: ASSETS },
    );
    const [s1, s2, s3, s4] = res.storyboard.scenes as [
      Storyboard["scenes"][number],
      Storyboard["scenes"][number],
      Storyboard["scenes"][number],
      Storyboard["scenes"][number],
    ];
    expect(s1.transitionFrames).toBe(0);
    expect(s2.transitionFrames).toBeLessThanOrEqual(
      Math.floor(Math.min(s1.durationFrames, s2.durationFrames) / 3),
    );
    expect(s3.transitionFrames).toBe(0);
    expect(s4.transitionFrames).toBeGreaterThan(0);
  });

  it("викидає неіснуючі assetIds/factIds, emphasis без збігу, дублікати id", () => {
    const res = normalizeStoryboard(
      sb([
        {
          assetIds: ["a01", "zz9"],
          factIds: ["f1", "f9"],
          text: { headline: "Кава", sub: " ", emphasis: ["Кава", "чай"] },
        },
        { id: "s1" },
      ]),
      { assetIds: ASSETS, factIds: ["f1"] },
    );
    const [first, second] = res.storyboard.scenes;
    expect(first?.assetIds).toEqual(["a01"]);
    expect(first?.factIds).toEqual(["f1"]);
    expect(first?.text).toEqual({ headline: "Кава", sub: null, emphasis: ["Кава"] });
    expect(second?.id).toBe("s2");
    expect(res.changes.some((c) => c.includes("zz9"))).toBe(true);
  });

  it("довжина тексту звіряється з copyRules для обраних форматів", () => {
    const long = sb([
      {
        text: {
          headline: "Дуже довгий заголовок, який точно не влізе у три рядки вертикалі",
          sub: null,
          emphasis: [],
        },
      },
    ]);
    const vertical = checkCopy(long, ["vertical"]);
    expect(vertical).toContainEqual(
      expect.objectContaining({ sceneId: "s1", field: "headline", kind: "length", limit: 54 }),
    );
    const res = normalizeStoryboard(long, { assetIds: ASSETS, formats: ["landscape"] });
    expect(res.textIssues).toEqual([]);
  });

  it("items: слово довше за рядок — textIssue з itemId; адреси сайтів не рахуються", () => {
    const issues = checkCopy(
      sb([
        {
          items: [
            { id: "t1", role: "item", text: "Найнеймовірнішийфантастичний пункт", group: null, factIds: [] },
            { id: "t2", role: "label", text: "https://webreportio.com/pricing", group: null, factIds: [] },
          ],
        },
      ]),
      ["vertical"],
    );
    expect(issues).toEqual([
      expect.objectContaining({ sceneId: "s1", field: "item", itemId: "t1", kind: "word", limit: 18 }),
    ]);
  });
});
