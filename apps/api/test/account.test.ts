import { type LedgerEntry, verifyPassword } from "@adc/shared";
import { describe, expect, it } from "vitest";
import { SESSION_COOKIE } from "../src/session.ts";
import { json, SEED_PASSWORD, seedUser, setup } from "./helpers.ts";

const patch = (body: unknown): RequestInit => ({ ...json(body), method: "PATCH" });

/** `adc_session=<token>` з Set-Cookie відповіді. */
function sessionFrom(res: Response): string | null {
  const m = (res.headers.get("set-cookie") ?? "").match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
  return m ? `${SESSION_COOKIE}=${m[1]}` : null;
}

describe("/api/account — доступ", () => {
  it("анонім → 401 на всіх endpoint-ах", async () => {
    const env = await setup({}, { user: null });
    const calls: [string, RequestInit?][] = [
      ["/api/account"],
      ["/api/account", patch({ name: "X" })],
      ["/api/account/password", json({ current: "a", next: "bbbbbbbb" })],
      ["/api/account/transactions"],
    ];
    for (const [path, init] of calls) {
      const res = await env.request(path, init);
      expect(res.status, path).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized", message: "Потрібно увійти." });
    }
  });
});

describe("профіль", () => {
  it("GET → {user, balance}", async () => {
    const env = await setup({}, { user: { credits: 7 } });
    const res = await env.request("/api/account");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: Record<string, unknown>; balance: number };
    expect(body).toEqual({ user: env.user, balance: 7 });
    expect(body.user).not.toHaveProperty("passwordHash");
  });

  it("PATCH {name} → {user}; невалідне ім'я → 400 invalid_body", async () => {
    const env = await setup();
    const res = await env.request("/api/account", patch({ name: "  Нове Ім'я  " }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: { ...env.user, name: "Нове Ім'я" } });
    expect((await env.accounts.getUser(env.user?.id ?? ""))?.name).toBe("Нове Ім'я");

    for (const body of [{ name: "" }, { name: "   " }, { name: "x".repeat(81) }, {}, { name: 5 }]) {
      const bad = await env.request("/api/account", patch(body));
      expect(bad.status).toBe(400);
      expect(((await bad.json()) as { error: string }).error).toBe("invalid_body");
    }
    const notJson = await env.request("/api/account", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: "{не json",
    });
    expect(notJson.status).toBe(400);
  });
});

describe("зміна пароля", () => {
  it("інвалідує всі сесії, поточний запит отримує новий cookie; старий пароль → 401", async () => {
    const env = await setup();
    const uid = env.user?.id ?? "";
    const other = `${SESSION_COOKIE}=${await env.sessions.create(uid)}`;
    expect((await env.app.request("/api/account", { headers: { cookie: other } })).status).toBe(200);

    const res = await env.request(
      "/api/account/password",
      json({ current: SEED_PASSWORD, next: "newpass456" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const fresh = sessionFrom(res);
    expect(fresh).not.toBeNull();
    expect(fresh).not.toBe(env.cookie);
    expect(res.headers.get("set-cookie")).toContain("HttpOnly");

    // Інша сесія і стара поточна — недійсні.
    expect((await env.app.request("/api/account", { headers: { cookie: other } })).status).toBe(401);
    expect((await env.request("/api/account")).status).toBe(401);
    // Новий cookie працює.
    const withFresh = { headers: { cookie: fresh ?? "" } };
    expect((await env.app.request("/api/account", withFresh)).status).toBe(200);

    const stored = await env.accounts.getUser(uid);
    expect(await verifyPassword("newpass456", stored?.passwordHash ?? "")).toBe(true);
    expect(await verifyPassword(SEED_PASSWORD, stored?.passwordHash ?? "")).toBe(false);

    // Старий пароль як current → 401.
    const again = await env.app.request("/api/account/password", {
      ...json({ current: SEED_PASSWORD, next: "another789" }),
      headers: { "Content-Type": "application/json", cookie: fresh ?? "" },
    });
    expect(again.status).toBe(401);
    expect(((await again.json()) as { error: string }).error).toBe("invalid_credentials");
  });

  it("невірний current → 401 invalid_credentials, сесії не чіпаються", async () => {
    const env = await setup();
    const res = await env.request(
      "/api/account/password",
      json({ current: "wrongpass", next: "newpass456" }),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "invalid_credentials" });
    expect(res.headers.get("set-cookie")).toBeNull();
    expect((await env.request("/api/account")).status).toBe(200);
  });

  it("слабкий новий пароль → 400 weak_password; невалідне тіло → 400 invalid_body", async () => {
    const env = await setup();
    for (const next of ["short", "x".repeat(129)]) {
      const res = await env.request("/api/account/password", json({ current: SEED_PASSWORD, next }));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "weak_password",
        message: "Пароль — від 8 до 128 символів.",
      });
    }
    const bad = await env.request("/api/account/password", json({ next: "newpass456" }));
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe("invalid_body");
    // Пароль не змінився.
    const stored = await env.accounts.getUser(env.user?.id ?? "");
    expect(await verifyPassword(SEED_PASSWORD, stored?.passwordHash ?? "")).toBe(true);
  });
});

describe("історія транзакцій", () => {
  type Page = { entries: LedgerEntry[]; nextBefore: string | null };
  /**
   * Десятки послідовних записів у леджер — IO: окремо ~2 с, але під паралельним `pnpm test`
   * (кілька пакетів одночасно) дефолтних 5 с не вистачає.
   */
  const LEDGER_FILL_TIMEOUT_MS = 20_000;

  it(
    "120 записів пагінуються before без дублів і пропусків; новіші першими",
    async () => {
      const env = await setup();
      const uid = env.user?.id ?? "";
      for (let i = 0; i < 120; i++)
        await env.accounts.apply(uid, { id: `adjust:t${i}`, kind: "adjust", credits: 1 });

      const seen: string[] = [];
      const sizes: number[] = [];
      let before: string | null = null;
      for (let guard = 0; guard < 10; guard++) {
        const q: string = before ? `&before=${encodeURIComponent(before)}` : "";
        const res = await env.request(`/api/account/transactions?limit=50${q}`);
        expect(res.status).toBe(200);
        const page = (await res.json()) as Page;
        sizes.push(page.entries.length);
        seen.push(...page.entries.map((e) => e.id));
        if (page.nextBefore === null) break;
        expect(page.nextBefore).toBe(page.entries.at(-1)?.id);
        before = page.nextBefore;
      }
      expect(sizes).toEqual([50, 50, 20]);
      expect(new Set(seen).size).toBe(120);
      expect(seen).toEqual(Array.from({ length: 120 }, (_, i) => `adjust:t${119 - i}`));
    },
    LEDGER_FILL_TIMEOUT_MS,
  );

  it(
    "limit за замовчуванням 50; межі 1…200; неповна сторінка → nextBefore null",
    async () => {
      const env = await setup({}, { user: { credits: 5 } });
      const uid = env.user?.id ?? "";
      for (let i = 0; i < 60; i++)
        await env.accounts.apply(uid, { id: `adjust:d${i}`, kind: "adjust", credits: 1 });

      const def = (await (await env.request("/api/account/transactions")).json()) as Page;
      expect(def.entries).toHaveLength(50);
      expect(def.nextBefore).toBe("adjust:d10");

      const all = (await (await env.request("/api/account/transactions?limit=200")).json()) as Page;
      expect(all.entries).toHaveLength(61);
      expect(all.nextBefore).toBeNull();
      expect(all.entries.at(-1)?.id).toBe(`bonus:seed:${uid}`);

      for (const bad of ["0", "201", "abc", "1.5", "-1"]) {
        const res = await env.request(`/api/account/transactions?limit=${bad}`);
        expect(res.status, bad).toBe(400);
        expect(((await res.json()) as { error: string }).error).toBe("invalid_body");
      }
    },
    LEDGER_FILL_TIMEOUT_MS,
  );

  it("порожній леджер → {entries: [], nextBefore: null}; бачить лише свої", async () => {
    const env = await setup();
    const other = await seedUser(env, { email: "other@example.com", credits: 9 });
    expect(await (await env.request("/api/account/transactions")).json()).toEqual({
      entries: [],
      nextBefore: null,
    });
    const theirs = (await (await other.request("/api/account/transactions")).json()) as Page;
    expect(theirs.entries.map((e) => e.userId)).toEqual([other.user.id]);
  });
});
