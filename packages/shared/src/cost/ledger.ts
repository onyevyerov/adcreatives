import type { RunSource } from "../schemas/common.ts";
import type { Prices } from "../schemas/cost.ts";
import { CostEvent, type TokenUnitsInput } from "../schemas/cost.ts";
import type { CostPhase, CostStage } from "../schemas/project.ts";
import { projectPaths, sharedPaths } from "../storage/paths.ts";
import type { Storage } from "../storage/Storage.ts";
import { type Priced, priceAnthropic, priceElevenLabs, priceRemotion } from "./prices.ts";

/** Максимальний розмір рядка журналу: append до 4 КБ атомарний на POSIX. */
export const MAX_COST_LINE_BYTES = 4096;

/** Контекст, у якому записуються витрати (заповнюється воркером/оркестратором). */
export interface CostContext {
  /** null — спільні витрати (кеш SFX) → costs-shared.jsonl. */
  projectId: string | null;
  rev: number | null;
  stage: CostStage;
  phase: CostPhase;
  source: RunSource;
  attempt: number;
}

interface CostInputBase {
  /** Перекриває attempt контексту (повтори всередині LLM-обгортки). */
  attempt?: number;
  /** false — обсяг невідомий точно. */
  exact?: boolean;
  detail?: string;
}

export type CostInput =
  | (CostInputBase & {
      provider: "anthropic";
      model: string;
      units: TokenUnitsInput;
      promptName?: string | null;
      promptHash?: string | null;
      effort?: string | null;
    })
  | (CostInputBase & {
      provider: "elevenlabs";
      kind: "music" | "sfx";
      model: string;
      seconds: number;
    })
  | (CostInputBase & {
      provider: "remotion";
      renders: number;
    });

export interface CostRecorder {
  /** Обчислює вартість за цінами з конфігу і дописує рядок у журнал. */
  record(input: CostInput): Promise<CostEvent>;
}

export function costLogKey(projectId: string | null): string {
  return projectId === null ? sharedPaths.costs : projectPaths(projectId).costs;
}

/** Валідує подію і дописує її в журнал проєкту (або спільний). */
export async function recordCost(storage: Storage, event: CostEvent): Promise<CostEvent> {
  const valid = CostEvent.parse(event);
  let line = JSON.stringify(valid);
  if (Buffer.byteLength(line) > MAX_COST_LINE_BYTES) {
    // Обрізаємо лише довільний текст, щоб рядок лишився атомарним.
    line = JSON.stringify({ ...valid, detail: valid.detail ? valid.detail.slice(0, 200) : null });
  }
  await storage.append(costLogKey(valid.projectId), line);
  return valid;
}

export function priceInput(
  prices: Prices,
  input: CostInput,
): Priced & { units: CostEvent["units"]; model: string } {
  switch (input.provider) {
    case "anthropic":
      return {
        ...priceAnthropic(prices, input.model, input.units),
        units: { ...input.units, cacheWrite1h: input.units.cacheWrite1h ?? 0 },
        model: input.model,
      };
    case "elevenlabs":
      return {
        ...priceElevenLabs(prices, input.kind, input.seconds),
        units: { seconds: input.seconds },
        model: input.model,
      };
    case "remotion":
      return {
        ...priceRemotion(prices, input.renders),
        units: { renders: input.renders },
        model: "remotion",
      };
  }
}

export function createCostRecorder(
  storage: Storage,
  prices: Prices,
  ctx: CostContext,
  now: () => Date = () => new Date(),
): CostRecorder {
  return {
    async record(input) {
      const priced = priceInput(prices, input);
      const event: CostEvent = {
        ts: now().toISOString(),
        projectId: ctx.projectId,
        rev: ctx.rev,
        stage: ctx.stage,
        phase: ctx.phase,
        source: ctx.source,
        provider: input.provider,
        model: priced.model,
        promptName: input.provider === "anthropic" ? (input.promptName ?? null) : null,
        promptHash: input.provider === "anthropic" ? (input.promptHash ?? null) : null,
        effort: input.provider === "anthropic" ? (input.effort ?? null) : null,
        attempt: input.attempt ?? ctx.attempt,
        units: priced.units,
        unitPrices: priced.unitPrices,
        usd: priced.usd,
        exact: input.exact ?? true,
        detail: input.detail ?? null,
      };
      return recordCost(storage, event);
    },
  };
}

/** Читає журнал; биті рядки пропускаються (обірваний запис не ламає статистику). */
export async function readCosts(storage: Storage, projectId: string | null): Promise<CostEvent[]> {
  const key = costLogKey(projectId);
  if (!(await storage.exists(key))) return [];
  const text = await storage.readText(key);
  const out: CostEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = CostEvent.safeParse(JSON.parse(line));
      if (parsed.success) out.push(parsed.data);
    } catch {
      // пропускаємо битий рядок
    }
  }
  return out;
}

export function sumUsd(events: readonly CostEvent[], filter?: (e: CostEvent) => boolean): number {
  const total = events.reduce((acc, e) => (filter && !filter(e) ? acc : acc + e.usd), 0);
  return Math.round(total * 1e6) / 1e6;
}

/** Сума за ключем групування, відсортовано за спаданням. */
export function groupUsd<K extends string>(
  events: readonly CostEvent[],
  key: (e: CostEvent) => K,
): Array<{ key: K; usd: number }> {
  const map = new Map<K, number>();
  for (const e of events) map.set(key(e), (map.get(key(e)) ?? 0) + e.usd);
  return [...map.entries()]
    .map(([k, usd]) => ({ key: k, usd: Math.round(usd * 1e6) / 1e6 }))
    .sort((a, b) => b.usd - a.usd);
}
