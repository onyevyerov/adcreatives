import { Hono } from "hono";
import type { ApiDeps } from "../deps.ts";
import { type AppEnv, requireAdmin, requireUser } from "../session.ts";
import { createUsageEngine } from "../usage/engine.ts";
import type { UsageEngine } from "../usage/types.ts";

/**
 * `/api/admin/usage` — вкладка «Використання» адмінки (`docs/usage-api.md`). Лише GET, лише адмін.
 * `engine` — у тестах фейк; за замовчуванням справжній двигун над сховищем і акаунтами.
 */
export function usageRoutes(
  deps: ApiDeps,
  engine: UsageEngine = createUsageEngine({
    storage: deps.storage,
    accounts: deps.accounts,
    creditsPerUsd: deps.config.credits.creditsPerUsd,
    now: deps.config.now,
  }),
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", requireUser(), requireAdmin());
  void engine; // ендпоінти додає B2
  return app;
}
