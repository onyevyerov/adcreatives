import { type Logger, noopLogger } from "@adc/shared";
import { classifyEpidemicError } from "./errors.ts";

/**
 * Локальна черга викликів Epidemic (за зразком `ElevenLabsGate`): обмежує паралельність у процесі
 * і повторює тимчасові відмови.
 *
 * - `rate_limited` (429 без заголовків ліміту), `server` (5xx), `network` (мережа/таймаут) → повтор
 *   з експоненційною паузою 2–30 с, до 5 разів;
 * - `unauthorized`, `not_found`, `quota`, `aborted`, `other` — одразу назовні.
 */

export interface EpidemicGateOptions {
  /** Ліміт паралельних запитів (дефолт 2; спільна черга бере `EPIDEMIC_CONCURRENCY`). */
  maxConcurrent?: number;
  /** Повтори на тимчасових помилках (дефолт 5). */
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  logger?: Logger;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const TRANSIENT = new Set(["rate_limited", "server", "network"]);

/** Ліміт паралельності з env (`EPIDEMIC_CONCURRENCY`), інакше 2. */
export function epidemicConcurrency(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.EPIDEMIC_CONCURRENCY);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 2;
}

export class EpidemicGate {
  readonly maxConcurrent: number;
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly logger: Logger;
  /** Найбільша кількість одночасних запитів, що спостерігалась (для тестів і діагностики). */
  peak = 0;

  constructor(options: EpidemicGateOptions = {}) {
    this.maxConcurrent = Math.max(1, Math.floor(options.maxConcurrent ?? 2));
    this.maxRetries = options.maxRetries ?? 5;
    this.baseDelayMs = options.baseDelayMs ?? 2_000;
    this.maxDelayMs = options.maxDelayMs ?? 30_000;
    this.sleep = options.sleep ?? defaultSleep;
    this.logger = options.logger ?? noopLogger;
  }

  private async acquire(): Promise<void> {
    while (this.active >= this.maxConcurrent) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active++;
    this.peak = Math.max(this.peak, this.active);
  }

  private release(): void {
    this.active--;
    this.waiters.shift()?.();
  }

  async run<T>(label: string, fn: (signal?: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    for (let retry = 0; ; retry++) {
      signal?.throwIfAborted();
      await this.acquire();
      try {
        const result = await fn(signal);
        this.release();
        return result;
      } catch (err) {
        this.release();
        const info = classifyEpidemicError(err);
        if (!TRANSIENT.has(info.kind) || retry >= this.maxRetries || signal?.aborted) throw err;
        const wait = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** retry);
        this.logger.warn("Epidemic: тимчасова відмова, повтор", {
          call: label,
          kind: info.kind,
          status: info.status,
          retry: retry + 1,
          waitMs: wait,
        });
        await this.sleep(wait);
        if (signal?.aborted) throw err;
      }
    }
  }
}

let shared: EpidemicGate | null = null;

/** Спільна черга процесу (ліміт частоти Epidemic — на користувача, тож усі стадії ділять одну). */
export function defaultEpidemicGate(logger?: Logger): EpidemicGate {
  if (!shared) {
    shared = new EpidemicGate({
      maxConcurrent: epidemicConcurrency(),
      ...(logger ? { logger } : {}),
    });
  }
  return shared;
}
