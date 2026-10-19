import { noopLogger, type PublicUser, type User } from "@adc/shared";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { ApiConfig } from "./config.ts";
import type { ApiDeps } from "./deps.ts";

/** Змінні контексту Hono: поточний користувач сесії (null — анонім). */
export type AppEnv = { Variables: { user: PublicUser | null } };

export const SESSION_COOKIE = "adc_session";
/** Max-Age cookie сесії, с (30 діб — як TTL сесії в Redis). */
export const SESSION_COOKIE_MAX_AGE = 30 * 24 * 60 * 60;

export function isAdminEmail(config: ApiConfig, email: string): boolean {
  return config.adminEmails.includes(email.trim().toLowerCase());
}

export function toPublic(user: User, adminEmails: string[]): PublicUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    createdAt: user.createdAt,
    activatedAt: user.activatedAt,
    isAdmin: adminEmails.includes(user.email.trim().toLowerCase()),
  };
}

/** getCookie → sessions.resolve → accounts.getUser → c.set("user", …); інакше null. Нічого не блокує. */
export function sessionMiddleware(deps: ApiDeps): MiddlewareHandler<AppEnv> {
  const logger = deps.logger ?? noopLogger;
  return async (c, next) => {
    c.set("user", null);
    const token = getCookie(c, SESSION_COOKIE);
    if (token) {
      try {
        const userId = await deps.sessions.resolve(token);
        const user = userId ? await deps.accounts.getUser(userId) : null;
        if (user) c.set("user", toPublic(user, deps.config.adminEmails));
      } catch (err) {
        // Недоступний Redis не має ламати публічні сторінки: запит іде далі анонімом.
        logger.warn("не вдалося перевірити сесію", { error: String(err) });
      }
    }
    return next();
  };
}

/** 401 {error:"unauthorized", message:"Потрібно увійти."} */
export function requireUser(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!c.get("user")) return c.json({ error: "unauthorized", message: "Потрібно увійти." }, 401);
    return next();
  };
}

/** 403 {error:"forbidden", message:"Лише для адміністратора."} (після requireUser) */
export function requireAdmin(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!c.get("user")?.isAdmin)
      return c.json({ error: "forbidden", message: "Лише для адміністратора." }, 403);
    return next();
  };
}

/** HTTPS за проксі (`x-forwarded-proto`) або напряму. */
function isHttps(c: Context<AppEnv>): boolean {
  const proto = c.req.header("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  return proto === "https" || c.req.url.startsWith("https:");
}

/** HttpOnly; SameSite=Lax; Path=/; Max-Age 30 діб; Secure, якщо x-forwarded-proto: https або URL https. */
export function setSessionCookie(c: Context<AppEnv>, token: string): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_COOKIE_MAX_AGE,
    secure: isHttps(c),
  });
}

export function clearSessionCookie(c: Context<AppEnv>): void {
  setCookie(c, SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    maxAge: 0,
    secure: isHttps(c),
  });
}
