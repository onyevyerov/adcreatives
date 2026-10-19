import { describe, expect, it } from "vitest";
import { clientIp, createRateLimiter } from "../src/ratelimit.ts";

const T0 = new Date("2026-10-19T10:00:00.000Z").getTime();
const MIN = 60_000;

function clocked() {
  let t = T0;
  return {
    now: () => new Date(t),
    set: (ms: number) => {
      t = T0 + ms;
    },
  };
}

describe("createRateLimiter", () => {
  it("10 спроб дозволено, 11-та у вікні — перевищення", () => {
    const clock = clocked();
    const rl = createRateLimiter({ max: 10, windowMs: 15 * MIN, now: clock.now });
    for (let i = 0; i < 10; i++) expect(rl.hit("ip|a@example.com"), `спроба ${i + 1}`).toBe(false);
    expect(rl.hit("ip|a@example.com")).toBe(true);
    expect(rl.hit("ip|a@example.com")).toBe(true);
  });

  it("ключі незалежні", () => {
    const clock = clocked();
    const rl = createRateLimiter({ max: 2, windowMs: 15 * MIN, now: clock.now });
    rl.hit("a");
    rl.hit("a");
    expect(rl.hit("a")).toBe(true);
    expect(rl.hit("b")).toBe(false);
  });

  it("ковзне вікно: спроби старші за windowMs випадають по одній", () => {
    const clock = clocked();
    const rl = createRateLimiter({ max: 3, windowMs: 15 * MIN, now: clock.now });
    for (const m of [0, 5, 10]) {
      clock.set(m * MIN);
      expect(rl.hit("k")).toBe(false);
    }
    clock.set(14 * MIN);
    expect(rl.hit("k")).toBe(true);
    // Рівно 15 хв від першої — вона вже поза вікном, звільнилося одне місце.
    clock.set(15 * MIN);
    expect(rl.hit("k")).toBe(false);
    expect(rl.hit("k")).toBe(true);
  });

  it("відхилені спроби не подовжують блок", () => {
    const clock = clocked();
    const rl = createRateLimiter({ max: 1, windowMs: 15 * MIN, now: clock.now });
    expect(rl.hit("k")).toBe(false);
    for (const m of [1, 7, 14]) {
      clock.set(m * MIN);
      expect(rl.hit("k")).toBe(true);
    }
    clock.set(15 * MIN);
    expect(rl.hit("k")).toBe(false);
  });

  it("без now — реальний годинник", () => {
    const rl = createRateLimiter({ max: 1, windowMs: MIN });
    expect(rl.hit("k")).toBe(false);
    expect(rl.hit("k")).toBe(true);
  });
});

describe("clientIp", () => {
  it("перший елемент x-forwarded-for, інакше local", () => {
    expect(clientIp("203.0.113.7, 10.0.0.1")).toBe("203.0.113.7");
    expect(clientIp(" 203.0.113.7 ")).toBe("203.0.113.7");
    expect(clientIp(undefined)).toBe("local");
    expect(clientIp("")).toBe("local");
    expect(clientIp(" , 10.0.0.1")).toBe("local");
  });
});
