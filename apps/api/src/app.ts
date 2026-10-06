import { readFile } from "node:fs/promises";
import path from "node:path";
import { noopLogger } from "@adc/shared";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { basicAuth, sameOriginGuard } from "./auth.ts";
import type { ApiDeps } from "./deps.ts";
import { filesHandler } from "./routes/files.ts";
import { projectsRoutes } from "./routes/projects.ts";
import { statsRoutes } from "./routes/stats.ts";

/**
 * HTTP-застосунок API. Тонкий шар: HTTP, SSE, завантаження файлів, статистика.
 * `project.json` не пише — лише `intake.json` нового проєкту, оригінали фото в `uploads/`
 * і повідомлення клієнта в стрім подій; усе інше — команди в чергу `pipeline`.
 */
export function createApp(deps: ApiDeps): Hono {
  const logger = deps.logger ?? noopLogger;
  const app = new Hono();

  // Для healthcheck контейнера; нічого не розкриває.
  app.get("/healthz", (c) => c.text("ok"));

  app.use("*", basicAuth(deps.config.appPassword));
  app.use("*", sameOriginGuard());

  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    logger.error("помилка запиту", { path: c.req.path, error: err.message, stack: err.stack });
    return c.json({ error: "internal", message: "Щось пішло не так на сервері. Спробуйте ще раз." }, 500);
  });

  app.route("/api/projects", projectsRoutes(deps));
  app.route("/", statsRoutes(deps));
  app.get("/files/*", filesHandler(deps));

  const index = async () => readFile(path.join(deps.config.publicDir, "index.html"), "utf8");
  app.get("/", async (c) => c.html(await index()));
  app.get("/index.html", async (c) => c.html(await index()));

  app.notFound((c) => c.json({ error: "not_found", message: "Не знайдено." }, 404));
  return app;
}
