import { z } from "zod";
import { MIN_TASK_BUDGET } from "./llm/client.ts";
import { Effort } from "./llm/prompts.ts";

/**
 * Перемикачі вартості й якості генерації (env воркера). Дефолти — погоджена конфігурація:
 * fanout, effort `high` для anchor і решти (ТЗ 2026-10-09 «якість відео»: Opus 5.5 `high` для творчих стадій).
 * Режим `film` (один автор — весь фільм за один виклик) реалізує стадія codegen; дефолт на нього
 * перемикається разом із реалізацією (`ADC_CODEGEN_MODE=film`).
 * Відкат до послідовної генерації:
 * `ADC_CODEGEN_MODE=sequential ADC_CODEGEN_ANCHOR_EFFORT=xhigh ADC_CODEGEN_REST_EFFORT=high`.
 * `qaMaxRounds` — кількість кіл QA → fix перед чекпоінтом 3.
 * `null` — значення з frontmatter промпта.
 */
export const Tuning = z.object({
  codegenMode: z.enum(["sequential", "fanout", "film"]).default("fanout"),
  codegenAnchorEffort: Effort.default("high"),
  codegenRestEffort: Effort.default("high"),
  codegenRestModel: z.string().min(1).nullable().default(null),
  codegenMaxTokens: z.number().int().positive().nullable().default(null),
  codegenTaskBudget: z.number().int().min(MIN_TASK_BUDGET).nullable().default(null),
  codegenConcurrency: z.number().int().min(1).max(32).default(5),
  fixCheckEffort: Effort.nullable().default(null),
  speculativeRender: z.boolean().default(false),
  qaMaxRounds: z.number().int().min(0).max(3).default(2),
});
export type Tuning = z.infer<typeof Tuning>;

/** Поле `Tuning` → змінна оточення. */
export const TUNING_ENV: Record<keyof Tuning, string> = {
  codegenMode: "ADC_CODEGEN_MODE",
  codegenAnchorEffort: "ADC_CODEGEN_ANCHOR_EFFORT",
  codegenRestEffort: "ADC_CODEGEN_REST_EFFORT",
  codegenRestModel: "ADC_CODEGEN_REST_MODEL",
  codegenMaxTokens: "ADC_CODEGEN_MAX_TOKENS",
  codegenTaskBudget: "ADC_CODEGEN_TASK_BUDGET",
  codegenConcurrency: "ADC_CODEGEN_CONCURRENCY",
  fixCheckEffort: "ADC_FIX_CHECK_EFFORT",
  speculativeRender: "ADC_SPECULATIVE_RENDER",
  qaMaxRounds: "ADC_QA_MAX_ROUNDS",
};

const NUMBER_FIELDS = new Set<keyof Tuning>([
  "codegenMaxTokens",
  "codegenTaskBudget",
  "codegenConcurrency",
  "qaMaxRounds",
]);
const BOOLEAN_VALUES: Record<string, boolean> = { "1": true, true: true, "0": false, false: false };

export class TuningError extends Error {
  override name = "TuningError";
}

/**
 * Читає `Tuning` з env. Порожнє чи відсутнє значення — дефолт; невалідне — `TuningError`
 * (воркер падає на старті, а не працює з тихим дефолтом).
 */
export function readTuning(env: Record<string, string | undefined> = process.env): Tuning {
  const raw: Record<string, unknown> = {};
  const problems: string[] = [];
  for (const [field, name] of Object.entries(TUNING_ENV) as Array<[keyof Tuning, string]>) {
    const value = env[name]?.trim();
    if (!value) continue;
    if (NUMBER_FIELDS.has(field)) {
      raw[field] = /^\d+$/.test(value) ? Number(value) : value;
    } else if (field === "speculativeRender") {
      const b = BOOLEAN_VALUES[value.toLowerCase()];
      if (b === undefined) problems.push(`${name}=${value}: очікується true/false/1/0`);
      else raw[field] = b;
    } else {
      raw[field] = value;
    }
  }
  const parsed = Tuning.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = issue.path[0] as keyof Tuning | undefined;
      const name = field ? TUNING_ENV[field] : "(tuning)";
      problems.push(`${name}=${field ? env[name] : ""}: ${issue.message}`);
    }
  }
  if (problems.length) throw new TuningError(`невалідні перемикачі генерації:\n- ${problems.join("\n- ")}`);
  return parsed.data as Tuning;
}
