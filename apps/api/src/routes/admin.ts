import { Hono } from "hono";
import type { ApiDeps } from "../deps.ts";
import type { AppEnv } from "../session.ts";

/** `/api/admin`. Адмін: користувачі, ручне нарахування, dev-outbox — B3. */
export function adminRoutes(_deps: ApiDeps): Hono<AppEnv> {
  return new Hono<AppEnv>();
}
