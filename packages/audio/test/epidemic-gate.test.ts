import { describe, expect, it } from "vitest";
import { defaultEpidemicGate, EpidemicGate, epidemicConcurrency } from "../src/epidemic/gate.ts";
import { EpidemicError, type EpidemicErrorKind } from "../src/provider.ts";

function recordingSleep() {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => void waits.push(ms) };
}

/** Функція, що спершу кидає задані помилки, далі повертає "ok". */
function flaky(...errors: Error[]) {
  let calls = 0;
  const fn = async () => {
    calls++;
    const err = errors.shift();
    if (err) throw err;
    return "ok";
  };
  return { fn, calls: () => calls };
}

const err = (kind: EpidemicErrorKind, status: number | null = null) =>
  new EpidemicError(kind, `Epidemic: ${kind}`, status);

describe("EpidemicGate", () => {
  it("429 повторюється з експоненційною паузою 2–30 с", async () => {
    const s = recordingSleep();
    const gate = new EpidemicGate({ sleep: s.sleep });
    const f = flaky(err("rate_limited", 429), err("rate_limited", 429), err("rate_limited", 429));
    expect(await gate.run("search", f.fn)).toBe("ok");
    expect(f.calls()).toBe(4);
    expect(s.waits).toEqual([2_000, 4_000, 8_000]);
  });

  it("server і network теж повторюються", async () => {
    const s = recordingSleep();
    const gate = new EpidemicGate({ sleep: s.sleep });
    const f = flaky(err("server", 503), new TypeError("fetch failed"), err("network"));
    expect(await gate.run("x", f.fn)).toBe("ok");
    expect(f.calls()).toBe(4);
  });

  it("пауза обмежена 30 с; після 5 повторів помилка назовні", async () => {
    const s = recordingSleep();
    const gate = new EpidemicGate({ sleep: s.sleep });
    const f = flaky(...Array.from({ length: 10 }, () => err("rate_limited", 429)));
    await expect(gate.run("x", f.fn)).rejects.toMatchObject({ kind: "rate_limited" });
    expect(f.calls()).toBe(6);
    expect(s.waits).toEqual([2_000, 4_000, 8_000, 16_000, 30_000]);
  });

  it.each(["unauthorized", "not_found", "quota", "aborted", "other"] as const)(
    "%s — одразу назовні, без повтору",
    async (kind) => {
      const s = recordingSleep();
      const gate = new EpidemicGate({ sleep: s.sleep });
      const f = flaky(err(kind, kind === "unauthorized" ? 401 : null));
      await expect(gate.run("x", f.fn)).rejects.toMatchObject({ kind });
      expect(f.calls()).toBe(1);
      expect(s.waits).toEqual([]);
    },
  );

  it("maxConcurrent 2 за замовчуванням: одночасно не більше двох", async () => {
    const gate = new EpidemicGate();
    expect(gate.maxConcurrent).toBe(2);
    let active = 0;
    let peak = 0;
    const job = async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return active;
    };
    await Promise.all(Array.from({ length: 6 }, (_, i) => gate.run(`job${i}`, job)));
    expect(peak).toBe(2);
    expect(gate.peak).toBe(2);
  });

  it("сигнал передається у fn; скасований сигнал не стартує виклик і зупиняє повтори", async () => {
    const s = recordingSleep();
    const gate = new EpidemicGate({ sleep: s.sleep });
    const ctrl = new AbortController();
    let seen: AbortSignal | undefined;
    await gate.run(
      "x",
      async (signal) => {
        seen = signal;
      },
      ctrl.signal,
    );
    expect(seen).toBe(ctrl.signal);

    ctrl.abort();
    const f = flaky(err("rate_limited", 429));
    await expect(gate.run("x", f.fn, ctrl.signal)).rejects.toThrow();
    expect(f.calls()).toBe(0);
  });

  it("скасування під час повтору — помилка назовні без нового виклику", async () => {
    const ctrl = new AbortController();
    const gate = new EpidemicGate({
      sleep: async () => {
        ctrl.abort();
      },
    });
    const f = flaky(err("server", 500), err("server", 500));
    await expect(gate.run("x", f.fn, ctrl.signal)).rejects.toThrow();
    expect(f.calls()).toBe(1);
  });
});

describe("epidemicConcurrency", () => {
  it("EPIDEMIC_CONCURRENCY, інакше 2", () => {
    expect(epidemicConcurrency({})).toBe(2);
    expect(epidemicConcurrency({ EPIDEMIC_CONCURRENCY: "1" })).toBe(1);
    expect(epidemicConcurrency({ EPIDEMIC_CONCURRENCY: "4" })).toBe(4);
    expect(epidemicConcurrency({ EPIDEMIC_CONCURRENCY: "0" })).toBe(2);
    expect(epidemicConcurrency({ EPIDEMIC_CONCURRENCY: "abc" })).toBe(2);
  });
});

describe("defaultEpidemicGate", () => {
  it("спільний екземпляр процесу", () => {
    const a = defaultEpidemicGate();
    expect(defaultEpidemicGate()).toBe(a);
    expect(a).toBeInstanceOf(EpidemicGate);
  });
});
