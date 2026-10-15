import { describe, expect, it } from "vitest";
import { readTuning, TUNING_ENV, Tuning, TuningError } from "../src/tuning.ts";

describe("readTuning", () => {
  it("дефолти — погоджена конфігурація (film, anchor і решта high, task budget 100 000, qaMaxRounds 2, pipeline)", () => {
    expect(readTuning({})).toEqual({
      codegenMode: "film",
      codegenAnchorEffort: "high",
      codegenRestEffort: "high",
      codegenRestModel: null,
      codegenMaxTokens: null,
      codegenTaskBudget: 100_000,
      codegenConcurrency: 5,
      fixCheckEffort: null,
      speculativeRender: false,
      qaMaxRounds: 2,
      generationMode: "pipeline",
      authorTokenBudget: 3_000_000,
      authorMaxIterations: 40,
      authorMaxMinutes: 25,
      sfxMode: "designer",
      filmReview: true,
      reviewMaxRounds: 1,
    } satisfies Tuning);
  });

  it("звукорежисер і рецензент — через env, відкат без деплою", () => {
    expect(
      readTuning({ ADC_SFX_MODE: "storyboard", ADC_FILM_REVIEW: "off", ADC_REVIEW_MAX_ROUNDS: "2" }),
    ).toMatchObject({ sfxMode: "storyboard", filmReview: false, reviewMaxRounds: 2 });
    expect(() => readTuning({ ADC_REVIEW_MAX_ROUNDS: "3" })).toThrow();
    expect(() => readTuning({ ADC_FILM_REVIEW: "maybe" })).toThrow();
  });

  it("відкат до послідовної генерації — через env", () => {
    const t = readTuning({
      ADC_CODEGEN_MODE: "sequential",
      ADC_CODEGEN_ANCHOR_EFFORT: "xhigh",
      ADC_CODEGEN_REST_EFFORT: "high",
    });
    expect(t).toMatchObject({
      codegenMode: "sequential",
      codegenAnchorEffort: "xhigh",
      codegenRestEffort: "high",
    });
  });

  it("агентний режим і бюджети стадії author — через env", () => {
    expect(
      readTuning({
        ADC_GENERATION_MODE: "agent",
        ADC_AUTHOR_TOKEN_BUDGET: "1500000",
        ADC_AUTHOR_MAX_ITERATIONS: "60",
        ADC_AUTHOR_MAX_MINUTES: "30",
      }),
    ).toMatchObject({
      generationMode: "agent",
      authorTokenBudget: 1_500_000,
      authorMaxIterations: 60,
      authorMaxMinutes: 30,
    });
  });

  it("усі поля читаються з env; порожнє значення — дефолт", () => {
    const t = readTuning({
      ADC_CODEGEN_REST_MODEL: "claude-sonnet-5-5",
      ADC_CODEGEN_MAX_TOKENS: "64000",
      ADC_CODEGEN_TASK_BUDGET: "25000",
      ADC_CODEGEN_CONCURRENCY: "3",
      ADC_FIX_CHECK_EFFORT: "medium",
      ADC_SPECULATIVE_RENDER: "true",
      ADC_QA_MAX_ROUNDS: "3",
      ADC_CODEGEN_MODE: "  ",
    });
    expect(t).toMatchObject({
      codegenMode: "film",
      codegenRestModel: "claude-sonnet-5-5",
      codegenMaxTokens: 64000,
      codegenTaskBudget: 25000,
      codegenConcurrency: 3,
      fixCheckEffort: "medium",
      speculativeRender: true,
      qaMaxRounds: 3,
    });
    expect(readTuning({ ADC_CODEGEN_MODE: "fanout" }).codegenMode).toBe("fanout");
    expect(readTuning({ ADC_SPECULATIVE_RENDER: "0" }).speculativeRender).toBe(false);
    expect(Object.keys(TUNING_ENV).sort()).toEqual(Object.keys(Tuning.shape).sort());
  });

  it.each([
    ["ADC_CODEGEN_MODE", "parallel"],
    ["ADC_CODEGEN_ANCHOR_EFFORT", "huge"],
    ["ADC_CODEGEN_MAX_TOKENS", "lots"],
    ["ADC_CODEGEN_TASK_BUDGET", "10000"],
    ["ADC_CODEGEN_CONCURRENCY", "0"],
    ["ADC_QA_MAX_ROUNDS", "4"],
    ["ADC_CODEGEN_CONCURRENCY", "2.5"],
    ["ADC_SPECULATIVE_RENDER", "yes"],
    ["ADC_GENERATION_MODE", "auto"],
    ["ADC_AUTHOR_TOKEN_BUDGET", "100000"],
    ["ADC_AUTHOR_MAX_ITERATIONS", "100"],
    ["ADC_AUTHOR_MAX_MINUTES", "2"],
  ])("невалідне %s=%s — помилка, не тихий дефолт", (name, value) => {
    expect(() => readTuning({ [name]: value })).toThrow(TuningError);
    expect(() => readTuning({ [name]: value })).toThrow(name);
  });
});
