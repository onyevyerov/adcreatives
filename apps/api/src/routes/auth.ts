import { Hono } from "hono";
import type { ApiDeps } from "../deps.ts";
import type { AppEnv } from "../session.ts";

/** `/api/auth`. Вхід, реєстрація, активація, скидання пароля — B1. */
export function authRoutes(_deps: ApiDeps): Hono<AppEnv> {
  return new Hono<AppEnv>();
}
