import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
  type AppEnv,
  clearSessionCookie,
  requireAdmin,
  requireUser,
  SESSION_COOKIE,
  sessionMiddleware,
  setSessionCookie,
} from "../src/session.ts";
import { type Env, seedUser, setup } from "./helpers.ts";

/** Мінімальний застосунок поверх deps оточення: віддає `c.get("user")` і перевіряє guard-и. */
function probe(env: Env) {
  const app = new Hono<AppEnv>();
  app.use("*", sessionMiddleware(env));
  app.get("/whoami", (c) => c.json({ user: c.get("user") }));
  app.get("/private", requireUser(), (c) => c.json({ ok: true }));
  app.get("/admin", requireUser(), requireAdmin(), (c) => c.json({ ok: true }));
  app.post("/login", (c) => {
    setSessionCookie(c, "tok123");
    return c.body(null, 204);
  });
  app.post("/logout", (c) => {
    clearSessionCookie(c);
    return c.body(null, 204);
  });
  return app;
}

const withCookie = (cookie: string | null): RequestInit => (cookie ? { headers: { cookie } } : {});

describe("sessionMiddleware", () => {
  it("без cookie → user null", async () => {
    const env = await setup({}, { user: null });
    expect(env.user).toBeNull();
    expect(env.cookie).toBeNull();
    const res = await probe(env).request("/whoami");
    expect(await res.json()).toEqual({ user: null });
  });

  it("з валідною сесією → PublicUser з isAdmin за adminEmails", async () => {
    const env = await setup();
    const res = await probe(env).request("/whoami", withCookie(env.cookie));
    const { user } = (await res.json()) as { user: Record<string, unknown> };
    expect(user).toEqual(env.user);
    expect(user).toMatchObject({ email: "user@example.com", name: "Тест", isAdmin: false });
    expect(user.activatedAt).not.toBeNull();
    expect(user).not.toHaveProperty("passwordHash");

    const admin = await seedUser(env, { email: "admin@example.com", name: "Адмін" });
    const res2 = await probe(env).request("/whoami", withCookie(admin.cookie));
    expect(((await res2.json()) as { user: { isAdmin: boolean } }).user.isAdmin).toBe(true);

    // Роль обчислюється на кожен запит: прибрали з ADMIN_EMAILS — більше не admin.
    env.config.adminEmails.length = 0;
    const res3 = await probe(env).request("/whoami", withCookie(admin.cookie));
    expect(((await res3.json()) as { user: { isAdmin: boolean } }).user.isAdmin).toBe(false);
  });

  it("протухла/знищена/невідома сесія → null", async () => {
    const env = await setup();
    const app = probe(env);
    const unknown = await app.request("/whoami", withCookie(`${SESSION_COOKIE}=nope`));
    expect(await unknown.json()).toEqual({ user: null });

    const token = env.cookie?.split("=")[1] ?? "";
    await env.sessions.destroy(token);
    const destroyed = await app.request("/whoami", withCookie(env.cookie));
    expect(await destroyed.json()).toEqual({ user: null });

    const fresh = await seedUser(env, { email: "short@example.com" });
    await env.redis.flushall();
    const expired = await app.request("/whoami", withCookie(fresh.cookie));
    expect(await expired.json()).toEqual({ user: null });
  });

  it("env.request підмішує cookie; app змонтовано із sessionMiddleware", async () => {
    const env = await setup();
    const res = await env.request("/api/auth/me");
    // Сесія з cookie доходить до requireUser роутера auth.
    expect(res.status).toBe(200);
    expect((await res.json()).user.email).toBe("user@example.com");
  });
});

describe("requireUser / requireAdmin", () => {
  it("анонім → 401 з тілом; не-admin → 403 з тілом; admin → 200", async () => {
    const env = await setup({}, { user: null });
    const app = probe(env);
    const anon = await app.request("/private");
    expect(anon.status).toBe(401);
    expect(await anon.json()).toEqual({ error: "unauthorized", message: "Потрібно увійти." });
    const anonAdmin = await app.request("/admin");
    expect(anonAdmin.status).toBe(401);

    const user = await seedUser(env, { email: "user@example.com" });
    expect((await app.request("/private", withCookie(user.cookie))).status).toBe(200);
    const forbidden = await app.request("/admin", withCookie(user.cookie));
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ error: "forbidden", message: "Лише для адміністратора." });

    const admin = await seedUser(env, { email: "boss@example.com", admin: true });
    expect(admin.user.isAdmin).toBe(true);
    expect((await app.request("/admin", withCookie(admin.cookie))).status).toBe(200);
  });

  it("seedUser: неактивований і з кредитами", async () => {
    const env = await setup({}, { user: { credits: 15 } });
    expect(await env.accounts.balance(env.user?.id ?? "")).toBe(15);
    const inactive = await seedUser(env, { email: "new@example.com", activated: false });
    expect(inactive.user.activatedAt).toBeNull();
  });
});

describe("cookie сесії", () => {
  it("HttpOnly, SameSite=Lax, Path=/, Max-Age 30 діб; Secure лише за x-forwarded-proto: https", async () => {
    const env = await setup({}, { user: null });
    const app = probe(env);
    const plain = (await app.request("/login", { method: "POST" })).headers.get("set-cookie") ?? "";
    expect(plain).toContain(`${SESSION_COOKIE}=tok123`);
    expect(plain).toContain("HttpOnly");
    expect(plain).toContain("SameSite=Lax");
    expect(plain).toContain("Path=/");
    expect(plain).toContain(`Max-Age=${30 * 24 * 60 * 60}`);
    expect(plain).not.toContain("Secure");

    const https = await app.request("/login", { method: "POST", headers: { "x-forwarded-proto": "https" } });
    expect(https.headers.get("set-cookie")).toContain("Secure");
  });

  it("clearSessionCookie → Max-Age=0", async () => {
    const env = await setup({}, { user: null });
    const res = await probe(env).request("/logout", { method: "POST" });
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${SESSION_COOKIE}=;`);
    expect(cookie).toContain("Max-Age=0");
  });
});
