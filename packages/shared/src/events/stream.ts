import type { Redis } from "ioredis";
import { ChatEvent, type StoredChatEvent } from "../schemas/events.ts";
import { EVENT_FIELD, eventsKey } from "./emit.ts";

type RawEntry = [id: string, fields: string[]];

export function parseEntry([id, fields]: RawEntry): StoredChatEvent | null {
  for (let i = 0; i + 1 < fields.length; i += 2) {
    if (fields[i] !== EVENT_FIELD) continue;
    try {
      const parsed = ChatEvent.safeParse(JSON.parse(fields[i + 1] as string));
      return parsed.success ? { id, event: parsed.data } : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Порівняння ID записів стріму ("ms-seq"). */
export function compareStreamIds(a: string, b: string): number {
  const [am = 0, as = 0] = a.split("-").map(Number);
  const [bm = 0, bs = 0] = b.split("-").map(Number);
  return am !== bm ? am - bm : as - bs;
}

/**
 * Історія подій проєкту. Без `afterId` — уся історія; з `afterId` (SSE `Last-Event-ID`) —
 * лише записи після нього.
 */
export async function readEvents(
  redis: Redis,
  projectId: string,
  opts: { afterId?: string | null } = {},
): Promise<StoredChatEvent[]> {
  // Старт за мілісекундною частиною ID (= "<ms>-0"), сам afterId і раніші відсікаються нижче.
  // Так само працює і в Redis, і в ioredis-mock (той не розуміє повний ID як початок діапазону).
  const start = opts.afterId ? (opts.afterId.split("-")[0] ?? "-") : "-";
  const raw = (await redis.xrange(eventsKey(projectId), start, "+")) as RawEntry[];
  const out: StoredChatEvent[] = [];
  for (const entry of raw) {
    // Початок XRANGE включний — сам afterId відкидаємо.
    if (opts.afterId && compareStreamIds(entry[0], opts.afterId) <= 0) continue;
    const parsed = parseEntry(entry);
    if (parsed) out.push(parsed);
  }
  return out;
}

/**
 * Нові події після `lastId` через XREAD BLOCK. Блокує з'єднання, тож передавайте окреме
 * (`redis.duplicate()`). Завершується, коли спрацьовує `signal`.
 */
export async function* followEvents(
  redis: Redis,
  projectId: string,
  opts: { lastId: string; blockMs?: number; signal?: AbortSignal },
): AsyncGenerator<StoredChatEvent> {
  let lastId = opts.lastId;
  const block = opts.blockMs ?? 15_000;
  while (!opts.signal?.aborted) {
    const res = (await redis.xread("BLOCK", block, "STREAMS", eventsKey(projectId), lastId)) as Array<
      [key: string, entries: RawEntry[]]
    > | null;
    if (!res) continue;
    for (const [, entries] of res) {
      for (const entry of entries) {
        lastId = entry[0];
        const parsed = parseEntry(entry);
        if (parsed) yield parsed;
      }
    }
  }
}

/** ID останнього запису стріму або "0-0", якщо стрім порожній. */
export async function lastEventId(redis: Redis, projectId: string): Promise<string> {
  const raw = (await redis.xrevrange(eventsKey(projectId), "+", "-", "COUNT", 1)) as RawEntry[];
  return raw[0]?.[0] ?? "0-0";
}
