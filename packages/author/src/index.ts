/**
 * `@adc/author` — агентний режим генерації (стадія `author`): один агент пише сцени, рендерить
 * стрипи, дивиться їх і править сам у межах бюджету (ТЗ 2026-10-12 «паритет із роликом», блок C1).
 *
 * Скелет Кроку 0: воркер уже реєструє `authorStage`, оркестратор її ще не ставить.
 */

import { type Stage, StageError } from "@adc/shared";

export const authorStage: Stage<"author"> = async () => {
  throw new StageError(
    "стадія author ще не реалізована",
    "author_not_implemented",
    "Агентний режим генерації ще не готовий — увімкніть звичайний (ADC_GENERATION_MODE=pipeline).",
    false,
  );
};
