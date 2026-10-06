import { type Logger, noopLogger } from "@adc/shared";
import { classifyElevenLabsError } from "./errors.ts";

/**
 * Локальна черга викликів ElevenLabs: обмежує паралельність у процесі воркера
 * і повторює тимчасові відмови.
 *
 * - 429 `too_many_concurrent_requests` → зменшуємо ліміт паралельності (до 1) і повторюємо
 *   після паузи; після успіхів ліміт поступово відновлюється;
 * - 429 `system_busy`, інші 429 і 5xx → повтор з експоненційною паузою;
 * - решта помилок (зокрема відхилений промпт) — одразу назовні.
 */

export interface GateOptions {
  /** Стартовий/максимальний ліміт паралельних запитів (дефолт env ELEVENLABS_CONCURRENCY або 2). */
  maxConcurrent?: number;
  /** Повтори на тимчасових помилках (дефолт 5). */
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  logger?: Logger;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class ElevenLabsGate {
  readonly maxConcurrent: number;
  private limit: number;
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly logger: Logger;
  /** Найбільша кількість одночасних запитів, що спостерігалась (для тестів і діагностики). */
  peak = 0;

  constructor(options: GateOptions = {}) {
    this.maxConcurrent = Math.max(1, Math.floor(options.maxConcurrent ?? 2));
    this.limit = this.maxConcurrent;
    this.maxRetries = options.maxRetries ?? 5;
    this.baseDelayMs = options.baseDelayMs ?? 2_000;
    this.maxDelayMs = options.maxDelayMs ?? 30_000;
    this.sleep = options.sleep ?? defaultSleep;
    this.logger = options.logger ?? noopLogger;
  }

  /** Поточний ліміт паралельності. */
  get currentLimit(): number {
    return this.limit;
  }

  private async acquire(): Promise<void> {
    while (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active++;
    this.peak = Math.max(this.peak, this.active);
  }

  private release(): void {
    this.active--;
    this.wakeUp();
  }

  private wakeUp(): void {
    // Будимо всіх: кожен сам перевірить ліміт (ліміт міг змінитись).
    for (const w of this.waiters.splice(0)) w();
  }

  async run<T>(label: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    for (let retry = 0; ; retry++) {
      signal?.throwIfAborted();
      await this.acquire();
      const activeAtCall = this.active;
      try {
        const result = await fn();
        this.release();
        if (this.limit < this.maxConcurrent) {
          this.limit++;
          this.wakeUp();
        }
        return result;
      } catch (err) {
        this.release();
        const info = classifyElevenLabsError(err);
        const transient = info.kind === "concurrency" || info.kind === "busy";
        if (!transient || retry >= this.maxRetries || signal?.aborted) throw err;
        if (info.kind === "concurrency") {
          // Сервер бачить більше паралельних запитів, ніж дозволяє план — звужуємо локальну чергу.
          this.limit = Math.max(1, Math.min(this.limit, activeAtCall - 1));
        }
        const wait = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** retry);
        this.logger.warn("ElevenLabs: тимчасова відмова, повтор", {
          call: label,
          kind: info.kind,
          code: info.code,
          retry: retry + 1,
          waitMs: wait,
          limit: this.limit,
        });
        await this.sleep(wait);
      }
    }
  }
}

let shared: ElevenLabsGate | null = null;

/** Спільна черга процесу (усі стадії воркера ділять ліміт акаунта). */
export function defaultGate(logger?: Logger): ElevenLabsGate {
  if (!shared) {
    const env = Number(process.env.ELEVENLABS_CONCURRENCY);
    shared = new ElevenLabsGate({
      maxConcurrent: Number.isFinite(env) && env > 0 ? env : 2,
      ...(logger ? { logger } : {}),
    });
  }
  return shared;
}
