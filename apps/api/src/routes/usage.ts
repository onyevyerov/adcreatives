import { type Context, Hono } from "hono";
import type { ApiDeps, ApiError } from "../deps.ts";
import { type AppEnv, requireAdmin, requireUser } from "../session.ts";
import { toCsv } from "../usage/csv.ts";
import { createUsageEngine } from "../usage/engine.ts";
import {
  parseCsvQuery,
  parseProjectsQuery,
  parseUsersQuery,
  parseWindow,
  type QueryResult,
} from "../usage/query.ts";
import type { UsageEngine } from "../usage/types.ts";
import { notFound } from "./account.ts";

const USER_NOT_FOUND = "Користувача не знайдено.";

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

  /** Розбір query: помилка → готова 400-відповідь, успіх → розібраний запит. */
  const parse = <T>(
    c: Context,
    parser: (raw: Record<string, string | undefined>) => QueryResult<T>,
  ): { query: T } | { res: Response } => {
    const parsed = parser(c.req.query());
    if (parsed.ok) return { query: parsed.value };
    return { res: c.json<ApiError>({ error: parsed.error, message: parsed.message }, 400) };
  };

  app.get("/summary", async (c) => {
    const p = parse(c, parseWindow);
    if ("res" in p) return p.res;
    return c.json(await engine.summary(p.query));
  });

  app.get("/users", async (c) => {
    const p = parse(c, parseUsersQuery);
    if ("res" in p) return p.res;
    return c.json(await engine.users(p.query));
  });

  app.get("/projects", async (c) => {
    const p = parse(c, parseProjectsQuery);
    if ("res" in p) return p.res;
    const page = await engine.projects(p.query);
    return page ? c.json(page) : notFound(c, USER_NOT_FOUND);
  });

  app.get("/projects.csv", async (c) => {
    const p = parse(c, parseCsvQuery);
    if ("res" in p) return p.res;
    const rows = await engine.csv(p.query);
    if (!rows) return notFound(c, USER_NOT_FOUND);
    const day = deps.config.now().toISOString().slice(0, 10);
    return c.body(toCsv(rows), 200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="adcreative-usage-${day}.csv"`,
    });
  });

  return app;
}
