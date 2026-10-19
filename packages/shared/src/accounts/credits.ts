import { readFileSync } from "node:fs";
import path from "node:path";
import { findRepoRoot } from "../env.ts";
import { CreditsConfig } from "./schemas.ts";

/** Читає `config/credits.json`; невалідний або відсутній файл — виняток (як `loadPrices`). */
export function loadCredits(
  file: string = path.join(findRepoRoot(), "config", "credits.json"),
): CreditsConfig {
  return CreditsConfig.parse(JSON.parse(readFileSync(file, "utf8")));
}

/** Конфіг кредитів для тестів (ті самі плейсхолдери, що в `config/credits.json`). */
export function defaultCredits(overrides: Partial<CreditsConfig> = {}): CreditsConfig {
  return CreditsConfig.parse({
    checkedAt: "2026-10-19",
    currency: "credits",
    creditsPerUsd: 1,
    prices: { video: 10, revision: 3, extraFormat: 2 },
    packages: [
      { id: "starter", credits: 10, priceUsd: 10, label: "Старт" },
      { id: "standard", credits: 25, priceUsd: 25, label: "Кілька роликів" },
      { id: "pro", credits: 60, priceUsd: 60, label: "Серія" },
    ],
    custom: { min: 5, max: 500 },
    signupBonus: 0,
    ...overrides,
  });
}
