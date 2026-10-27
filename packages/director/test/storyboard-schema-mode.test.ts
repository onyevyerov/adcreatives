import { Storyboard, toStrictJsonSchema } from "@adc/shared";
import { fixtureStoryboard } from "@adc/shared/fixtures";
import { describe, expect, it } from "vitest";
import { storyboardStage } from "../src/stages/storyboard.ts";
import { makeCtx, seedProject, tmpStorage, userText } from "./helpers.ts";

type Params = { model: string; output_config: { format?: unknown } };

/** `schema_mode: prompt` у frontmatter `storyboard.md`: схема в тексті, без спроби граматики API. */
describe("storyboard: schema_mode prompt", () => {
  it("перший виклик у свіжому процесі — без output_config.format, схема в тексті; один виклик API", async () => {
    const storage = tmpStorage();
    await seedProject(storage, { storyboard: null });
    const ctx = makeCtx(storage, "storyboard", { durationSeconds: null }, [
      { json: structuredClone(fixtureStoryboard) },
    ]);
    await storyboardStage(ctx);

    expect(ctx.anthropic.calls).toHaveLength(1);
    const params = ctx.anthropic.calls[0]?.params as unknown as Params;
    expect(params.output_config.format).toBeUndefined();
    const text = userText(params);
    expect(text).toContain("Формат відповіді: лише один JSON-об'єкт");
    expect(text).toContain(
      `<json_schema>\n${JSON.stringify(toStrictJsonSchema(Storyboard))}\n</json_schema>`,
    );
  });

  it("невалідна відповідь → один валідаційний повтор, теж зі схемою в тексті", async () => {
    const storage = tmpStorage();
    await seedProject(storage, { storyboard: null });
    const ctx = makeCtx(storage, "storyboard", { durationSeconds: null }, [
      { text: 'Ось розкадровка: {"scenes": []}' },
      { text: `\`\`\`json\n${JSON.stringify(fixtureStoryboard)}\n\`\`\`` },
    ]);
    await storyboardStage(ctx);

    expect(ctx.anthropic.calls).toHaveLength(2);
    const [first, second] = ctx.anthropic.calls.map((c) => c.params as unknown as Params);
    for (const p of [first, second]) {
      expect(p?.output_config.format).toBeUndefined();
      expect(userText(p)).toContain("<json_schema>");
    }
    expect(userText(first)).not.toContain("не пройшла перевірку");
    const retry = userText(second);
    expect(retry).toContain("Попередня відповідь на це завдання не пройшла перевірку");
    expect(retry).toContain('<previous_answer>\nОсь розкадровка: {"scenes": []}\n</previous_answer>');
  });
});
