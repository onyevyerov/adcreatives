import { aggregateCosts, statsToCsv } from "@adc/shared";
import { Hono } from "hono";
import type { ApiDeps } from "../deps.ts";
import { type AppEnv, requireAdmin, requireUser } from "../session.ts";

export function statsRoutes(deps: ApiDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const report = () =>
    aggregateCosts({
      storage: deps.storage,
      targetUsd: deps.config.costTargetUsd,
      now: deps.config.now,
      ...(deps.config.prices ? { prices: deps.config.prices } : {}),
    });

  // Роутер змонтовано на "/", тож middleware — лише на свої маршрути, не "*".

  app.get("/api/stats", requireUser(), requireAdmin(), async (c) => c.json(await report()));

  app.get("/api/stats.csv", requireUser(), requireAdmin(), async (c) =>
    c.body(statsToCsv((await report()).rows), 200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="adcreative-stats.csv"',
    }),
  );

  return app;
}
