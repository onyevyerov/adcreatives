import { describe, expect, it } from "vitest";
import { classifyElevenLabsError } from "../src/errors.ts";
import { busyBody, concurrencyBody, elError, instantGate, wrappedDetailedError } from "./helpers.ts";

describe("classifyElevenLabsError", () => {
  it("429 too_many_concurrent_requests → concurrency; system_busy → busy", () => {
    expect(classifyElevenLabsError(elError(429, concurrencyBody))).toMatchObject({
      kind: "concurrency",
      status: 429,
      code: "too_many_concurrent_requests",
    });
    expect(classifyElevenLabsError(elError(429, busyBody)).kind).toBe("busy");
    expect(classifyElevenLabsError(elError(503, { detail: "unavailable" })).kind).toBe("busy");
    expect(classifyElevenLabsError(elError(429, { detail: { status: "quota_exceeded" } })).kind).toBe(
      "other",
    );
    expect(classifyElevenLabsError(elError(401, { detail: "bad key" })).kind).toBe("other");
  });

  it("works when the SDK wrapper rethrows a plain Error (composeDetailed): status and body from the message", () => {
    const info = classifyElevenLabsError(wrappedDetailedError(429, concurrencyBody));
    expect(info).toMatchObject({ kind: "concurrency", status: 429 });
  });

  it("bad prompt: extracts prompt and composition plan suggestions (camelCased)", () => {
    const prompt = classifyElevenLabsError(
      elError(400, {
        detail: {
          status: "bad_prompt",
          message: "artist name",
          data: { prompt_suggestion: "warm lo-fi beat" },
        },
      }),
    );
    expect(prompt).toMatchObject({
      kind: "bad_prompt",
      promptSuggestion: "warm lo-fi beat",
      planSuggestion: null,
    });

    const plan = classifyElevenLabsError(
      wrappedDetailedError(400, {
        detail: {
          status: "bad_composition_plan",
          data: {
            composition_plan_suggestion: {
              chunks: [
                { text: "[intro]", duration_ms: 5000, positive_styles: ["calm"], context_adherence: "high" },
              ],
            },
          },
        },
      }),
    );
    expect(plan.kind).toBe("bad_prompt");
    expect(plan.planSuggestion).toEqual({
      chunks: [{ text: "[intro]", durationMs: 5000, positiveStyles: ["calm"], contextAdherence: "high" }],
    });
  });
});

describe("ElevenLabsGate", () => {
  it("limits local concurrency", async () => {
    const gate = instantGate(2);
    let release!: () => void;
    const blocker = new Promise<void>((r) => (release = r));
    let running = 0;
    let maxRunning = 0;
    const task = () =>
      gate.run("t", async () => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        await blocker;
        running--;
        return 1;
      });
    const all = Promise.all([task(), task(), task(), task(), task()]);
    await new Promise((r) => setTimeout(r, 10));
    expect(running).toBe(2);
    release();
    expect(await all).toEqual([1, 1, 1, 1, 1]);
    expect(maxRunning).toBe(2);
    expect(gate.peak).toBe(2);
  });

  it("too_many_concurrent_requests: narrows the queue, backs off and retries", async () => {
    const gate = instantGate(3);
    let calls = 0;
    let release!: () => void;
    const blocker = new Promise<void>((r) => (release = r));
    // Два довгі запити займають слоти; третій отримує 429 від «сервера».
    const long = () => gate.run("long", () => blocker.then(() => "ok"));
    const a = long();
    const b = long();
    const third = gate.run("third", async () => {
      calls++;
      if (calls === 1) throw elError(429, concurrencyBody);
      return "third-ok";
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(gate.currentLimit).toBe(2);
    release();
    expect(await Promise.all([a, b, third])).toEqual(["ok", "ok", "third-ok"]);
    expect(calls).toBe(2);
    expect(gate.sleeps).toEqual([2_000]);
  });

  it("system_busy: exponential backoff retry; gives up after maxRetries", async () => {
    const gate = instantGate(1);
    let calls = 0;
    const res = await gate.run("busy", async () => {
      calls++;
      if (calls < 3) throw elError(429, busyBody);
      return "done";
    });
    expect(res).toBe("done");
    expect(gate.sleeps).toEqual([2_000, 4_000]);

    let failing = 0;
    await expect(
      gate.run("always-busy", async () => {
        failing++;
        throw elError(429, busyBody);
      }),
    ).rejects.toThrow();
    expect(failing).toBe(6);
  });

  it("non-transient errors are not retried", async () => {
    const gate = instantGate(1);
    let calls = 0;
    await expect(
      gate.run("bad", async () => {
        calls++;
        throw elError(400, { detail: { status: "bad_prompt" } });
      }),
    ).rejects.toThrow();
    expect(calls).toBe(1);
    expect(gate.sleeps).toEqual([]);
  });
});
