import { type StageContext, StageError } from "@adc/shared";
import { describe, expect, it } from "vitest";
import { authorStage } from "../src/index.ts";

describe("authorStage (скелет Кроку 0)", () => {
  it("кидає StageError author_not_implemented без повтору", async () => {
    const err = await authorStage({} as StageContext<"author">).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StageError);
    expect(err).toMatchObject({ code: "author_not_implemented", retryable: false });
  });
});
