import { readFileSync } from "node:fs";
import path from "node:path";
import { makeGradientPng } from "@adc/render/testing";
import {
  applySfxPlan,
  type LocalStorage,
  ReviewIssue,
  readCosts,
  readTuning,
  revPaths,
  type SfxDecision,
  SfxPlan,
  type SoundAccent,
  type SoundCue,
  StageError,
  Storyboard,
} from "@adc/shared";
import { fixtureStoryboard } from "@adc/shared/fixtures";
import { describe, expect, it } from "vitest";
import { createSfxStage, cueTable, sfxStage, sfxViolations, trimToLimits } from "../src/stages/sfx.ts";
import { makeCtx, PROJECT_ID, type Reply, seedProject, systemText, tmpStorage, userText } from "./helpers.ts";

const FIXTURES = path.join(import.meta.dirname, "fixtures", "sfx");
const COLORS: Record<string, [string, string]> = {
  s1: ["#6B3E26", "#E85D2A"],
  s2: ["#1D3557", "#A8DADC"],
  s3: ["#2A9D8F", "#E9C46A"],
};

/** Розкадровка «Зерна» з подіями фікстури (4 важкі удари, 2 cash, у s1 — pop). */
function sfxStoryboard(): Storyboard {
  const sb = structuredClone(fixtureStoryboard);
  const events = JSON.parse(readFileSync(path.join(FIXTURES, "events.json"), "utf8")) as Record<
    string,
    unknown
  >;
  for (const scene of sb.scenes) (scene as { events: unknown }).events = events[scene.id] ?? [];
  return Storyboard.parse(sb);
}

/** Розкадровка, check.json зі стрічками (обидва формати) і аркушами моментів (s1, s2) ревізії. */
async function seedRev(
  storage: LocalStorage,
  rev: number,
  opts: { moments?: boolean; tint?: Partial<Record<string, [string, string]>> } = {},
): Promise<Storyboard> {
  const rp = revPaths("p1", rev);
  const sb = sfxStoryboard();
  await storage.writeJson(rp.storyboard, sb);
  const raw = readFileSync(path.join(FIXTURES, "check.json"), "utf8").replaceAll("REV/", `${rp.root}/`);
  const check = JSON.parse(raw) as {
    stills: Array<{ sceneId: string; path: string }>;
    moments: Array<{ sceneId: string; path: string }>;
  };
  if (opts.moments === false) check.moments = [];
  await storage.writeJson(rp.check, check);
  const colors = (id: string) => opts.tint?.[id] ?? COLORS[id] ?? ["#000000", "#ffffff"];
  for (const s of check.stills) {
    const [a, b] = colors(s.sceneId);
    await storage.write(s.path, makeGradientPng(90, 160, a, b));
    const format = s.path.includes("/square/") ? "square" : "vertical";
    await storage.write(rp.stripSheet(format, s.sceneId), makeGradientPng(200, 120, a, b));
  }
  for (const m of check.moments) {
    const [a, b] = colors(m.sceneId);
    await storage.write(m.path, makeGradientPng(240, 150, b, a));
  }
  return sb;
}

const d = (
  sceneId: string,
  eventId: string,
  cue: SoundCue | null,
  accent: SoundAccent = "normal",
): SfxDecision => ({
  sceneId,
  eventId,
  sound: cue ? { cue, accent } : null,
  reason: `${eventId}: reason`,
});

/** План у межах лімітів: 3 удари, один cash, один тембр у сценах. */
const GOOD = [
  d("s1", "logo-in", "pop"),
  d("s1", "title-type", "typing"),
  d("s1", "cup-land", "impact", "hard"),
  d("s2", "price-hit", null),
  d("s2", "badge-in", "pop", "soft"),
  d("s2", "coins", "cash"),
  d("s3", "cta-in", "slam", "hard"),
  d("s3", "cta-cash", null),
  d("s3", "logo-drop", "drop", "hard"),
];

/** План з порушеннями: 4 удари, 3 cash, у s1 pop і ding. */
const BAD = [
  d("s1", "logo-in", "pop"),
  d("s1", "title-type", "ding"),
  d("s1", "cup-land", "impact", "hard"),
  d("s2", "price-hit", "impact", "hard"),
  d("s2", "badge-in", "cash"),
  d("s2", "coins", "cash"),
  d("s3", "cta-in", "slam", "hard"),
  d("s3", "cta-cash", "cash"),
  d("s3", "logo-drop", "drop", "hard"),
];

const reply = (decisions: SfxDecision[], notes = "Три удари: чашка, кнопка, лого."): Reply => ({
  json: { decisions, notes },
});

function callImages(params: unknown): number {
  const p = params as { messages: Array<{ content: Array<{ type: string }> }> };
  return (p.messages[0]?.content ?? []).filter((c) => c.type === "image").length;
}

type Block = { type: string; cache_control?: unknown };

/** Форма запиту: типи блоків system і `messages[0].content`, `+cache` — блок із `cache_control`. */
function requestShape(params: unknown): { system: string[]; user: string[] } {
  const p = params as { system: Block[]; messages: Array<{ content: Block[] }> };
  const shape = (b: Block) => (b.cache_control ? `${b.type}+cache` : b.type);
  return { system: p.system.map(shape), user: (p.messages[0]?.content ?? []).map(shape) };
}

/** Мільйон вхідних і 100k вихідних токенів: Opus 5.5 — $6, Sonnet 5.5 — $3. */
const BIG_USAGE = { input_tokens: 1_000_000, output_tokens: 100_000 };

const stageWith = (env: Record<string, string> = {}) => createSfxStage({ tuning: () => readTuning(env) });

async function readPlan(storage: LocalStorage, rev = 1): Promise<SfxPlan> {
  return storage.readJson(revPaths("p1", rev).sfxPlan, (v) => SfxPlan.parse(v));
}

describe("sfxStage", () => {
  it("пише план за відповіддю моделі, відкидає невідомі id, план накладається на розкадровку", async () => {
    const storage = tmpStorage();
    await seedProject(storage, { storyboard: null });
    const sb = await seedRev(storage, 1);
    const ctx = makeCtx(storage, "sfx", { sceneIds: null, instructions: [] }, [
      reply([...GOOD, d("s9", "ghost", "pop"), d("s2", "nope", "ding")]),
    ]);
    const res = await sfxStage(ctx);

    expect(ctx.anthropic.calls).toHaveLength(1);
    expect(res.reused).toBeUndefined();
    // changed: title-type, price-hit, badge-in, cta-cash; muted: price-hit, cta-cash
    expect(res.outputs).toEqual({ sceneIds: ["s1", "s2", "s3"], changed: 4, muted: 2 });
    expect(res.artifacts).toEqual([revPaths("p1", 1).sfxPlan]);

    const call = ctx.anthropic.calls[0]?.params;
    // лише головний формат (vertical): 3 стрічки + аркуші моментів s1 і s2
    expect(callImages(call)).toBe(5);
    const text = userText(call);
    expect(text).toContain("Image 1: scene s1, format vertical, strip of 10 frames");
    expect(text).toContain("Image 2: Moment sheet · scene s1 · vertical");
    expect(text).toContain(
      "- cup-land (at 90): 88 · 2.93s | 89 · 2.97s | 90 · 3.00s | 91 · 3.03s | 92 · 3.07s",
    );
    expect(text).toContain("Image 5: scene s3, format vertical");
    expect(text).toContain("Scene s3: no moment sheet, judge its events from the strip alone.");
    expect(text).not.toContain("format square");
    expect(text).toMatch(/"id": "title-type",[\s\S]*?"draftSound": \{\s*"cue": "tick",\s*"accent": "soft"/);
    expect(text).toContain("| typing | text typed character by character");
    expect(text).toContain("at most 3 in the whole film");
    expect(text).toContain("Decide the sound of every event in the scenes: s1, s2, s3.");
    expect(text).toContain("<instructions>\n(none)\n</instructions>");
    expect(systemText(call)).toContain("You are the studio's sound designer.");

    const plan = await readPlan(storage);
    expect(plan.sceneIds).toEqual(["s1", "s2", "s3"]);
    expect(plan.inputsHash).toBe(res.inputsHash);
    expect(plan.decisions).toEqual(GOOD);
    expect(plan.notes).toBe("Три удари: чашка, кнопка, лого.");
    const applied = applySfxPlan(sb, plan);
    expect(applied.dropped).toEqual([]);
    expect(applied.applied).toBe(9);
    const s1 = applied.storyboard.scenes[0];
    expect(s1?.events.find((e) => e.id === "title-type")?.sound).toEqual({ cue: "typing", accent: "normal" });
    expect(s1?.events.find((e) => e.id === "title-type")?.at).toBe(45);
    expect(sfxViolations(applied.storyboard)).toEqual([]);
    expect(ctx.emitted.events.some((e) => e.type === "progress")).toBe(true);
  });

  it("порушення лімітів → один точковий ретрай з тими самими зображеннями; виправлений план приймається", async () => {
    const storage = tmpStorage();
    await seedProject(storage, { storyboard: null });
    await seedRev(storage, 1);
    const ctx = makeCtx(storage, "sfx", { sceneIds: null, instructions: [] }, [reply(BAD), reply(GOOD)]);
    const res = await sfxStage(ctx);

    expect(ctx.anthropic.calls).toHaveLength(2);
    const first = ctx.anthropic.calls[0]?.params;
    const second = ctx.anthropic.calls[1]?.params;
    expect(callImages(second)).toBe(callImages(first));
    const retry = userText(second);
    expect(retry).toContain("<previous_answer>");
    expect(retry).toContain(
      "heavy hits: 4 in the film, the limit is 3: s1/cup-land (impact), s2/price-hit (impact), s3/cta-in (slam), s3/logo-drop (drop)",
    );
    expect(retry).toContain(
      "signature cue cash: 3 times in the film, the limit is 2: s2/badge-in (cash), s2/coins (cash), s3/cta-cash (cash)",
    );
    expect(retry).toContain("scene s1 mixes the one-timbre cues pop and ding");
    expect(userText(first)).not.toContain("<previous_answer>");

    expect((await readPlan(storage)).decisions).toEqual(GOOD);
    expect(res.outputs.muted).toBe(2);
  });

  it("жоден user-блок не пише кеш (і в ретраї за лімітами), system — з cache_control", async () => {
    const storage = tmpStorage();
    await seedProject(storage, { storyboard: null });
    await seedRev(storage, 1);
    const ctx = makeCtx(storage, "sfx", { sceneIds: null, instructions: [] }, [reply(BAD), reply(GOOD)]);
    await stageWith()(ctx);

    expect(ctx.anthropic.calls).toHaveLength(2);
    for (const { params } of ctx.anthropic.calls) {
      const shape = requestShape(params);
      // 5 кадрів, userCached (розкадровка, cue, previousPlan) без cache_control, хвіст
      expect(shape.user).toEqual(["image", "image", "image", "image", "image", "text", "text"]);
      expect(shape.system).toEqual(["text+cache"]);
    }
    expect(userText(ctx.anthropic.calls[1]?.params)).toContain("<previous_answer>");
    expect((await readPlan(storage)).decisions).toEqual(GOOD);
  });

  it("ADC_SFX_MODEL=claude-sonnet-5-5 → обидва виклики на Sonnet, витрати за цінами Sonnet", async () => {
    const storage = tmpStorage();
    await seedProject(storage, { storyboard: null });
    await seedRev(storage, 1);
    const ctx = makeCtx(storage, "sfx", { sceneIds: null, instructions: [] }, [
      { ...reply(BAD), usage: BIG_USAGE },
      { ...reply(GOOD), usage: BIG_USAGE },
    ]);
    await stageWith({ ADC_SFX_MODEL: "claude-sonnet-5-5" })(ctx);

    expect(ctx.anthropic.calls.map((c) => (c.params as { model: string }).model)).toEqual([
      "claude-sonnet-5-5",
      "claude-sonnet-5-5",
    ]);
    const costs = (await readCosts(storage, PROJECT_ID)).filter((e) => e.promptName === "sfx-design");
    expect(costs.map((e) => [e.model, e.usd, e.detail ?? null])).toEqual([
      ["claude-sonnet-5-5", 3, null],
      ["claude-sonnet-5-5", 3, "limits-retry"],
    ]);
    expect(costs[0]?.unitPrices).toMatchObject({ input: 2, output: 10 });
  });

  it("без ADC_SFX_MODEL — модель із frontmatter (Opus 5.5) і ціни Opus", async () => {
    const storage = tmpStorage();
    await seedProject(storage, { storyboard: null });
    await seedRev(storage, 1);
    const ctx = makeCtx(storage, "sfx", { sceneIds: null, instructions: [] }, [
      { ...reply(GOOD), usage: BIG_USAGE },
    ]);
    await stageWith()(ctx);

    expect(ctx.anthropic.calls.map((c) => (c.params as { model: string }).model)).toEqual([
      "claude-opus-5-5",
    ]);
    const costs = (await readCosts(storage, PROJECT_ID)).filter((e) => e.promptName === "sfx-design");
    expect(costs.map((e) => [e.model, e.usd])).toEqual([["claude-opus-5-5", 6]]);
  });

  it("план іншої моделі за хешем не перевикористовується", async () => {
    const storage = tmpStorage();
    await seedProject(storage, { storyboard: null });
    await seedRev(storage, 1);
    const first = await stageWith()(
      makeCtx(storage, "sfx", { sceneIds: null, instructions: [] }, [reply(GOOD)]),
    );
    const ctx = makeCtx(storage, "sfx", { sceneIds: null, instructions: [] }, [reply(GOOD)]);
    const second = await stageWith({ ADC_SFX_MODEL: "claude-sonnet-5-5" })(ctx);
    expect(ctx.anthropic.calls).toHaveLength(1);
    expect(second.reused).toBeUndefined();
    expect(second.inputsHash).not.toBe(first.inputsHash);
  });

  it("порушення й після ретраю → зайві звуки вимикаються детерміновано від кінця ролика", async () => {
    const storage = tmpStorage();
    await seedProject(storage, { storyboard: null });
    const sb = await seedRev(storage, 1);
    const ctx = makeCtx(storage, "sfx", { sceneIds: null, instructions: [] }, [reply(BAD), reply(BAD)]);
    await sfxStage(ctx);

    expect(ctx.anthropic.calls).toHaveLength(2);
    const plan = await readPlan(storage);
    const sound = (sceneId: string, eventId: string) =>
      plan.decisions.find((x) => x.sceneId === sceneId && x.eventId === eventId)?.sound;
    // один тембр у s1: лишається pop (перший), ding замовкає
    expect(sound("s1", "title-type")).toBeNull();
    expect(sound("s1", "logo-in")).toEqual({ cue: "pop", accent: "normal" });
    // удари: останній у ролику (logo-drop) замовкає, решта лишається
    expect(sound("s3", "logo-drop")).toBeNull();
    expect(sound("s3", "cta-in")).toEqual({ cue: "slam", accent: "hard" });
    expect(sound("s2", "price-hit")).toEqual({ cue: "impact", accent: "hard" });
    // cash: останній у ролику — s3/cta-cash (кадр 60 s3 пізніше за s2/coins)
    expect(sound("s3", "cta-cash")).toBeNull();
    expect(sound("s2", "coins")).toEqual({ cue: "cash", accent: "normal" });
    expect(sound("s2", "badge-in")).toEqual({ cue: "cash", accent: "normal" });
    expect(plan.decisions.find((x) => x.eventId === "logo-drop")?.reason).toMatch(/^Muted by code/);
    expect(sfxViolations(applySfxPlan(sb, plan).storyboard)).toEqual([]);
  });

  it("повторний запуск із тими самими входами — без виклику моделі (reused)", async () => {
    const storage = tmpStorage();
    await seedProject(storage, { storyboard: null });
    await seedRev(storage, 1);
    const first = await sfxStage(
      makeCtx(storage, "sfx", { sceneIds: null, instructions: [] }, [reply(GOOD)]),
    );
    const ctx2 = makeCtx(storage, "sfx", { sceneIds: null, instructions: [] }, []);
    const second = await sfxStage(ctx2);
    expect(ctx2.anthropic.calls).toHaveLength(0);
    expect(second.reused).toBe(true);
    expect(second.inputsHash).toBe(first.inputsHash);
    expect(second.outputs).toEqual(first.outputs);

    // нові instructions — нові входи: модель викликається знову і бачить попередній план
    const issue = ReviewIssue.parse({
      scope: "scene",
      sceneId: "s2",
      eventId: "coins",
      frame: 105,
      severity: "major",
      kind: "sfx_wrong_cue",
      description: "Монети падають без звуку монет.",
      fix: "Постав cash із hard акцентом.",
    });
    const ctx3 = makeCtx(storage, "sfx", { sceneIds: ["s2"], instructions: [issue] }, [
      reply([
        d("s2", "price-hit", null),
        d("s2", "badge-in", "pop", "soft"),
        d("s2", "coins", "cash", "hard"),
      ]),
    ]);
    const third = await sfxStage(ctx3);
    expect(ctx3.anthropic.calls).toHaveLength(1);
    const text = userText(ctx3.anthropic.calls[0]?.params);
    expect(text).toContain(
      "- [sfx_wrong_cue, major] s2, event coins, frame 105: Монети падають без звуку монет. → Постав cash із hard акцентом.",
    );
    expect(text).toMatch(/<previous_plan>[\s\S]*"eventId": "coins"[\s\S]*<\/previous_plan>/);
    expect(third.outputs.sceneIds).toEqual(["s2"]);
    const plan = await readPlan(storage);
    // s1 і s3 — з попереднього плану цієї ревізії
    expect(plan.decisions).toEqual([...GOOD.slice(0, 5), d("s2", "coins", "cash", "hard"), ...GOOD.slice(6)]);
  });

  it("ревізія зі scope-підмножиною: сцени поза scope беруться з плану ревізії-основи", async () => {
    const storage = tmpStorage();
    await seedProject(storage, { rev: 2, storyboard: null });
    await seedRev(storage, 1);
    await sfxStage(makeCtx(storage, "sfx", { sceneIds: null, instructions: [] }, [reply(GOOD)]));
    const base = await readPlan(storage, 1);

    await seedRev(storage, 2, { tint: { s2: ["#FFFFFF", "#000000"] } });
    const ctx = makeCtx(
      storage,
      "sfx",
      { sceneIds: ["s2"], instructions: [] },
      [
        reply([
          d("s2", "price-hit", null),
          d("s2", "badge-in", "ding"),
          d("s2", "coins", "cash", "hard"),
          d("s1", "logo-in", "ding"),
        ]),
      ],
      { rev: 2 },
    );
    const res = await sfxStage(ctx);

    expect(ctx.anthropic.calls).toHaveLength(1);
    const call = ctx.anthropic.calls[0]?.params;
    expect(callImages(call)).toBe(2);
    const text = userText(call);
    expect(text).toContain("Decide the sound of every event in the scenes: s2.");
    expect(text).toMatch(/"id": "s1",\s*"decide": false/);
    expect(text).toMatch(/"id": "s2",\s*"decide": true/);
    expect(res.outputs.sceneIds).toEqual(["s2"]);

    const plan = await readPlan(storage, 2);
    expect(plan.sceneIds).toEqual(["s2"]);
    const of = (p: SfxPlan, id: string) => p.decisions.filter((x) => x.sceneId === id);
    expect(of(plan, "s1")).toEqual(of(base, "s1"));
    expect(of(plan, "s3")).toEqual(of(base, "s3"));
    expect(of(plan, "s2")).toEqual([
      d("s2", "price-hit", null),
      d("s2", "badge-in", "ding"),
      d("s2", "coins", "cash", "hard"),
    ]);
  });

  it("без аркушів моментів стадія працює на самих стрічках", async () => {
    const storage = tmpStorage();
    await seedProject(storage, { storyboard: null });
    await seedRev(storage, 1, { moments: false });
    const ctx = makeCtx(storage, "sfx", { sceneIds: null, instructions: [] }, [reply(GOOD)]);
    const res = await sfxStage(ctx);
    const call = ctx.anthropic.calls[0]?.params;
    expect(callImages(call)).toBe(3);
    const text = userText(call);
    for (const id of ["s1", "s2", "s3"]) {
      expect(text).toContain(`Scene ${id}: no moment sheet, judge its events from the strip alone.`);
    }
    expect(text).not.toContain("Moment sheet ·");
    expect(res.outputs.sceneIds).toEqual(["s1", "s2", "s3"]);
    expect((await readPlan(storage)).decisions).toEqual(GOOD);
  });

  it("без check.json — StageError check_missing (не retryable)", async () => {
    const storage = tmpStorage();
    await seedProject(storage, { storyboard: null });
    await storage.writeJson(revPaths("p1", 1).storyboard, sfxStoryboard());
    const err = await sfxStage(makeCtx(storage, "sfx", { sceneIds: null, instructions: [] })).catch((e) => e);
    expect(err).toBeInstanceOf(StageError);
    expect(err).toMatchObject({ code: "check_missing", retryable: false });
  });
});

describe("ліміти звукорежисера", () => {
  it("sfxViolations: чернетка фікстури — 4 важкі удари", () => {
    const v = sfxViolations(sfxStoryboard());
    expect(v.map((x) => x.rule)).toEqual(["hits"]);
    expect(v[0]?.events.map((e) => e.eventId)).toEqual(["cup-land", "price-hit", "cta-in", "logo-drop"]);
  });

  it("trimToLimits вимикає лише події сцен зі scope, від кінця ролика", () => {
    const sb = sfxStoryboard();
    // scope = s1: єдиний удар у scope — cup-land, він і вимикається
    const r = trimToLimits(sb, [], ["s1"]);
    expect(r.muted).toEqual([{ sceneId: "s1", eventId: "cup-land", rule: "hits" }]);
    expect(r.decisions).toEqual([
      {
        sceneId: "s1",
        eventId: "cup-land",
        sound: null,
        reason: "Muted by code: over the limit of 3 heavy hits in the film.",
      },
    ]);
    // повний scope — останній удар ролику
    expect(trimToLimits(sb, [], ["s1", "s2", "s3"]).muted).toEqual([
      { sceneId: "s3", eventId: "logo-drop", rule: "hits" },
    ]);
  });

  it("таблиця cue: усі 30 cue, детермінована", () => {
    const table = cueTable();
    expect(table.split("\n").filter((l) => /^\| [a-z]+ \|/.test(l) && !l.startsWith("| cue |"))).toHaveLength(
      30,
    );
    expect(table).toBe(cueTable());
    expect(table).toContain(
      "| impact | a structural hit: the hook, the climax, the logo | starts on it | yes | yes |  |  | mono | 5 |  |",
    );
  });
});
