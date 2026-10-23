import { readFile } from "node:fs/promises";
import path from "node:path";
import { noopLogger } from "@adc/shared";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { basicAuth, sameOriginGuard } from "./auth.ts";
import type { ApiDeps } from "./deps.ts";
import { accountRoutes } from "./routes/account.ts";
import { adminRoutes } from "./routes/admin.ts";
import { authRoutes } from "./routes/auth.ts";
import { billingRoutes } from "./routes/billing.ts";
import { filesHandler } from "./routes/files.ts";
import { projectsRoutes } from "./routes/projects.ts";
import { staticHandler } from "./routes/static.ts";
import { statsRoutes } from "./routes/stats.ts";
import { usageRoutes } from "./routes/usage.ts";
import { type AppEnv, sessionMiddleware } from "./session.ts";

/**
 * HTTP-застосунок API. Тонкий шар: HTTP, SSE, завантаження файлів, статистика (JSON/CSV).
 * `project.json` не пише — лише `intake.json` нового проєкту, оригінали фото в `uploads/`
 * і повідомлення клієнта в стрім подій; усе інше — команди в чергу `pipeline`.
 */
export function createApp(deps: ApiDeps): Hono<AppEnv> {
  const logger = deps.logger ?? noopLogger;
  const app = new Hono<AppEnv>();

  // Для healthcheck контейнера; нічого не розкриває.
  app.get("/healthz", (c) => c.text("ok"));

  app.use("*", basicAuth(deps.config.appPassword));
  app.use("*", sameOriginGuard());
  // Лише визначає користувача (або null); доступ перевіряє кожен роутер своїм requireUser/requireAdmin.
  app.use("*", sessionMiddleware(deps));

  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    logger.error("помилка запиту", { path: c.req.path, error: err.message, stack: err.stack });
    return c.json({ error: "internal", message: "Щось пішло не так на сервері. Спробуйте ще раз." }, 500);
  });

  app.route("/api/auth", authRoutes(deps));
  app.route("/api/account", accountRoutes(deps));
  app.route("/api/billing", billingRoutes(deps));
  app.route("/api/admin/usage", usageRoutes(deps));
  app.route("/api/admin", adminRoutes(deps));
  app.route("/api/projects", projectsRoutes(deps));
  app.route("/", statsRoutes(deps));
  app.get("/files/*", filesHandler(deps));
  app.get("/static/*", staticHandler(deps));

  const index = async () => readFile(path.join(deps.config.publicDir, "index.html"), "utf8");
  app.get("/", async (c) => c.html(await index()));
  app.get("/index.html", async (c) => c.html(await index()));

  app.notFound((c) => c.json({ error: "not_found", message: "Не знайдено." }, 404));
  return app;
}
