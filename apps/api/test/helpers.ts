import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LocalStorage, MemoryQueue, type Resolver } from "@adc/shared";
import type { Redis } from "ioredis";
import RedisMock from "ioredis-mock";
import { onTestFinished } from "vitest";
import { createApp } from "../src/app.ts";
import { type ApiConfig, defaultConfig } from "../src/config.ts";

export const NOW = new Date("2026-10-06T10:00:00.000Z");

/** DNS без мережі: приватні/неіснуючі хости для тестів відмови. */
export const fakeResolver: Resolver = async (host) => {
  if (host === "intranet.example.com") return ["10.0.0.5"];
  if (host === "nxdomain.example.com") throw new Error("ENOTFOUND");
  return ["93.184.216.34"];
};

export async function setup(overrides: Partial<ApiConfig> = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "adc-api-"));
  const dataDir = path.join(root, "data");
  const storage = new LocalStorage(dataDir);
  const queue = new MemoryQueue();
  // ioredis-mock ділить дані між інстансами — чистимо перед кожним тестом.
  const redis = new RedisMock() as unknown as Redis;
  await redis.flushall();
  onTestFinished(() => redis.disconnect());
  const config = defaultConfig({ resolve: fakeResolver, sseBlockMs: 100, now: () => NOW, ...overrides });
  const app = createApp({ storage, queue, redis, config });
  return { app, storage, queue, redis, config, root, dataDir };
}

export function basic(password: string, user = "team"): string {
  return `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
}

export function photo(name = "photo.jpg", bytes = 128, type = "image/jpeg"): File {
  return new File([new Uint8Array(bytes).fill(7)], name, { type });
}

export function form(fields: Record<string, string | File | File[]>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    for (const item of Array.isArray(v) ? v : [v]) fd.append(k, item);
  }
  return fd;
}

export const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export interface SseMessage {
  event: string | null;
  id: string | null;
  data: string;
}

/** Читає SSE-відповідь, доки `until` не поверне true (або таймаут), потім закриває потік. */
export async function readSse(
  res: Response,
  until: (events: SseMessage[]) => boolean,
  timeoutMs = 4000,
): Promise<SseMessage[]> {
  if (!res.body) throw new Error("немає тіла відповіді");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const events: SseMessage[] = [];
  let buf = "";
  const deadline = Date.now() + timeoutMs;
  try {
    while (!until(events)) {
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`SSE: таймаут, отримано ${events.length} подій`);
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("SSE: таймаут читання")), left)),
      ]);
      if (chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true });
      for (let idx = buf.indexOf("\n\n"); idx >= 0; idx = buf.indexOf("\n\n")) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const msg: SseMessage = { event: null, id: null, data: "" };
        let hasData = false;
        for (const line of block.split("\n")) {
          if (line.startsWith("event: ")) msg.event = line.slice(7);
          else if (line.startsWith("id: ")) msg.id = line.slice(4);
          else if (line.startsWith("data: ")) {
            msg.data += (hasData ? "\n" : "") + line.slice(6);
            hasData = true;
          }
        }
        if (hasData) events.push(msg);
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return events;
}
