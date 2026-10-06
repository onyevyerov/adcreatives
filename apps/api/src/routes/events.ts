import {
  compareStreamIds,
  eventsKey,
  noopLogger,
  parseEntry,
  readEvents,
  type StoredChatEvent,
} from "@adc/shared";
import type { Context } from "hono";
import { type SSEStreamingApi, streamSSE } from "hono/streaming";
import type { ApiDeps } from "../deps.ts";

/** ID запису Redis Stream: `<ms>-<seq>`. */
const STREAM_ID_RE = /^\d{1,20}-\d{1,20}$/;

type RawEntry = [id: string, fields: string[]];

/**
 * Звідки продовжувати: заголовок `Last-Event-ID` (EventSource шле його сам при перепідключенні)
 * або `?lastEventId=` (коли сторінка перестворює EventSource вручну). Некоректне значення
 * ігнорується — тоді віддається вся історія.
 */
export function resumeIdFrom(c: Context): string | null {
  const raw = (c.req.header("last-event-id") ?? c.req.query("lastEventId") ?? "").trim();
  return STREAM_ID_RE.test(raw) ? raw : null;
}

const send = (stream: SSEStreamingApi, e: StoredChatEvent) =>
  stream.writeSSE({ event: e.event.type, id: e.id, data: JSON.stringify(e.event) });

/**
 * SSE подій чату. Без `Last-Event-ID` — уся історія проєкту, з ним — пропущене (XRANGE),
 * далі нові записи через XREAD BLOCK на окремому з'єднанні. `id` події = ID запису стріму.
 */
export function sseHandler(deps: ApiDeps) {
  const logger = deps.logger ?? noopLogger;
  return (c: Context) => {
    const projectId = c.req.param("id") as string;
    const afterId = resumeIdFrom(c);
    return streamSSE(c, async (stream) => {
      let aborted = false;
      const sub = deps.redis.duplicate();
      sub.on("error", (err: Error) => logger.debug("SSE: помилка з'єднання Redis", { error: err.message }));
      stream.onAbort(() => {
        aborted = true;
        sub.disconnect();
      });
      try {
        await stream.write("retry: 3000\n\n");
        let lastId = afterId ?? "0-0";
        for (const e of await readEvents(deps.redis, projectId, { afterId })) {
          if (aborted) return;
          await send(stream, e);
          lastId = e.id;
        }
        while (!aborted) {
          let res: Array<[key: string, entries: RawEntry[]]> | null;
          try {
            res = (await sub.xread(
              "BLOCK",
              deps.config.sseBlockMs,
              "STREAMS",
              eventsKey(projectId),
              lastId,
            )) as typeof res;
          } catch (err) {
            if (aborted) break;
            throw err;
          }
          if (aborted) break;
          if (!res) {
            // Keep-alive, щоб проксі не закривали тихе з'єднання.
            await stream.write(": ping\n\n");
            continue;
          }
          for (const [, entries] of res) {
            for (const entry of entries) {
              // XREAD виключний, але деякі реалізації (ioredis-mock) повертають і сам lastId.
              if (compareStreamIds(entry[0], lastId) <= 0) continue;
              lastId = entry[0];
              const parsed = parseEntry(entry);
              if (parsed) await send(stream, parsed);
            }
          }
        }
      } catch (err) {
        logger.error("SSE обірвано з помилкою", { projectId, error: (err as Error).message });
      } finally {
        sub.disconnect();
      }
    });
  };
}
