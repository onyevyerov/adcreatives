import { createHash, timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest();

/** Пароль із заголовка `Authorization: Basic …` (ім'я користувача будь-яке). */
export function basicPassword(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(header);
  if (!m?.[1]) return null;
  const decoded = Buffer.from(m[1], "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  return colon < 0 ? null : decoded.slice(colon + 1);
}

/**
 * HTTP Basic з одним паролем `APP_PASSWORD` на всі маршрути. Порожній пароль — без авторизації
 * (локальна розробка). Порівняння за сталий час (через хеші однакової довжини).
 */
export function basicAuth(password: string): MiddlewareHandler {
  const expected = sha256(password);
  return async (c, next) => {
    if (!password) return next();
    const given = basicPassword(c.req.header("authorization"));
    if (given !== null && timingSafeEqual(sha256(given), expected)) return next();
    return c.text("Потрібен пароль", 401, {
      "WWW-Authenticate": 'Basic realm="Crealab", charset="UTF-8"',
    });
  };
}

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Захист від CSRF: браузер надсилає збережені Basic-облікові дані і з чужих сайтів, тож
 * змінювальні запити з іншого походження відхиляються. Працює і за проксі (Caddy), бо
 * порівнює хост Origin із Host / X-Forwarded-Host, а не схему.
 */
export function sameOriginGuard(): MiddlewareHandler {
  return async (c, next) => {
    if (!UNSAFE_METHODS.has(c.req.method)) return next();
    if (c.req.header("sec-fetch-site") === "cross-site") return c.text("Запит з іншого сайту", 403);
    const origin = c.req.header("origin");
    if (origin && origin !== "null") {
      const host = c.req.header("x-forwarded-host") ?? c.req.header("host");
      let originHost: string | null = null;
      try {
        originHost = new URL(origin).host;
      } catch {
        originHost = null;
      }
      if (host && originHost !== host.split(",")[0]?.trim()) return c.text("Запит з іншого сайту", 403);
    }
    return next();
  };
}
