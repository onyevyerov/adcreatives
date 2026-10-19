import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type AccountStore,
  createAccountStore,
  createMemoryLock,
  createOutboxMailer,
  createSessionStore,
  createStubPayment,
  createTokenStore,
  LocalStorage,
  type Mailer,
  MemoryQueue,
  type PaymentProvider,
  type PublicUser,
  type Resolver,
  type SessionStore,
  type TokenStore,
} from "@adc/shared";
import type { Hono } from "hono";
import type { Redis } from "ioredis";
import RedisMock from "ioredis-mock";
import { onTestFinished } from "vitest";
import { createApp } from "../src/app.ts";
import { type ApiConfig, defaultConfig } from "../src/config.ts";
import { type AppEnv, isAdminEmail, SESSION_COOKIE, toPublic } from "../src/session.ts";

export const NOW = new Date("2026-10-06T10:00:00.000Z");

/** DNS без мережі: приватні/неіснуючі хости для тестів відмови. */
export const fakeResolver: Resolver = async (host) => {
  if (host === "intranet.example.com") return ["10.0.0.5"];
  if (host === "nxdomain.example.com") throw new Error("ENOTFOUND");
  return ["93.184.216.34"];
};

export type RequestFn = (path: string, init?: RequestInit) => Promise<Response>;

export interface SeedUserInput {
  email?: string;
  name?: string;
  admin?: boolean;
  activated?: boolean;
  credits?: number;
}

export interface Env {
  app: Hono<AppEnv>;
  storage: LocalStorage;
  queue: MemoryQueue;
  redis: Redis;
  config: ApiConfig;
  root: string;
  dataDir: string;
  accounts: AccountStore;
  sessions: SessionStore;
  tokens: TokenStore;
  mailer: Mailer;
  payments: PaymentProvider;
  /** Користувач за замовчуванням (активований, із сесією); null — анонім. */
  user: PublicUser | null;
  /** `adc_session=<token>` користувача за замовчуванням; null — анонім. */
  cookie: string | null;
  /** `app.request` з cookie сесії користувача за замовчуванням (анонім — без Cookie). */
  request: RequestFn;
}

/** Запит до застосунку з `Cookie: <cookie>` (дописується до наявного заголовка Cookie). */
function requestWith(app: Hono<AppEnv>, cookie: string | null): RequestFn {
  return async (path, init = {}) => {
    if (!cookie) return app.request(path, init);
    const headers = new Headers(init.headers);
    const prev = headers.get("cookie");
    headers.set("cookie", prev ? `${prev}; ${cookie}` : cookie);
    return app.request(path, { ...init, headers });
  };
}

/**
 * Тестове оточення API. `opts.user` за замовчуванням — `{ email: "user@example.com", name: "Тест" }`:
 * активований, із сесією (`env.request` підмішує cookie). `opts.user === null` — анонім.
 * `env.app.request` лишається для анонімних перевірок.
 */
export async function setup(
  overrides: Partial<ApiConfig> = {},
  opts: { user?: SeedUserInput | null } = {},
): Promise<Env> {
  const root = mkdtempSync(path.join(tmpdir(), "adc-api-"));
  const dataDir = path.join(root, "data");
  const storage = new LocalStorage(dataDir);
  const queue = new MemoryQueue();
  // ioredis-mock ділить дані між інстансами — чистимо перед кожним тестом.
  const redis = new RedisMock() as unknown as Redis;
  await redis.flushall();
  onTestFinished(() => redis.disconnect());
  const config = defaultConfig({ resolve: fakeResolver, sseBlockMs: 100, now: () => NOW, ...overrides });
  const accounts = createAccountStore({ storage, lock: createMemoryLock(), now: config.now });
  const sessions = createSessionStore(redis);
  const tokens = createTokenStore(redis);
  const mailer = createOutboxMailer({ storage, now: config.now });
  const payments = createStubPayment(config.appUrl);
  const app = createApp({ storage, queue, redis, config, accounts, sessions, tokens, mailer, payments });
  const env: Env = {
    app,
    storage,
    queue,
    redis,
    config,
    root,
    dataDir,
    accounts,
    sessions,
    tokens,
    mailer,
    payments,
    user: null,
    cookie: null,
    request: requestWith(app, null),
  };
  if (opts.user !== null) {
    const seeded = await seedUser(env, { email: "user@example.com", name: "Тест", ...opts.user });
    env.user = seeded.user;
    env.cookie = seeded.cookie;
    env.request = seeded.request;
  }
  return env;
}

/**
 * Створює користувача напряму через `accounts` (+ `bonus:seed:<uid>` на `credits`) і сесію.
 * `admin` — лише через `adminEmails` конфігу: e-mail дописується туди, якщо його там немає.
 */
export async function seedUser(
  env: Env,
  u: SeedUserInput & { email: string },
): Promise<{ user: PublicUser; cookie: string; request: RequestFn }> {
  if (u.admin && !isAdminEmail(env.config, u.email))
    env.config.adminEmails.push(u.email.trim().toLowerCase());
  let user = await env.accounts.createUser({
    email: u.email,
    name: u.name ?? "Тест",
    password: SEED_PASSWORD,
  });
  if (u.activated !== false)
    user = await env.accounts.updateUser(user.id, { activatedAt: env.config.now().toISOString() });
  if (u.credits)
    await env.accounts.apply(user.id, { id: `bonus:seed:${user.id}`, kind: "bonus", credits: u.credits });
  const cookie = `${SESSION_COOKIE}=${await env.sessions.create(user.id)}`;
  return { user: toPublic(user, env.config.adminEmails), cookie, request: requestWith(env.app, cookie) };
}

/** Пароль, з яким `seedUser` створює користувачів. */
export const SEED_PASSWORD = "password123";

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
