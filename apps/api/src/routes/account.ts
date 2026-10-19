import { Hono } from "hono";
import type { ApiDeps } from "../deps.ts";
import type { AppEnv } from "../session.ts";

/** `/api/account`. Кабінет: профіль, пароль, історія транзакцій — B3. */
export function accountRoutes(_deps: ApiDeps): Hono<AppEnv> {
  return new Hono<AppEnv>();
}
