import { readFileSync } from "node:fs";
import path from "node:path";
import { findRepoRoot } from "../env.ts";
import { Prices, type TokenUnitsInput } from "../schemas/cost.ts";

export function loadPrices(file: string = path.join(findRepoRoot(), "config", "prices.json")): Prices {
  return Prices.parse(JSON.parse(readFileSync(file, "utf8")));
}

export interface Priced {
  usd: number;
  unitPrices: Record<string, number>;
}

const round = (usd: number) => Math.round(usd * 1e6) / 1e6;

export class UnknownPriceError extends Error {
  override name = "UnknownPriceError";
}

/** Вартість виклику Anthropic за usage. Ціни — USD за 1 млн токенів. */
export function priceAnthropic(prices: Prices, model: string, units: TokenUnitsInput): Priced {
  const p = prices.anthropic[model];
  if (!p) throw new UnknownPriceError(`немає ціни для моделі ${model} у config/prices.json`);
  const usd =
    (units.input * p.input +
      units.output * p.output +
      units.cacheWrite * p.cacheWrite +
      (units.cacheWrite1h ?? 0) * p.cacheWrite1h +
      units.cacheRead * p.cacheRead) /
    1e6;
  return {
    usd: round(usd),
    unitPrices: {
      input: p.input,
      output: p.output,
      cacheWrite: p.cacheWrite,
      cacheWrite1h: p.cacheWrite1h,
      cacheRead: p.cacheRead,
    },
  };
}

export function priceElevenLabs(prices: Prices, kind: "music" | "sfx", seconds: number): Priced {
  const perMinute = kind === "music" ? prices.elevenlabs.musicPerMinute : prices.elevenlabs.sfxPerMinute;
  return { usd: round((seconds / 60) * perMinute), unitPrices: { perMinute } };
}

export function priceRemotion(prices: Prices, renders: number): Priced {
  return {
    usd: round(renders * prices.remotion.perRender),
    unitPrices: { perRender: prices.remotion.perRender },
  };
}
