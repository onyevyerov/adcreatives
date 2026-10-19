import {
  type AccountStore,
  hashPassword,
  type LedgerEntry,
  PASSWORD_MAX,
  PASSWORD_MIN,
  verifyPassword,
} from "@adc/shared";
import { type Context, Hono } from "hono";
import { z } from "zod";
import type { ApiDeps, ApiError } from "../deps.ts";
import { type AppEnv, requireUser, setSessionCookie } from "../session.ts";

/** Сторінка історії транзакцій: дефолт і межі `limit`. */
export const TRANSACTIONS_DEFAULT_LIMIT = 50;
export const TRANSACTIONS_MAX_LIMIT = 200;

/** JSON-тіло запиту; некоректний JSON або інший content-type → null (zod далі дасть invalid_body). */
export async function readJson(c: Context): Promise<unknown> {
  return c.req.json().catch(() => null);
}

export const invalidBody = (c: Context, message = "Некоректні дані запиту.") =>
  c.json<ApiError>({ error: "invalid_body", message }, 400);

export const notFound = (c: Context, message = "Не знайдено.") =>
  c.json<ApiError>({ error: "not_found", message }, 404);

/** `limit` із query: ціле 1…max; відсутнє → дефолт; інше → null (400). */
export function parseLimit(raw: string | undefined, def: number, max: number): number | null {
  if (raw === undefined || raw === "") return def;
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= max ? n : null;
}

const Before = z.string().min(1).max(120);

/**
 * Сторінка леджера для `GET …/transactions?limit&before`: `{entries, nextBefore}`, новіші першими.
 * `nextBefore` — id останнього запису сторінки, якщо далі є старіші; інакше null.
 * null-результат — невалідні параметри (викликач відповідає 400).
 */
export async function transactionsPage(
  accounts: AccountStore,
  userId: string,
  query: { limit?: string; before?: string },
): Promise<{ entries: LedgerEntry[]; nextBefore: string | null } | null> {
  const limit = parseLimit(query.limit, TRANSACTIONS_DEFAULT_LIMIT, TRANSACTIONS_MAX_LIMIT);
  if (limit === null) return null;
  let before: string | undefined;
  if (query.before !== undefined) {
    const parsed = Before.safeParse(query.before);
    if (!parsed.success) return null;
    before = parsed.data;
  }
  // На один запис більше — щоб знати, чи є наступна сторінка, без порожньої «хвостової».
  const page = await accounts.readLedger(userId, { limit: limit + 1, before });
  const entries = page.slice(0, limit);
  const nextBefore = page.length > limit ? (entries.at(-1)?.id ?? null) : null;
  return { entries, nextBefore };
}

const ProfileBody = z.object({ name: z.string().trim().min(1).max(80) });
const PasswordBody = z.object({ current: z.string().max(PASSWORD_MAX * 4), next: z.string() });

/** `/api/account`. Кабінет: профіль, пароль, історія транзакцій. */
export function accountRoutes(deps: ApiDeps): Hono<AppEnv> {
  const { accounts, sessions } = deps;
  const app = new Hono<AppEnv>();
  app.use("*", requireUser());

  /** Поточний користувач (гарантовано requireUser). */
  const me = (c: Context<AppEnv>) => {
    const user = c.get("user");
    if (!user) throw new Error("requireUser пропустив аноніма");
    return user;
  };

  app.get("/", async (c) => {
    const user = me(c);
    return c.json({ user, balance: await accounts.balance(user.id) });
  });

  app.patch("/", async (c) => {
    const user = me(c);
    const parsed = ProfileBody.safeParse(await readJson(c));
    if (!parsed.success) return invalidBody(c, "Ім'я — від 1 до 80 символів.");
    const updated = await accounts.updateUser(user.id, { name: parsed.data.name });
    return c.json({ user: { ...user, name: updated.name } });
  });

  app.post("/password", async (c) => {
    const user = me(c);
    const parsed = PasswordBody.safeParse(await readJson(c));
    if (!parsed.success) return invalidBody(c);
    const { current, next } = parsed.data;
    if (next.length < PASSWORD_MIN || next.length > PASSWORD_MAX)
      return c.json<ApiError>(
        { error: "weak_password", message: `Пароль — від ${PASSWORD_MIN} до ${PASSWORD_MAX} символів.` },
        400,
      );
    const stored = await accounts.getUser(user.id);
    if (!stored || !(await verifyPassword(current, stored.passwordHash)))
      return c.json<ApiError>({ error: "invalid_credentials", message: "Невірний поточний пароль." }, 401);
    await accounts.updateUser(user.id, { passwordHash: await hashPassword(next) });
    // Усі сесії (включно з поточною) недійсні; поточний запит отримує нову.
    await sessions.destroyAll(user.id);
    setSessionCookie(c, await sessions.create(user.id));
    return c.json({ ok: true });
  });

  app.get("/transactions", async (c) => {
    const user = me(c);
    const page = await transactionsPage(accounts, user.id, {
      limit: c.req.query("limit"),
      before: c.req.query("before"),
    });
    if (!page) return invalidBody(c, `limit — ціле від 1 до ${TRANSACTIONS_MAX_LIMIT}.`);
    return c.json(page);
  });

  return app;
}
