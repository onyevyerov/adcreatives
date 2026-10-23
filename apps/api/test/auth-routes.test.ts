import { OutboxMail } from "@adc/shared";
import { describe, expect, it, vi } from "vitest";
import {
  ACTIVATE_TOKEN_TTL_MS,
  FORGOT_ACCEPTED,
  REGISTER_ACCEPTED,
  RESEND_ACCEPTED,
  RESET_TOKEN_TTL_MS,
} from "../src/routes/auth.ts";
import { SESSION_COOKIE } from "../src/session.ts";
import { type Env, json, NOW, SEED_PASSWORD, seedUser, setup } from "./helpers.ts";

// Шпигун на verifyPassword: login має виконувати scrypt і для неіснуючого e-mail.
vi.mock("@adc/shared", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@adc/shared")>();
  return { ...orig, verifyPassword: vi.fn(orig.verifyPassword) };
});
const shared = await import("@adc/shared");

const PASSWORD = "correct horse 1";

/** POST JSON (з додатковими заголовками). */
const post = (body: unknown, headers: Record<string, string> = {}): RequestInit => {
  const init = json(body);
  return { ...init, headers: { ...(init.headers as Record<string, string>), ...headers } };
};
const withCookie = (cookie: string | null, init: RequestInit = {}): RequestInit =>
  cookie ? { ...init, headers: { ...(init.headers as Record<string, string>), cookie } } : init;

/** `adc_session=<token>` з Set-Cookie відповіді (null — cookie не ставився). */
function sessionCookie(res: Response): string | null {
  const m = new RegExp(`${SESSION_COOKIE}=([^;]*)`).exec(res.headers.get("set-cookie") ?? "");
  return m?.[1] ? `${SESSION_COOKIE}=${m[1]}` : null;
}

async function outbox(env: Env): Promise<Map<string, OutboxMail>> {
  const out = new Map<string, OutboxMail>();
  for (const key of await env.storage.list("outbox"))
    out.set(key, await env.storage.readJson(key, OutboxMail.parse));
  return out;
}

/** Листи, що з'явились після знімка `before`. */
async function newMails(env: Env, before: Map<string, OutboxMail>): Promise<OutboxMail[]> {
  return [...(await outbox(env))].filter(([k]) => !before.has(k)).map(([, m]) => m);
}

const tokenOf = (mail: OutboxMail) => new URL(mail.link).searchParams.get("token") ?? "";

/** Реєстрація → єдиний новий лист активації → токен. */
async function register(env: Env, email: string, name = "Оля"): Promise<string> {
  const before = await outbox(env);
  const res = await env.app.request("/api/auth/register", post({ email, name, password: PASSWORD }));
  expect(res.status).toBe(202);
  const mails = await newMails(env, before);
  expect(mails).toHaveLength(1);
  return tokenOf(mails[0] as OutboxMail);
}

async function me(env: Env, cookie: string | null) {
  return env.app.request("/api/auth/me", withCookie(cookie));
}

describe("повний цикл", () => {
  it("register → outbox → activate → me → logout → me 401 → login → me", async () => {
    const env = await setup({}, { user: null });
    const before = await outbox(env);
    const reg = await env.app.request(
      "/api/auth/register",
      post({ email: "  Olya@Example.COM ", name: " Оля ", password: PASSWORD }),
    );
    expect(reg.status).toBe(202);
    expect(await reg.json()).toEqual({ message: REGISTER_ACCEPTED });
    expect(sessionCookie(reg)).toBeNull();

    const mails = await newMails(env, before);
    expect(mails).toHaveLength(1);
    const mail = mails[0] as OutboxMail;
    expect(mail).toMatchObject({
      to: "olya@example.com",
      kind: "activate",
      subject: "Активація акаунта Crealab",
    });
    expect(mail.link.startsWith("http://localhost:3000/?auth=activate&token=")).toBe(true);
    expect(mail.text).toContain(mail.link);

    // До активації акаунт є, але не активований.
    const pending = await env.accounts.findByEmail("olya@example.com");
    expect(pending).toMatchObject({ name: "Оля", activatedAt: null });

    const act = await env.app.request("/api/auth/activate", post({ token: tokenOf(mail) }));
    expect(act.status).toBe(200);
    const actBody = (await act.json()) as { user: Record<string, unknown>; balance: number };
    expect(actBody.balance).toBe(0);
    expect(actBody.user).toMatchObject({
      email: "olya@example.com",
      name: "Оля",
      isAdmin: false,
      activatedAt: NOW.toISOString(),
    });
    expect(actBody.user).not.toHaveProperty("passwordHash");
    const cookie = sessionCookie(act);
    expect(cookie).not.toBeNull();

    const meRes = await me(env, cookie);
    expect(meRes.status).toBe(200);
    const credits = env.config.credits;
    expect(await meRes.json()).toEqual({
      user: actBody.user,
      balance: 0,
      prices: credits.prices,
      packages: credits.packages,
      custom: credits.custom,
      creditsPerUsd: credits.creditsPerUsd,
    });

    const out = await env.app.request("/api/auth/logout", withCookie(cookie, { method: "POST" }));
    expect(out.status).toBe(204);
    expect(out.headers.get("set-cookie")).toMatch(/adc_session=;.*Max-Age=0/);
    const after = await me(env, cookie);
    expect(after.status).toBe(401);
    expect(await after.json()).toEqual({ error: "unauthorized", message: "Потрібно увійти." });

    const login = await env.app.request(
      "/api/auth/login",
      post({ email: "OLYA@example.com", password: PASSWORD }),
    );
    expect(login.status).toBe(200);
    expect(await login.json()).toEqual({ user: actBody.user, balance: 0 });
    const cookie2 = sessionCookie(login);
    expect(cookie2).not.toBeNull();
    expect(cookie2).not.toBe(cookie);
    expect((await me(env, cookie2)).status).toBe(200);
  });

  it("admin з ADMIN_EMAILS після активації — isAdmin true (адмін не активується сам)", async () => {
    const env = await setup({}, { user: null });
    const token = await register(env, "admin@example.com", "Адмін");
    const login = await env.app.request(
      "/api/auth/login",
      post({ email: "admin@example.com", password: PASSWORD }),
    );
    expect(login.status).toBe(403);
    const act = await env.app.request("/api/auth/activate", post({ token }));
    expect(((await act.json()) as { user: { isAdmin: boolean } }).user.isAdmin).toBe(true);
  });

  it("logout без cookie → 204; me анонімом → 401", async () => {
    const env = await setup({}, { user: null });
    const res = await env.app.request("/api/auth/logout", { method: "POST" });
    expect(res.status).toBe(204);
    expect((await me(env, null)).status).toBe(401);
  });
});

describe("login", () => {
  it("невірний пароль і невідомий e-mail → однакові 401; scrypt виконується завжди", async () => {
    const env = await setup();
    const verify = vi.mocked(shared.verifyPassword);
    verify.mockClear();

    const wrong = await env.app.request(
      "/api/auth/login",
      post({ email: "user@example.com", password: "wrong-password" }),
    );
    const unknown = await env.app.request(
      "/api/auth/login",
      post({ email: "ghost@example.com", password: "wrong-password" }),
    );
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    const wrongText = await wrong.text();
    expect(wrongText).toBe(await unknown.text());
    expect(JSON.parse(wrongText)).toEqual({
      error: "invalid_credentials",
      message: "Невірний e-mail або пароль.",
    });
    expect(sessionCookie(wrong)).toBeNull();

    expect(verify).toHaveBeenCalledTimes(2);
    expect(verify.mock.calls[1]?.[1]).toBe(shared.DUMMY_PASSWORD_HASH);
    expect(verify.mock.calls[0]?.[1]).not.toBe(shared.DUMMY_PASSWORD_HASH);

    const ok = await env.app.request(
      "/api/auth/login",
      post({ email: "user@example.com", password: SEED_PASSWORD }),
    );
    expect(ok.status).toBe(200);
  });

  it("неактивований з вірним паролем → 403 not_activated; з невірним → 401", async () => {
    const env = await setup({}, { user: null });
    await seedUser(env, { email: "late@example.com", activated: false });
    const res = await env.app.request(
      "/api/auth/login",
      post({ email: "late@example.com", password: SEED_PASSWORD }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "not_activated",
      message: "Акаунт ще не активовано — перевірте пошту.",
    });
    expect(sessionCookie(res)).toBeNull();
    const wrong = await env.app.request(
      "/api/auth/login",
      post({ email: "late@example.com", password: "nope-nope" }),
    );
    expect(wrong.status).toBe(401);
  });

  it("невалідне тіло → 400 invalid_body", async () => {
    const env = await setup({}, { user: null });
    for (const body of [{}, { email: "not-an-email", password: "x" }, { email: "a@example.com" }]) {
      const res = await env.app.request("/api/auth/login", post(body));
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("invalid_body");
    }
    const broken = await env.app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(broken.status).toBe(400);
  });
});

describe("register", () => {
  it("відповідь для нового, активованого й неактивованого e-mail побайтно однакова; різниця — лише outbox", async () => {
    const env = await setup({}, { user: null });
    await seedUser(env, { email: "taken@example.com" });
    await seedUser(env, { email: "pending@example.com", activated: false });

    const results: { status: number; text: string; mails: OutboxMail[] }[] = [];
    for (const email of ["fresh@example.com", "taken@example.com", "pending@example.com"]) {
      const before = await outbox(env);
      const res = await env.app.request(
        "/api/auth/register",
        post({ email, name: "Хтось", password: PASSWORD }),
      );
      results.push({ status: res.status, text: await res.text(), mails: await newMails(env, before) });
    }
    const [fresh, taken, pending] = results as [
      (typeof results)[0],
      (typeof results)[0],
      (typeof results)[0],
    ];
    expect(fresh.status).toBe(202);
    expect(taken.status).toBe(fresh.status);
    expect(pending.status).toBe(fresh.status);
    expect(taken.text).toBe(fresh.text);
    expect(pending.text).toBe(fresh.text);
    expect(JSON.parse(fresh.text)).toEqual({ message: REGISTER_ACCEPTED });

    expect(fresh.mails.map((m) => m.to)).toEqual(["fresh@example.com"]);
    expect(taken.mails).toEqual([]);
    // Неактивований — перевипуск токена: новий лист, новий робочий токен.
    expect(pending.mails.map((m) => m.to)).toEqual(["pending@example.com"]);
    const act = await env.app.request(
      "/api/auth/activate",
      post({ token: tokenOf(pending.mails[0] as OutboxMail) }),
    );
    expect(act.status).toBe(200);

    // Активований акаунт не змінено (ні пароль, ні ім'я).
    const login = await env.app.request(
      "/api/auth/login",
      post({ email: "taken@example.com", password: SEED_PASSWORD }),
    );
    expect(login.status).toBe(200);
    expect(((await login.json()) as { user: { name: string } }).user.name).toBe("Тест");
  });

  it("слабкий пароль → 400 weak_password, акаунт не створено", async () => {
    const env = await setup({}, { user: null });
    for (const password of ["short", "x".repeat(129)]) {
      const res = await env.app.request(
        "/api/auth/register",
        post({ email: "weak@example.com", name: "Оля", password }),
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "weak_password",
        message: "Пароль — від 8 до 128 символів.",
      });
    }
    expect(await env.accounts.findByEmail("weak@example.com")).toBeNull();
    expect(await outbox(env)).toHaveProperty("size", 0);
    const edge = await env.app.request(
      "/api/auth/register",
      post({ email: "edge@example.com", name: "Оля", password: "x".repeat(128) }),
    );
    expect(edge.status).toBe(202);
  });

  it("невалідне тіло → 400 invalid_body", async () => {
    const env = await setup({}, { user: null });
    const bodies = [
      {},
      { email: "bad", name: "Оля", password: PASSWORD },
      { email: "a@example.com", name: "", password: PASSWORD },
      { email: "a@example.com", name: "   ", password: PASSWORD },
      { email: "a@example.com", name: "я".repeat(81), password: PASSWORD },
      { email: "a@example.com", name: "Оля", password: 12345678 },
    ];
    for (const body of bodies) {
      const res = await env.app.request("/api/auth/register", post(body));
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("invalid_body");
    }
  });

  it("токен активації видається з TTL 24 год, скидання — 1 год", async () => {
    const env = await setup({}, { user: null });
    const issue = vi.spyOn(env.tokens, "issue");
    await register(env, "ttl@example.com");
    const user = await env.accounts.findByEmail("ttl@example.com");
    expect(issue).toHaveBeenLastCalledWith("activate", user?.id, ACTIVATE_TOKEN_TTL_MS);
    expect(ACTIVATE_TOKEN_TTL_MS).toBe(24 * 60 * 60 * 1000);

    await seedUser(env, { email: "reset-ttl@example.com" });
    await env.app.request("/api/auth/forgot", post({ email: "reset-ttl@example.com" }));
    const resetUser = await env.accounts.findByEmail("reset-ttl@example.com");
    expect(issue).toHaveBeenLastCalledWith("reset", resetUser?.id, RESET_TOKEN_TTL_MS);
    expect(RESET_TOKEN_TTL_MS).toBe(60 * 60 * 1000);
  });

  it("посилання з APP_URL конфігу", async () => {
    const env = await setup({ appUrl: "https://ads.example.org" }, { user: null });
    const before = await outbox(env);
    await env.app.request(
      "/api/auth/register",
      post({ email: "u@example.com", name: "U", password: PASSWORD }),
    );
    const [mail] = await newMails(env, before);
    expect(mail?.link).toMatch(/^https:\/\/ads\.example\.org\/\?auth=activate&token=[A-Za-z0-9_-]+$/);
  });
});

describe("activate", () => {
  it("токен одноразовий: другий activate → 400 invalid_token", async () => {
    const env = await setup({}, { user: null });
    const token = await register(env, "once@example.com");
    expect((await env.app.request("/api/auth/activate", post({ token }))).status).toBe(200);
    const again = await env.app.request("/api/auth/activate", post({ token }));
    expect(again.status).toBe(400);
    expect(await again.json()).toEqual({
      error: "invalid_token",
      message: "Посилання недійсне або застаріло.",
    });
    expect(sessionCookie(again)).toBeNull();
  });

  it("невідомий токен → 400 invalid_token; без токена → 400 invalid_body", async () => {
    const env = await setup({}, { user: null });
    const res = await env.app.request("/api/auth/activate", post({ token: "nope" }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_token");
    const empty = await env.app.request("/api/auth/activate", post({}));
    expect(((await empty.json()) as { error: string }).error).toBe("invalid_body");
  });

  it("токен скидання не активує (різні простори токенів)", async () => {
    const env = await setup({}, { user: null });
    const { user } = await seedUser(env, { email: "kinds@example.com", activated: false });
    const resetToken = await env.tokens.issue("reset", user.id, RESET_TOKEN_TTL_MS);
    const res = await env.app.request("/api/auth/activate", post({ token: resetToken }));
    expect(res.status).toBe(400);
  });

  it("signupBonus 5 → баланс 5 і запис bonus:signup:<uid>; повторна активація не нараховує вдруге", async () => {
    const env = await setup({}, { user: null });
    env.config.credits = { ...env.config.credits, signupBonus: 5 };
    const token = await register(env, "bonus@example.com");
    const act = await env.app.request("/api/auth/activate", post({ token }));
    const body = (await act.json()) as { user: { id: string; activatedAt: string }; balance: number };
    expect(body.balance).toBe(5);
    const ledger = await env.accounts.readLedger(body.user.id);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      id: `bonus:signup:${body.user.id}`,
      kind: "bonus",
      credits: 5,
      balanceAfter: 5,
    });

    // Повторна активація (новий токен уже активованого) — no-op: activatedAt і баланс ті самі.
    const second = await env.tokens.issue("activate", body.user.id, ACTIVATE_TOKEN_TTL_MS);
    const again = await env.app.request("/api/auth/activate", post({ token: second }));
    expect(again.status).toBe(200);
    const againBody = (await again.json()) as typeof body;
    expect(againBody.balance).toBe(5);
    expect(againBody.user.activatedAt).toBe(body.user.activatedAt);
    expect(await env.accounts.readLedger(body.user.id)).toHaveLength(1);
  });

  it("signupBonus 0 → леджер порожній", async () => {
    const env = await setup({}, { user: null });
    const token = await register(env, "nobonus@example.com");
    const body = (await (await env.app.request("/api/auth/activate", post({ token }))).json()) as {
      user: { id: string };
    };
    expect(await env.accounts.readLedger(body.user.id)).toEqual([]);
  });
});

describe("resend", () => {
  it("лише неактивованим — новий лист; відповідь завжди однакова 202", async () => {
    const env = await setup({}, { user: null });
    await seedUser(env, { email: "active@example.com" });
    await seedUser(env, { email: "waiting@example.com", activated: false });
    const results: { text: string; status: number; mails: OutboxMail[] }[] = [];
    for (const email of ["waiting@example.com", "active@example.com", "ghost@example.com"]) {
      const before = await outbox(env);
      const res = await env.app.request("/api/auth/resend", post({ email }));
      results.push({ status: res.status, text: await res.text(), mails: await newMails(env, before) });
    }
    for (const r of results) {
      expect(r.status).toBe(202);
      expect(r.text).toBe(JSON.stringify({ message: RESEND_ACCEPTED }));
    }
    expect(results[0]?.mails.map((m) => [m.to, m.kind])).toEqual([["waiting@example.com", "activate"]]);
    expect(results[1]?.mails).toEqual([]);
    expect(results[2]?.mails).toEqual([]);
    const act = await env.app.request(
      "/api/auth/activate",
      post({ token: tokenOf(results[0]?.mails[0] as OutboxMail) }),
    );
    expect(act.status).toBe(200);
  });
});

describe("forgot / reset", () => {
  it("forgot: відповідь для відомого й невідомого e-mail побайтно однакова; лист лише активованому", async () => {
    const env = await setup();
    await seedUser(env, { email: "waiting@example.com", activated: false });
    const results: { text: string; status: number; mails: OutboxMail[] }[] = [];
    for (const email of ["user@example.com", "ghost@example.com", "waiting@example.com"]) {
      const before = await outbox(env);
      const res = await env.app.request("/api/auth/forgot", post({ email }));
      results.push({ status: res.status, text: await res.text(), mails: await newMails(env, before) });
    }
    for (const r of results) {
      expect(r.status).toBe(202);
      expect(r.text).toBe(results[0]?.text);
    }
    expect(JSON.parse(results[0]?.text ?? "")).toEqual({ message: FORGOT_ACCEPTED });
    const mail = results[0]?.mails[0];
    expect(results[0]?.mails).toHaveLength(1);
    expect(mail).toMatchObject({
      to: "user@example.com",
      kind: "reset",
      subject: "Скидання пароля Crealab",
    });
    expect(mail?.link.startsWith("http://localhost:3000/?auth=reset&token=")).toBe(true);
    expect(results[1]?.mails).toEqual([]);
    expect(results[2]?.mails).toEqual([]);
  });

  it("reset: старий cookie недійсний, видано новий; старий пароль не працює; токен одноразовий", async () => {
    const env = await setup();
    const oldCookie = env.cookie;
    const other = await seedUser(env, { email: "other@example.com" });
    expect((await me(env, oldCookie)).status).toBe(200);

    const before = await outbox(env);
    await env.app.request("/api/auth/forgot", post({ email: "user@example.com" }));
    const [mail] = await newMails(env, before);
    const token = tokenOf(mail as OutboxMail);

    // Слабкий пароль → 400 і токен не «згорає».
    const weak = await env.app.request("/api/auth/reset", post({ token, password: "short" }));
    expect(weak.status).toBe(400);
    expect(((await weak.json()) as { error: string }).error).toBe("weak_password");

    const res = await env.app.request("/api/auth/reset", post({ token, password: "brand-new-pass" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { email: string }; balance: number };
    expect(body).toMatchObject({ user: { email: "user@example.com" }, balance: 0 });
    const newCookie = sessionCookie(res);
    expect(newCookie).not.toBeNull();
    expect(newCookie).not.toBe(oldCookie);

    expect((await me(env, oldCookie)).status).toBe(401);
    expect((await me(env, newCookie)).status).toBe(200);
    // Сесії інших користувачів не зачеплено.
    expect((await me(env, other.cookie)).status).toBe(200);

    const oldPass = await env.app.request(
      "/api/auth/login",
      post({ email: "user@example.com", password: SEED_PASSWORD }),
    );
    expect(oldPass.status).toBe(401);
    const newPass = await env.app.request(
      "/api/auth/login",
      post({ email: "user@example.com", password: "brand-new-pass" }),
    );
    expect(newPass.status).toBe(200);

    const reuse = await env.app.request("/api/auth/reset", post({ token, password: "another-pass-1" }));
    expect(reuse.status).toBe(400);
    expect(((await reuse.json()) as { error: string }).error).toBe("invalid_token");
  });

  it("reset: невідомий токен → 400 invalid_token; без пароля → 400 invalid_body", async () => {
    const env = await setup({}, { user: null });
    const res = await env.app.request("/api/auth/reset", post({ token: "nope", password: "long-enough-1" }));
    expect(((await res.json()) as { error: string }).error).toBe("invalid_token");
    const bad = await env.app.request("/api/auth/reset", post({ token: "nope" }));
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe("invalid_body");
  });
});

describe("rate-limit", () => {
  it("11-та спроба з одного ip|email за 15 хв → 429; після зсуву now на 15 хв — знову 202", async () => {
    let clock = NOW;
    const env = await setup({ now: () => clock }, { user: null });
    const ip = { "x-forwarded-for": "203.0.113.7, 10.0.0.1" };
    const body = { email: "spam@example.com", name: "Спам", password: PASSWORD };
    for (let i = 0; i < 10; i++) {
      const res = await env.app.request("/api/auth/register", post(body, ip));
      expect(res.status, `спроба ${i + 1}`).toBe(202);
    }
    const blocked = await env.app.request("/api/auth/register", post(body, ip));
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toEqual({
      error: "rate_limited",
      message: "Забагато спроб. Спробуйте за 15 хвилин.",
    });
    // Той самий клієнт за іншим проксі-ланцюгом — той самий ключ (перший елемент x-forwarded-for).
    const sameIp = await env.app.request(
      "/api/auth/register",
      post(body, { "x-forwarded-for": "203.0.113.7" }),
    );
    expect(sameIp.status).toBe(429);
    // Регістр e-mail не обходить ліміт.
    const upper = await env.app.request(
      "/api/auth/register",
      post({ ...body, email: "SPAM@example.com" }, ip),
    );
    expect(upper.status).toBe(429);
    // Ліміт спільний для auth-маршрутів того самого ip|email.
    expect((await env.app.request("/api/auth/forgot", post({ email: body.email }, ip))).status).toBe(429);
    expect(
      (await env.app.request("/api/auth/login", post({ email: body.email, password: PASSWORD }, ip))).status,
    ).toBe(429);

    // Інший e-mail з того ж IP і той самий e-mail з іншого IP / без проксі — окремі ключі.
    expect(
      (await env.app.request("/api/auth/register", post({ ...body, email: "other@example.com" }, ip))).status,
    ).toBe(202);
    expect(
      (await env.app.request("/api/auth/register", post(body, { "x-forwarded-for": "198.51.100.1" }))).status,
    ).toBe(202);
    expect((await env.app.request("/api/auth/register", post(body))).status).toBe(202);

    clock = new Date(NOW.getTime() + 15 * 60_000);
    expect((await env.app.request("/api/auth/register", post(body, ip))).status).toBe(202);
  });

  it("login: 10 невдалих спроб, 11-та — 429 навіть з вірним паролем", async () => {
    const env = await setup();
    for (let i = 0; i < 10; i++) {
      const res = await env.app.request(
        "/api/auth/login",
        post({ email: "user@example.com", password: "wrong-pass" }),
      );
      expect(res.status).toBe(401);
    }
    const res = await env.app.request(
      "/api/auth/login",
      post({ email: "user@example.com", password: SEED_PASSWORD }),
    );
    expect(res.status).toBe(429);
  });

  it("resend і forgot теж обмежені", async () => {
    const env = await setup({}, { user: null });
    for (const route of ["/api/auth/resend", "/api/auth/forgot"]) {
      const email = `${route.split("/").pop()}@example.com`;
      for (let i = 0; i < 10; i++) expect((await env.app.request(route, post({ email }))).status).toBe(202);
      expect((await env.app.request(route, post({ email }))).status, route).toBe(429);
    }
  });

  it("лімітер свій на кожен застосунок (authRoutes)", async () => {
    const a = await setup({}, { user: null });
    for (let i = 0; i < 10; i++) await a.app.request("/api/auth/forgot", post({ email: "x@example.com" }));
    expect((await a.app.request("/api/auth/forgot", post({ email: "x@example.com" }))).status).toBe(429);
    const b = await setup({}, { user: null });
    expect((await b.app.request("/api/auth/forgot", post({ email: "x@example.com" }))).status).toBe(202);
  });
});

describe("cookie", () => {
  it("HttpOnly, SameSite=Lax, Path=/, Max-Age 30 діб; Secure лише за x-forwarded-proto: https", async () => {
    const env = await setup();
    const plain = await env.app.request(
      "/api/auth/login",
      post({ email: "user@example.com", password: SEED_PASSWORD }),
    );
    const plainCookie = plain.headers.get("set-cookie") ?? "";
    expect(plainCookie).toMatch(/^adc_session=[A-Za-z0-9_-]+;/);
    expect(plainCookie).toContain("HttpOnly");
    expect(plainCookie).toContain("SameSite=Lax");
    expect(plainCookie).toContain("Path=/");
    expect(plainCookie).toContain(`Max-Age=${30 * 24 * 60 * 60}`);
    expect(plainCookie).not.toContain("Secure");

    const https = await env.app.request(
      "/api/auth/login",
      post({ email: "user@example.com", password: SEED_PASSWORD }, { "x-forwarded-proto": "https" }),
    );
    expect(https.headers.get("set-cookie")).toContain("Secure");

    const out = await env.app.request("/api/auth/logout", {
      method: "POST",
      headers: { cookie: env.cookie ?? "", "x-forwarded-proto": "https" },
    });
    expect(out.headers.get("set-cookie")).toContain("Secure");
    expect(out.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("активація за https теж ставить Secure", async () => {
    const env = await setup({}, { user: null });
    const token = await register(env, "secure@example.com");
    const act = await env.app.request(
      "/api/auth/activate",
      post({ token }, { "x-forwarded-proto": "https" }),
    );
    expect(act.headers.get("set-cookie")).toContain("Secure");
  });
});

describe("me / google", () => {
  it("me відображає поточний баланс", async () => {
    const env = await setup({}, { user: { credits: 7 } });
    const res = await env.request("/api/auth/me");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { balance: number }).balance).toBe(7);
  });

  it("google → 501 not_implemented", async () => {
    const env = await setup({}, { user: null });
    const res = await env.app.request("/api/auth/google", { method: "POST" });
    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({
      error: "not_implemented",
      message: "Вхід через Google ще не підключено.",
    });
  });
});
