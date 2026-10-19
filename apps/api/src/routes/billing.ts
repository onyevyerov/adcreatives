import { Hono } from "hono";
import type { ApiDeps } from "../deps.ts";
import type { AppEnv } from "../session.ts";

/** `/api/billing`. Пакети й поповнення (заглушка оплати) — B3. */
export function billingRoutes(_deps: ApiDeps): Hono<AppEnv> {
  return new Hono<AppEnv>();
}
