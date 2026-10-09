import { revPaths, type Storyboard } from "@adc/shared";
import { fixtureStoryboard } from "@adc/shared/fixtures";
import { describe, expect, it } from "vitest";
import { directorPaths } from "../src/io.ts";
import { type StoryboardMeta, storyboardStage } from "../src/stages/storyboard.ts";
import { makeCtx, PROJECT_ID, type Reply, seedProject, tmpStorage, userText } from "./helpers.ts";

type Scene = Storyboard["scenes"][number];

const LONG_SUB = "Неймовірно довгий підзаголовок, який ніяк не вміщується у два рядки вертикального формату";
const LONG_WORD = "Найнеймовірнішийфантастичнийзаголовок";

/** Розкадровка-чернетка: s2.sub задовгий для vertical і square (2 textIssues). */
function longDraft(): Storyboard {
  const sb = structuredClone(fixtureStoryboard);
  (sb.scenes[1] as Scene).text.sub = LONG_SUB;
  return sb;
}

const FIXED_S2: Scene["text"] = {
  headline: "Капучино — 75 грн",
  sub: "-10% з собою до 10:00",
  emphasis: ["75 грн", "немає в тексті"],
};

/** Відповідь `storyboard-copyfix` для s2 (+ сторонній s1, який стадія має проігнорувати). */
const FIX = {
  scenes: [
    { id: "s2", ...FIXED_S2 },
    { id: "s1", headline: "Чужа сцена", sub: null, emphasis: [] },
  ],
};

async function runStage(replies: Reply[]) {
  const storage = tmpStorage();
  await seedProject(storage, { storyboard: null });
  const ctx = makeCtx(storage, "storyboard", { durationSeconds: null }, replies);
  const res = await storyboardStage(ctx);
  const sb = await storage.readJson<Storyboard>(revPaths(PROJECT_ID, 1).storyboard);
  const meta = await storage.readJson<StoryboardMeta>(directorPaths(PROJECT_ID, 1).storyboardMeta);
  return { ctx, res, sb, meta, storage };
}

/** Блок `<tag>…</tag>` з user-тексту виклику. */
function block(params: unknown, tag: string): string {
  const text = userText(params);
  const m = new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`).exec(text);
  if (!m) throw new Error(`немає <${tag}> у запиті`);
  return m[1] as string;
}

describe("storyboard: точковий ретрай текстів (storyboard-copyfix)", () => {
  it("textIssues → copyfix лише проблемних сцен; решта розкадровки байт у байт", async () => {
    const { ctx, res, sb, meta } = await runStage([{ json: longDraft() }, { json: FIX }]);

    expect(ctx.anthropic.calls).toHaveLength(2);
    const call = ctx.anthropic.calls[1];
    expect(call?.method).toBe("create"); // effort medium → без стріму
    const params = call?.params as { model: string; output_config: { effort: string } };
    expect(params.model).toBe("claude-opus-5-5");
    expect(params.output_config.effort).toBe("medium");

    // На вхід: усі headline підряд, лише проблемні сцени з помилками, copyRules, факти, голос бренду.
    expect(block(call?.params, "headlines")).toBe(
      "s1: Кава, яку обсмажуємо самі\ns2: Капучино — 75 грн\ns3: Забронюйте столик",
    );
    const scenes = JSON.parse(block(call?.params, "scenes_to_fix")) as Array<{
      id: string;
      sub: string;
      limits: { headline: number; sub: number; word: number };
      issues: Array<{ field: string; format: string; kind: string }>;
    }>;
    expect(scenes.map((s) => s.id)).toEqual(["s2"]);
    expect(scenes[0]?.sub).toBe(LONG_SUB);
    expect(scenes[0]?.limits).toEqual({ headline: 54, sub: 36, word: 18 }); // vertical: 18 × 3 / 18 × 2
    expect(scenes[0]?.issues.map((i) => `${i.field}:${i.format}:${i.kind}`)).toEqual([
      "sub:vertical:length",
      "sub:square:length",
    ]);
    expect(JSON.parse(block(call?.params, "copy_rules"))).toEqual(fixtureStoryboard.copyRules);
    expect(block(call?.params, "facts")).toContain("Капучино — 75 грн");
    expect(block(call?.params, "brand")).toContain('"voice"');

    // Злиття + повторна нормалізація: новий текст s2, emphasis без збігу викинуто, s1 не чіпали.
    expect(sb.scenes[1]?.text).toEqual({
      headline: "Капучино — 75 грн",
      sub: "-10% з собою до 10:00",
      emphasis: ["75 грн"],
    });
    expect(sb.scenes[0]?.text.headline).toBe("Кава, яку обсмажуємо самі");
    expect(sb.concept).toBe(fixtureStoryboard.concept);
    expect(sb.scenes.map((s) => s.motionIntent)).toEqual(fixtureStoryboard.scenes.map((s) => s.motionIntent));
    expect(meta.retried).toBe(true);
    expect(meta.textIssues).toEqual([]);
    expect(meta.changes).toContain("s2: emphasis без збігу з текстом");
    expect(res.outputs.unverifiedClaims).toBe(0);

    // Еталон: та сама чернетка, але одразу з виправленим s2 → одна генерація без ретраю.
    const clean = longDraft();
    (clean.scenes[1] as Scene).text = structuredClone(FIXED_S2);
    const ref = await runStage([{ json: clean }]);
    expect(ref.ctx.anthropic.calls).toHaveLength(1);
    expect(ref.meta.retried).toBe(false);
    expect(JSON.stringify(sb)).toBe(JSON.stringify(ref.sb));
    expect(res.outputs).toEqual(ref.res.outputs);
  });

  it("без textIssues copyfix не викликається", async () => {
    const { ctx, meta } = await runStage([{ json: structuredClone(fixtureStoryboard) }]);
    expect(ctx.anthropic.calls).toHaveLength(1);
    expect(meta.retried).toBe(false);
  });

  it("збій copyfix (API) → лишається чернетка з проблемами, стадія не падає", async () => {
    const { ctx, sb, meta, res } = await runStage([{ json: longDraft() }, { error: new Error("boom") }]);
    expect(ctx.anthropic.calls).toHaveLength(2);
    expect(sb.scenes[1]?.text.sub).toBe(LONG_SUB);
    expect(meta.retried).toBe(true);
    expect(meta.textIssues).toHaveLength(2);
    expect(res.outputs.totalFrames).toBeGreaterThan(0);
  });

  it("невалідна відповідь copyfix (двічі) → лишається чернетка", async () => {
    const bad = { json: { scenes: [{ id: "s2", text: "не та схема" }] } };
    const { ctx, sb, meta } = await runStage([{ json: longDraft() }, bad, bad]);
    expect(ctx.anthropic.calls).toHaveLength(3); // відповідь + один повтор після перевірки схеми
    expect(sb.scenes[1]?.text.sub).toBe(LONG_SUB);
    expect(meta.textIssues).toHaveLength(2);
  });

  it("copyfix з більшою кількістю проблем → лишається чернетка", async () => {
    const worse = {
      scenes: [{ id: "s2", headline: LONG_WORD, sub: LONG_SUB, emphasis: [] }],
    };
    const { sb, meta } = await runStage([{ json: longDraft() }, { json: worse }]);
    expect(sb.scenes[1]?.text.headline).toBe("Капучино — 75 грн");
    expect(sb.scenes[1]?.text.sub).toBe(LONG_SUB);
    expect(meta.retried).toBe(true);
    expect(meta.textIssues).toHaveLength(2);
  });
});
