import {
  DUMMY_PASSWORD_HASH,
  Email,
  EmailTakenError,
  hashPassword,
  noopLogger,
  PASSWORD_MAX,
  PASSWORD_MIN,
  type TokenKind,
  type User,
  verifyPassword,
} from "@adc/shared";
import { type Context, Hono } from "hono";
import { getCookie } from "hono/cookie";
import { z } from "zod";
import type { ApiDeps, ApiError } from "../deps.ts";
import { clientIp, createRateLimiter } from "../ratelimit.ts";
import {
  type AppEnv,
  clearSessionCookie,
  requireUser,
  SESSION_COOKIE,
  setSessionCookie,
  toPublic,
} from "../session.ts";

/** Ліміт auth-спроб: 10 за 15 хвилин на `ip|email`. */
export const AUTH_RATE_MAX = 10;
export const AUTH_RATE_WINDOW_MS = 15 * 60_000;
/** TTL одноразових токенів. */
export const ACTIVATE_TOKEN_TTL_MS = 24 * 60 * 60_000;
export const RESET_TOKEN_TTL_MS = 60 * 60_000;

export const REGISTER_ACCEPTED = "Якщо адреса вільна, ми надіслали лист для активації.";
export const RESEND_ACCEPTED = "Якщо акаунт очікує активації, ми надіслали лист ще раз.";
export const FORGOT_ACCEPTED = "Якщо акаунт існує, ми надіслали лист для скидання пароля.";

const Name = z.string().trim().min(1).max(80);
/** Пароль на вході: довжину перевіряємо окремо (→ `weak_password`), тут — лише тип і грубу межу. */
const AnyPassword = z.string().max(4096);
const Token = z.string().min(1).max(256);
const StrongPassword = z.string().min(PASSWORD_MIN).max(PASSWORD_MAX);

const RegisterBody = z.object({ email: Email, name: Name, password: AnyPassword });
const EmailBody = z.object({ email: Email });
const LoginBody = z.object({ email: Email, password: AnyPassword });
const ActivateBody = z.object({ token: Token });
const ResetBody = z.object({ token: Token, password: AnyPassword });

type Ctx = Context<AppEnv>;

const fail = (c: Ctx, status: 400 | 401 | 403 | 429 | 501, error: string, message: string) =>
  c.json<ApiError>({ error, message }, status);

const invalidBody = (c: Ctx) => fail(c, 400, "invalid_body", "Некоректні дані запиту.");
const weakPassword = (c: Ctx) =>
  fail(c, 400, "weak_password", `Пароль — від ${PASSWORD_MIN} до ${PASSWORD_MAX} символів.`);
const invalidToken = (c: Ctx) => fail(c, 400, "invalid_token", "Посилання недійсне або застаріло.");

/** Тіло запиту за схемою; невалідний JSON або схема → null. */
async function readBody<T>(c: Ctx, schema: z.ZodType<T>): Promise<T | null> {
  const raw: unknown = await c.req.json().catch(() => undefined);
  const r = schema.safeParse(raw);
  return r.success ? r.data : null;
}

/** Назва сервісу в листах (на фронті — `BRAND_NAME` з contracts.js). */
const BRAND_NAME = "Crealab";

const MAIL = {
  activate: {
    subject: `Активація акаунта ${BRAND_NAME}`,
    ttlMs: ACTIVATE_TOKEN_TTL_MS,
    text: (name: string, link: string) =>
      `Вітаємо, ${name}!\n\nЩоб активувати акаунт ${BRAND_NAME}, відкрийте посилання:\n${link}\n\n` +
      "Посилання дійсне 24 години. Якщо ви не реєструвалися — просто проігноруйте цей лист.",
  },
  reset: {
    subject: `Скидання пароля ${BRAND_NAME}`,
    ttlMs: RESET_TOKEN_TTL_MS,
    text: (name: string, link: string) =>
      `Вітаємо, ${name}!\n\nЩоб задати новий пароль для ${BRAND_NAME}, відкрийте посилання:\n${link}\n\n` +
      "Посилання дійсне 1 годину. Якщо ви не просили скинути пароль — просто проігноруйте цей лист.",
  },
} as const satisfies Record<TokenKind, unknown>;

/** `/api/auth`: реєстрація, активація, вхід/вихід, скидання пароля, поточний користувач. */
export function authRoutes(deps: ApiDeps): Hono<AppEnv> {
  const logger = deps.logger ?? noopLogger;
  const app = new Hono<AppEnv>();
  const limiter = createRateLimiter({
    max: AUTH_RATE_MAX,
    windowMs: AUTH_RATE_WINDOW_MS,
    now: () => deps.config.now(),
  });

  /** `true` — ліміт вичерпано для `ip|email`. */
  const limited = (c: Ctx, email: string) =>
    limiter.hit(`${clientIp(c.req.header("x-forwarded-for"))}|${email}`);
  const rateLimited = (c: Ctx) => fail(c, 429, "rate_limited", "Забагато спроб. Спробуйте за 15 хвилин.");

  /** Новий одноразовий токен + лист із посиланням `${appUrl}/?auth=<kind>&token=…`. */
  async function sendTokenMail(kind: TokenKind, user: User): Promise<void> {
    const spec = MAIL[kind];
    const token = await deps.tokens.issue(kind, user.id, spec.ttlMs);
    const link = `${deps.config.appUrl}/?auth=${kind}&token=${encodeURIComponent(token)}`;
    await deps.mailer.send({
      to: user.email,
      kind,
      subject: spec.subject,
      text: spec.text(user.name, link),
      link,
    });
  }

  /** Нова сесія + cookie; тіло `{user, balance}`. */
  async function signIn(c: Ctx, user: User) {
    setSessionCookie(c, await deps.sessions.create(user.id));
    return c.json({
      user: toPublic(user, deps.config.adminEmails),
      balance: await deps.accounts.balance(user.id),
    });
  }

  app.post("/register", async (c) => {
    const body = await readBody(c, RegisterBody);
    if (!body) return invalidBody(c);
    if (limited(c, body.email)) return rateLimited(c);
    if (!StrongPassword.safeParse(body.password).success) return weakPassword(c);

    let existing = await deps.accounts.findByEmail(body.email);
    if (!existing) {
      try {
        const user = await deps.accounts.createUser(body);
        await sendTokenMail("activate", user);
      } catch (err) {
        // Гонка двох реєстрацій: інший запит щойно створив акаунт — відповідаємо так само.
        if (!(err instanceof EmailTakenError)) throw err;
        existing = await deps.accounts.findByEmail(body.email);
      }
    } else {
      // Вирівнюємо час відповіді з гілкою createUser (там scrypt-хеш пароля).
      await verifyPassword(body.password, DUMMY_PASSWORD_HASH);
    }
    // Зайнятий і не активований — перевипуск токена; активований — нічого не шлемо.
    if (existing && existing.activatedAt === null) await sendTokenMail("activate", existing);
    return c.json({ message: REGISTER_ACCEPTED }, 202);
  });

  app.post("/activate", async (c) => {
    const body = await readBody(c, ActivateBody);
    if (!body) return invalidBody(c);
    const userId = await deps.tokens.consume("activate", body.token);
    let user = userId ? await deps.accounts.getUser(userId) : null;
    if (!user) return invalidToken(c);
    if (user.activatedAt === null)
      user = await deps.accounts.updateUser(user.id, { activatedAt: deps.config.now().toISOString() });
    const bonus = deps.config.credits.signupBonus;
    if (bonus > 0) {
      // Ідемпотентно: ключ один на користувача, повторна активація не нараховує вдруге.
      await deps.accounts.apply(user.id, {
        id: `bonus:signup:${user.id}`,
        kind: "bonus",
        credits: bonus,
        note: "Вітальний бонус",
      });
    }
    logger.info("акаунт активовано", { userId: user.id });
    return signIn(c, user);
  });

  app.post("/resend", async (c) => {
    const body = await readBody(c, EmailBody);
    if (!body) return invalidBody(c);
    if (limited(c, body.email)) return rateLimited(c);
    const user = await deps.accounts.findByEmail(body.email);
    if (user && user.activatedAt === null) await sendTokenMail("activate", user);
    return c.json({ message: RESEND_ACCEPTED }, 202);
  });

  app.post("/login", async (c) => {
    const body = await readBody(c, LoginBody);
    if (!body) return invalidBody(c);
    if (limited(c, body.email)) return rateLimited(c);
    const user = await deps.accounts.findByEmail(body.email);
    // scrypt виконується завжди — час відповіді не видає, чи існує акаунт.
    const ok = await verifyPassword(body.password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);
    if (!user || !ok) return fail(c, 401, "invalid_credentials", "Невірний e-mail або пароль.");
    if (user.activatedAt === null)
      return fail(c, 403, "not_activated", "Акаунт ще не активовано — перевірте пошту.");
    return signIn(c, user);
  });

  app.post("/logout", async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) await deps.sessions.destroy(token);
    clearSessionCookie(c);
    return c.body(null, 204);
  });

  app.post("/forgot", async (c) => {
    const body = await readBody(c, EmailBody);
    if (!body) return invalidBody(c);
    if (limited(c, body.email)) return rateLimited(c);
    const user = await deps.accounts.findByEmail(body.email);
    if (user && user.activatedAt !== null) await sendTokenMail("reset", user);
    return c.json({ message: FORGOT_ACCEPTED }, 202);
  });

  app.post("/reset", async (c) => {
    const body = await readBody(c, ResetBody);
    if (!body) return invalidBody(c);
    // Довжину пароля — до consume, щоб слабкий пароль не «спалював» посилання.
    if (!StrongPassword.safeParse(body.password).success) return weakPassword(c);
    const userId = await deps.tokens.consume("reset", body.token);
    const found = userId ? await deps.accounts.getUser(userId) : null;
    if (!found) return invalidToken(c);
    const user = await deps.accounts.updateUser(found.id, {
      passwordHash: await hashPassword(body.password),
    });
    // Зміна пароля інвалідує всі сесії, включно з тими, що могли бути в зловмисника.
    await deps.sessions.destroyAll(user.id);
    logger.info("пароль скинуто", { userId: user.id });
    return signIn(c, user);
  });

  app.get("/me", requireUser(), async (c) => {
    const user = c.get("user");
    if (!user) return fail(c, 401, "unauthorized", "Потрібно увійти.");
    const { prices, packages, custom, creditsPerUsd } = deps.config.credits;
    return c.json({
      user,
      balance: await deps.accounts.balance(user.id),
      prices,
      packages,
      custom,
      creditsPerUsd,
    });
  });

  app.post("/google", (c) => fail(c, 501, "not_implemented", "Вхід через Google ще не підключено."));

  return app;
}
