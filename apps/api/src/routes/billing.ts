import { type Context, Hono } from "hono";
import { nanoid } from "nanoid";
import { z } from "zod";
import type { ApiDeps } from "../deps.ts";
import { type AppEnv, requireUser } from "../session.ts";
import { invalidBody, notFound, readJson } from "./account.ts";

/** Тіло поповнення: пакет **або** довільна кількість кредитів (не обидва). */
const TopUpBody = z.union([
  z.object({ packageId: z.string().min(1).max(64) }).strict(),
  z.object({ credits: z.number() }).strict(),
]);

const ConfirmBody = z.object({ outcome: z.enum(["paid", "failed"]) });

const TOPUP_NOT_FOUND = "Поповнення не знайдено.";

/** `/api/billing`. Пакети й поповнення (заглушка оплати). */
export function billingRoutes(deps: ApiDeps): Hono<AppEnv> {
  const { accounts, payments, config } = deps;
  const app = new Hono<AppEnv>();

  // Публічний: гість на старті бачить ціни. Зареєстровано до requireUser — Hono віддає відповідь
  // тут і не доходить до middleware нижче; усі наступні маршрути — лише з сесією.
  app.get("/packages", (c) => {
    const { creditsPerUsd, prices, packages, custom } = config.credits;
    return c.json({ creditsPerUsd, prices, packages, custom });
  });

  app.use("*", requireUser());

  const userId = (c: Context<AppEnv>) => {
    const user = c.get("user");
    if (!user) throw new Error("requireUser пропустив аноніма");
    return user.id;
  };

  app.post("/topups", async (c) => {
    const uid = userId(c);
    const parsed = TopUpBody.safeParse(await readJson(c));
    if (!parsed.success) return invalidBody(c, "Оберіть пакет або вкажіть кількість кредитів.");
    const { packages, custom, creditsPerUsd } = config.credits;
    let packageId: string;
    let credits: number;
    let priceUsd: number;
    const body = parsed.data;
    if ("packageId" in body) {
      const pkg = packages.find((p) => p.id === body.packageId);
      if (!pkg) return invalidBody(c, "Невідомий пакет.");
      packageId = pkg.id;
      credits = pkg.credits;
      priceUsd = pkg.priceUsd;
    } else {
      credits = body.credits;
      if (!Number.isInteger(credits) || credits < custom.min || credits > custom.max)
        return invalidBody(c, `Кількість кредитів — ціле число від ${custom.min} до ${custom.max}.`);
      packageId = "custom";
      priceUsd = credits / creditsPerUsd;
    }
    const topup = await accounts.createTopUp({
      id: `t_${nanoid()}`,
      userId: uid,
      packageId,
      credits,
      priceUsd,
    });
    const { checkoutUrl } = await payments.createCheckout(topup);
    return c.json({ topup, checkoutUrl }, 201);
  });

  app.get("/topups", async (c) => c.json({ topups: await accounts.listTopUps(userId(c)) }));

  app.get("/topups/:id", async (c) => {
    const topup = await accounts.getTopUp(userId(c), c.req.param("id"));
    if (!topup) return notFound(c, TOPUP_NOT_FOUND);
    return c.json({ topup });
  });

  app.post("/topups/:id/confirm", async (c) => {
    const uid = userId(c);
    const id = c.req.param("id");
    // Чужий і неіснуючий — однаково 404 (getTopUp шукає лише в теці власника).
    if (!(await accounts.getTopUp(uid, id))) return notFound(c, TOPUP_NOT_FOUND);
    const parsed = ConfirmBody.safeParse(await readJson(c));
    if (!parsed.success) return invalidBody(c, "outcome — paid або failed.");
    // Ідемпотентно: повтор (або протилежний outcome після settle) повертає наявний стан.
    const topup = await accounts.settleTopUp(uid, id, parsed.data.outcome);
    return c.json({ topup, balance: await accounts.balance(uid) });
  });

  return app;
}
