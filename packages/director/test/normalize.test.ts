import { computeTimeline, Storyboard } from "@adc/shared";
import { fixtureStoryboard } from "@adc/shared/fixtures";
import { describe, expect, it } from "vitest";
import { checkCopy, maxHits, normalizeStoryboard } from "../src/normalize.ts";

const ASSETS = ["a01", "a02"];

type Ev = Storyboard["scenes"][number]["events"][number];
type Cue = NonNullable<Ev["sound"]>["cue"];
type Accent = NonNullable<Ev["sound"]>["accent"];

/**
 * Ролик 24 с при 120 BPM (доля 15 кадрів): 4 склейки по 180 кадрів; удари задаються глобальними
 * секундами (кадри на сітці — нормалізація їх не зсуває).
 */
function hitsVideo(hits: Array<[sec: number, cue: Cue, accent: Accent]>): Storyboard {
  const scenes = [0, 1, 2, 3].map((i) => ({
    durationFrames: 180,
    transitionFrames: 0,
    transitionIn: "cut" as const,
    sfxCue: null,
    events: hits
      .map(([sec, cue, accent], k): [number, Ev] => [
        sec * 30,
        { id: `e${k + 1}`, at: sec * 30 - i * 180, what: "Hit.", sound: { cue, accent }, textIds: [] },
      ])
      .filter(([f]) => f >= i * 180 && f < (i + 1) * 180)
      .map(([, e]) => e),
  }));
  const out = sb(scenes);
  out.musicBrief.bpm = 120;
  return out;
}

/** Подія за id з усіх сцен: [cue, accent, глобальний кадр]. */
function eventsById(res: {
  storyboard: Storyboard;
}): Record<string, [Cue | undefined, Accent | undefined, number]> {
  const tl = computeTimeline(res.storyboard);
  const out: Record<string, [Cue | undefined, Accent | undefined, number]> = {};
  res.storyboard.scenes.forEach((s, i) => {
    for (const e of s.events) out[e.id] = [e.sound?.cue, e.sound?.accent, (tl.scenes[i]?.from ?? 0) + e.at];
  });
  return out;
}

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

  it("ліміт ударів: 1 + floor(totalSec / 6) — 15 с → 3, 24 с → 5, 30 с → 6", () => {
    expect(maxHits(15)).toBe(3);
    expect(maxHits(23.9)).toBe(4);
    expect(maxHits(24)).toBe(5);
    expect(maxHits(30)).toBe(6);
  });

  it("щільність ударів: понад 5 на 24 с → pop (normal), спершу soft, потім normal за порядком; кадр той самий", () => {
    // Удари рівно через 3 с — вікно не порушене, працює лише ліміт на ролик.
    const res = normalizeStoryboard(
      hitsVideo([
        [0, "impact", "hard"],
        [3, "slam", "normal"],
        [6, "impact", "soft"],
        [9, "impact", "hard"],
        [12, "slam", "normal"],
        [15, "impact", "hard"],
        [18, "slam", "soft"],
        [21, "impact", "hard"],
      ]),
      { assetIds: ASSETS },
    );
    expect(res.totalFrames).toBe(720);
    expect(eventsById(res)).toEqual({
      e1: ["impact", "hard", 0],
      e2: ["pop", "normal", 90],
      e3: ["pop", "normal", 180],
      e4: ["impact", "hard", 270],
      e5: ["slam", "normal", 360],
      e6: ["impact", "hard", 450],
      e7: ["pop", "normal", 540],
      e8: ["impact", "hard", 630],
    });
    const demoted = res.changes.filter((c) => c.includes("→ pop"));
    expect(demoted).toEqual([
      "s2: подія «e3» impact (soft) → pop — понад ліміт 5 ударів на ролик",
      "s4: подія «e7» slam (soft) → pop — понад ліміт 5 ударів на ролик",
      "s1: подія «e2» slam (normal) → pop — понад ліміт 5 ударів на ролик",
    ]);
  });

  it("щільність ударів: другий impact/slam у вікні 3 с → pop, навіть hard; рівно 3 с — можна", () => {
    // Розклад ударів з розбору ролика пайплайна: 0, 1.5, 8, 9.5, 13.5, 15.5, 17.5, 20.5 с.
    const res = normalizeStoryboard(
      hitsVideo([
        [0, "impact", "normal"],
        [1.5, "slam", "hard"],
        [8, "impact", "hard"],
        [9.5, "impact", "hard"],
        [13.5, "slam", "hard"],
        [15.5, "impact", "soft"],
        [17.5, "impact", "hard"],
        [20.5, "slam", "hard"],
      ]),
      { assetIds: ASSETS },
    );
    const ev = eventsById(res);
    expect(Object.values(ev).filter(([cue]) => cue === "impact" || cue === "slam")).toHaveLength(5);
    expect(ev.e2).toEqual(["pop", "normal", 45]);
    expect(ev.e4).toEqual(["pop", "normal", 285]);
    expect(ev.e6).toEqual(["pop", "normal", 465]);
    expect(ev.e8).toEqual(["slam", "hard", 615]); // 17.5 → 20.5 рівно 3 с
    expect(res.changes).toContain("s1: подія «e2» slam (hard) → pop — ближче 3 с до попереднього удару");
    expect(res.changes.some((c) => c.includes("понад ліміт"))).toBe(false);
  });

  it("riser далі ніж за 2 такти до наступної озвученої події — лише попередження", () => {
    const base = hitsVideo([]);
    const [s1, s2] = base.scenes as [Storyboard["scenes"][number], Storyboard["scenes"][number]];
    // 2 такти при 120 BPM = 8 долей = 120 кадрів.
    s1.events = [
      { id: "build", at: 30, what: "Tension.", sound: { cue: "riser", accent: "normal" }, textIds: [] },
      { id: "quiet", at: 90, what: "Seen, not heard.", sound: null, textIds: [] },
    ];
    s2.events = [
      { id: "land", at: 0, what: "Lands.", sound: { cue: "pop", accent: "normal" }, textIds: [] },
      { id: "build2", at: 60, what: "Tension.", sound: { cue: "riser", accent: "hard" }, textIds: [] },
      { id: "peak", at: 165, what: "Peak.", sound: { cue: "impact", accent: "hard" }, textIds: [] },
    ];
    const res = normalizeStoryboard(base, { assetIds: ASSETS });
    expect(res.changes.filter((c) => c.includes("riser"))).toEqual([
      "s1: riser «build» за 10 долей до події «land» — довший за 2 такти (попередження)",
    ]);
    const ev = eventsById(res);
    expect(ev.build).toEqual(["riser", "normal", 30]);
    expect(ev.build2).toEqual(["riser", "hard", 240]);
    expect(ev.peak).toEqual(["impact", "hard", 345]);
  });

  it("старі розкадровки з sfxCue: подія arrive з impact не рахується і не понижується", () => {
    // 6 сцен по 2.5 с, у кожної sfxCue "impact" — як раніше, без пониження.
    const old = sb(
      [0, 1, 2, 3, 4, 5].map(() => ({
        durationFrames: 75,
        transitionFrames: 0,
        transitionIn: "cut" as const,
        sfxCue: "impact",
        events: [],
      })),
    );
    old.musicBrief.bpm = 120;
    const res = normalizeStoryboard(old, { assetIds: ASSETS });
    expect(res.totalFrames).toBe(450);
    for (const s of res.storyboard.scenes) {
      expect(s.sfxCue).toBe("impact");
      expect(s.events.map((e) => [e.id, e.at, e.sound?.cue, e.sound?.accent])).toEqual([
        ["arrive", 0, "impact", "normal"],
      ]);
    }
    expect(res.changes.some((c) => c.includes("→ pop"))).toBe(false);
  });
});
