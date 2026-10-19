export interface RateLimiter {
  /** Реєструє спробу за ключем; `true` — ліміт перевищено (спроба не зараховується). */
  hit(key: string): boolean;
}

export interface RateLimiterOptions {
  /** Скільки спроб дозволено у вікні. */
  max: number;
  windowMs: number;
  /** Поточний час (у тестах — ін'єктований). */
  now?: () => Date;
}

/** Після скількох ключів робити прибирання протухлих (щоб пам'ять не росла безмежно). */
const SWEEP_THRESHOLD = 10_000;

/**
 * Ковзне вікно в пам'яті процесу: для кожного ключа — мітки часу зарахованих спроб за останні
 * `windowMs`. Скидається з рестартом і не ділиться між репліками (свідома прогалина макета).
 * Відхилені спроби не зараховуються: блок спадає через `windowMs` від перших спроб.
 */
export function createRateLimiter(opts: RateLimiterOptions): RateLimiter {
  const now = opts.now ?? (() => new Date());
  const hits = new Map<string, number[]>();

  const fresh = (stamps: number[], since: number) => stamps.filter((t) => t > since);

  function sweep(since: number) {
    for (const [key, stamps] of hits) {
      const kept = fresh(stamps, since);
      if (kept.length === 0) hits.delete(key);
      else hits.set(key, kept);
    }
  }

  return {
    hit(key) {
      const t = now().getTime();
      const since = t - opts.windowMs;
      if (hits.size > SWEEP_THRESHOLD) sweep(since);
      const stamps = fresh(hits.get(key) ?? [], since);
      if (stamps.length >= opts.max) {
        hits.set(key, stamps);
        return true;
      }
      stamps.push(t);
      hits.set(key, stamps);
      return false;
    },
  };
}

/** IP клієнта для ключа ліміту: перший елемент `x-forwarded-for`, інакше `"local"`. */
export function clientIp(forwardedFor: string | undefined): string {
  const first = forwardedFor?.split(",")[0]?.trim();
  return first ? first : "local";
}
