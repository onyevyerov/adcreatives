import { z } from "zod";
import { MIN_TASK_BUDGET } from "./llm/client.ts";
import { Effort } from "./llm/prompts.ts";

/**
 * Перемикачі вартості й якості генерації (env воркера). Дефолти — погоджена конфігурація:
 * `film` (один автор — весь фільм за один виклик), effort `high` для anchor/film і решти, task budget
 * 100 000 при `max_tokens` 128 000 (ТЗ 2026-10-09 «якість відео»: Opus 5.5 `high` для творчих стадій).
 * Відкат: `ADC_CODEGEN_MODE=fanout` (anchor, потім решта паралельно) або послідовна генерація
 * `ADC_CODEGEN_MODE=sequential ADC_CODEGEN_ANCHOR_EFFORT=xhigh ADC_CODEGEN_REST_EFFORT=high`.
 * `qaMaxRounds` — кількість кіл QA → fix перед чекпоінтом 3.
 * `generationMode: agent` — стадія `author` (один агент пише, рендерить і дивиться сцени) замість
 * codegen → check → qa → fix; бюджети `author*` обмежують її токенами, ітераціями і часом.
 * `null` — значення з frontmatter промпта.
 */
export const Tuning = z.object({
  codegenMode: z.enum(["sequential", "fanout", "film"]).default("film"),
  codegenAnchorEffort: Effort.default("high"),
  codegenRestEffort: Effort.default("high"),
  codegenRestModel: z.string().min(1).nullable().default(null),
  codegenMaxTokens: z.number().int().positive().nullable().default(null),
  codegenTaskBudget: z.number().int().min(MIN_TASK_BUDGET).nullable().default(100_000),
  codegenConcurrency: z.number().int().min(1).max(32).default(5),
  fixCheckEffort: Effort.nullable().default(null),
  speculativeRender: z.boolean().default(false),
  qaMaxRounds: z.number().int().min(0).max(3).default(2),
  generationMode: z.enum(["pipeline", "agent"]).default("pipeline"),
  /** Сумарні токени (input + output + cache) стадії `author`. */
  authorTokenBudget: z.number().int().min(500_000).default(3_000_000),
  authorMaxIterations: z.number().int().min(5).max(80).default(40),
  authorMaxMinutes: z.number().int().min(5).max(60).default(25),
  /** designer — звукорежисер ставить SFX по готовій картинці; storyboard — звук із розкадровки. */
  sfxMode: z.enum(["storyboard", "designer"]).default("designer"),
  /** Рецензент фільму після зведення. */
  filmReview: z.boolean().default(true),
  /** Кола рецензія → правки → рецензія. */
  reviewMaxRounds: z.number().int().min(0).max(2).default(1),
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
  generationMode: "ADC_GENERATION_MODE",
  authorTokenBudget: "ADC_AUTHOR_TOKEN_BUDGET",
  authorMaxIterations: "ADC_AUTHOR_MAX_ITERATIONS",
  authorMaxMinutes: "ADC_AUTHOR_MAX_MINUTES",
  sfxMode: "ADC_SFX_MODE",
  filmReview: "ADC_FILM_REVIEW",
  reviewMaxRounds: "ADC_REVIEW_MAX_ROUNDS",
};

const NUMBER_FIELDS = new Set<keyof Tuning>([
  "codegenMaxTokens",
  "codegenTaskBudget",
  "codegenConcurrency",
  "qaMaxRounds",
  "authorTokenBudget",
  "authorMaxIterations",
  "authorMaxMinutes",
  "reviewMaxRounds",
]);
const BOOLEAN_FIELDS = new Set<keyof Tuning>(["speculativeRender", "filmReview"]);
const BOOLEAN_VALUES: Record<string, boolean> = {
  "1": true,
  true: true,
  on: true,
  "0": false,
  false: false,
  off: false,
};

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
    } else if (BOOLEAN_FIELDS.has(field)) {
      const b = BOOLEAN_VALUES[value.toLowerCase()];
      if (b === undefined) problems.push(`${name}=${value}: очікується true/false/on/off/1/0`);
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
