import { describe, expect, it } from "vitest";
import { readTuning, TUNING_ENV, Tuning, TuningError } from "../src/tuning.ts";

describe("readTuning", () => {
  it("дефолти — погоджена конфігурація (film, anchor і решта high, task budget 100 000, qaMaxRounds 2)", () => {
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
    } satisfies Tuning);
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
  ])("невалідне %s=%s — помилка, не тихий дефолт", (name, value) => {
    expect(() => readTuning({ [name]: value })).toThrow(TuningError);
    expect(() => readTuning({ [name]: value })).toThrow(name);
  });
});
