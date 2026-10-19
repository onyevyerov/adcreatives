import { InsufficientCreditsError, readOutbox, UserId } from "@adc/shared";
import { Hono } from "hono";
import { nanoid } from "nanoid";
import { z } from "zod";
import type { ApiDeps } from "../deps.ts";
import { type AppEnv, requireAdmin, requireUser, toPublic } from "../session.ts";
import {
  invalidBody,
  notFound,
  parseLimit,
  readJson,
  TRANSACTIONS_MAX_LIMIT,
  transactionsPage,
} from "./account.ts";

const OUTBOX_DEFAULT_LIMIT = 50;
const OUTBOX_MAX_LIMIT = 200;

const CreditsBody = z.object({
  credits: z
    .number()
    .int()
    .refine((n) => n !== 0),
  note: z.string().max(200).default(""),
});

const USER_NOT_FOUND = "Користувача не знайдено.";

/** `/api/admin`. Адмін: користувачі, ручне нарахування, dev-outbox. */
export function adminRoutes(deps: ApiDeps): Hono<AppEnv> {
  const { accounts, storage, config } = deps;
  const app = new Hono<AppEnv>();
  app.use("*", requireUser(), requireAdmin());

  /** Користувач за `:id` (невалідний id — теж null → 404). */
  const findUser = async (id: string) => (UserId.safeParse(id).success ? accounts.getUser(id) : null);

  app.get("/users", async (c) => {
    const users = (await accounts.listUsers()).sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    );
    const rows = await Promise.all(
      users.map(async (u) => ({ ...toPublic(u, config.adminEmails), balance: await accounts.balance(u.id) })),
    );
    return c.json({ users: rows });
  });

  app.get("/users/:id", async (c) => {
    const user = await findUser(c.req.param("id"));
    if (!user) return notFound(c, USER_NOT_FOUND);
    return c.json({ user: toPublic(user, config.adminEmails), balance: await accounts.balance(user.id) });
  });

  app.post("/users/:id/credits", async (c) => {
    const admin = c.get("user");
    if (!admin) throw new Error("requireUser пропустив аноніма");
    const user = await findUser(c.req.param("id"));
    if (!user) return notFound(c, USER_NOT_FOUND);
    const parsed = CreditsBody.safeParse(await readJson(c));
    if (!parsed.success) return invalidBody(c, "credits — ціле число ≠ 0; note — до 200 символів.");
    const { credits, note } = parsed.data;
    try {
      const { entry } = await accounts.apply(user.id, {
        id: `adjust:${nanoid()}`,
        kind: "adjust",
        credits,
        ref: { byUserId: admin.id },
        note,
      });
      return c.json({ entry, balance: await accounts.balance(user.id) });
    } catch (err) {
      if (!(err instanceof InsufficientCreditsError)) throw err;
      return c.json(
        {
          error: "insufficient_credits",
          message: `Баланс не може стати від'ємним: списання ${err.required}, на балансі ${err.available}.`,
          required: err.required,
          available: err.available,
        },
        402,
      );
    }
  });

  app.get("/users/:id/transactions", async (c) => {
    const user = await findUser(c.req.param("id"));
    if (!user) return notFound(c, USER_NOT_FOUND);
    const page = await transactionsPage(accounts, user.id, {
      limit: c.req.query("limit"),
      before: c.req.query("before"),
    });
    if (!page) return invalidBody(c, `limit — ціле від 1 до ${TRANSACTIONS_MAX_LIMIT}.`);
    return c.json(page);
  });

  app.get("/outbox", async (c) => {
    const limit = parseLimit(c.req.query("limit"), OUTBOX_DEFAULT_LIMIT, OUTBOX_MAX_LIMIT);
    if (limit === null) return invalidBody(c, `limit — ціле від 1 до ${OUTBOX_MAX_LIMIT}.`);
    return c.json({ mails: await readOutbox(storage, limit) });
  });

  return app;
}
