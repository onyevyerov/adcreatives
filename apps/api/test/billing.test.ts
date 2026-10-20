import { defaultCredits, type TopUp } from "@adc/shared";
import { describe, expect, it } from "vitest";
import { basic, json, NOW, seedUser, setup } from "./helpers.ts";

type Created = { topup: TopUp; checkoutUrl: string };

/** Годинник, що зсувається на 1 с при кожному виклику — щоб «новіші першими» було перевірним. */
function ticking() {
  let t = NOW.getTime();
  return () => {
    t += 1000;
    return new Date(t);
  };
}

describe("/api/billing — доступ", () => {
  it("анонім → 401 на поповненнях", async () => {
    const env = await setup({}, { user: null });
    const calls: [string, RequestInit?][] = [
      ["/api/billing/topups", json({ packageId: "starter" })],
      ["/api/billing/topups"],
      ["/api/billing/topups/t_x"],
      ["/api/billing/topups/t_x/confirm", json({ outcome: "paid" })],
    ];
    for (const [path, init] of calls) {
      const res = await env.request(path, init);
      expect(res.status, path).toBe(401);
      expect(((await res.json()) as { error: string }).error).toBe("unauthorized");
    }
  });
});

describe("пакети", () => {
  it("GET /packages → {creditsPerUsd, prices, packages, custom}", async () => {
    const env = await setup();
    const res = await env.request("/api/billing/packages");
    expect(res.status).toBe(200);
    const { creditsPerUsd, prices, packages, custom } = env.config.credits;
    expect(await res.json()).toEqual({ creditsPerUsd, prices, packages, custom });
  });

  it("GET /packages публічний: анонім → 200 з цінами", async () => {
    const env = await setup({}, { user: null });
    const res = await env.request("/api/billing/packages");
    expect(res.status).toBe(200);
    const { creditsPerUsd, prices, packages, custom } = env.config.credits;
    expect(await res.json()).toEqual({ creditsPerUsd, prices, packages, custom });
  });

  it("GET /packages за командним паролем: без Basic → 401 гейту, з Basic → 200", async () => {
    const env = await setup({ appPassword: "s3cret" }, { user: null });
    expect((await env.request("/api/billing/packages")).status).toBe(401);
    const res = await env.request("/api/billing/packages", { headers: { Authorization: basic("s3cret") } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { prices: unknown }).prices).toEqual(env.config.credits.prices);
    // Поповнення під тим самим гейтом без сесії — як і раніше 401 unauthorized.
    const topups = await env.request("/api/billing/topups", { headers: { Authorization: basic("s3cret") } });
    expect(topups.status).toBe(401);
    expect(((await topups.json()) as { error: string }).error).toBe("unauthorized");
  });
});

describe("створення поповнення", () => {
  it("пакет → 201 {topup pending, checkoutUrl}", async () => {
    const env = await setup();
    const res = await env.request("/api/billing/topups", json({ packageId: "standard" }));
    expect(res.status).toBe(201);
    const { topup, checkoutUrl } = (await res.json()) as Created;
    expect(topup).toMatchObject({
      userId: env.user?.id,
      packageId: "standard",
      credits: 25,
      priceUsd: 25,
      status: "pending",
      paidAt: null,
    });
    expect(checkoutUrl).toBe(`${env.config.appUrl}/?checkout=${topup.id}`);
    expect(await env.accounts.getTopUp(env.user?.id ?? "", topup.id)).toEqual(topup);
    // Створення нічого не нараховує.
    expect(await env.accounts.balance(env.user?.id ?? "")).toBe(0);
  });

  it("custom → packageId custom, priceUsd = credits / creditsPerUsd", async () => {
    const env = await setup({ credits: defaultCredits({ creditsPerUsd: 2 }) });
    const res = await env.request("/api/billing/topups", json({ credits: 7 }));
    expect(res.status).toBe(201);
    const { topup } = (await res.json()) as Created;
    expect(topup).toMatchObject({ packageId: "custom", credits: 7, priceUsd: 3.5, status: "pending" });

    for (const credits of [5, 500]) {
      expect((await env.request("/api/billing/topups", json({ credits }))).status).toBe(201);
    }
  });

  it("custom поза межами, нецілий, невідомий пакет, обидва поля, порожнє → 400 invalid_body", async () => {
    const env = await setup();
    const bodies: unknown[] = [
      { credits: 4 },
      { credits: 501 },
      { credits: 7.5 },
      { credits: "10" },
      { credits: 0 },
      { credits: -10 },
      { packageId: "nope" },
      { packageId: "" },
      { packageId: "starter", credits: 10 },
      {},
      null,
    ];
    for (const body of bodies) {
      const res = await env.request("/api/billing/topups", json(body));
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("invalid_body");
    }
    expect(await env.accounts.listTopUps(env.user?.id ?? "")).toEqual([]);
  });
});

describe("список і перегляд", () => {
  it("GET /topups → лише свої, новіші першими; GET /topups/:id — свій 200, чужий/неіснуючий 404", async () => {
    const env = await setup({ now: ticking() });
    const other = await seedUser(env, { email: "other@example.com" });
    const a = (
      (await (await env.request("/api/billing/topups", json({ packageId: "starter" }))).json()) as Created
    ).topup;
    const b = ((await (await env.request("/api/billing/topups", json({ credits: 9 }))).json()) as Created)
      .topup;
    const foreign = (
      (await (await other.request("/api/billing/topups", json({ packageId: "pro" }))).json()) as Created
    ).topup;

    const list = (await (await env.request("/api/billing/topups")).json()) as { topups: TopUp[] };
    expect(list.topups.map((t) => t.id)).toEqual([b.id, a.id]);

    const own = await env.request(`/api/billing/topups/${a.id}`);
    expect(own.status).toBe(200);
    expect(await own.json()).toEqual({ topup: a });

    for (const id of [foreign.id, "t_missing", "..%2F..%2Fx"]) {
      const res = await env.request(`/api/billing/topups/${id}`);
      expect(res.status, id).toBe(404);
      expect(((await res.json()) as { error: string }).error).toBe("not_found");
    }
  });
});

describe("підтвердження (заглушка оплати)", () => {
  async function created(env: Awaited<ReturnType<typeof setup>>, body: unknown = { packageId: "starter" }) {
    return ((await (await env.request("/api/billing/topups", json(body))).json()) as Created).topup;
  }

  it("paid двічі → один topup:<id> у леджері, баланс +credits один раз", async () => {
    const env = await setup({}, { user: { credits: 3 } });
    const uid = env.user?.id ?? "";
    const topup = await created(env);
    const first = await env.request(`/api/billing/topups/${topup.id}/confirm`, json({ outcome: "paid" }));
    expect(first.status).toBe(200);
    const body1 = (await first.json()) as { topup: TopUp; balance: number };
    expect(body1.topup).toMatchObject({ id: topup.id, status: "paid" });
    expect(body1.topup.paidAt).not.toBeNull();
    expect(body1.balance).toBe(13);

    const second = await env.request(`/api/billing/topups/${topup.id}/confirm`, json({ outcome: "paid" }));
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(body1);

    const ledger = await env.accounts.readLedger(uid);
    expect(ledger.filter((e) => e.id === `topup:${topup.id}`)).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      kind: "topup",
      credits: 10,
      balanceAfter: 13,
      ref: { topupId: topup.id },
    });
    expect(await env.accounts.balance(uid)).toBe(13);

    // failed після paid — no-op.
    const flip = await env.request(`/api/billing/topups/${topup.id}/confirm`, json({ outcome: "failed" }));
    expect(await flip.json()).toEqual(body1);
  });

  it("failed → баланс без змін, статус failed; paid після failed — no-op", async () => {
    const env = await setup();
    const uid = env.user?.id ?? "";
    const topup = await created(env, { credits: 20 });
    const res = await env.request(`/api/billing/topups/${topup.id}/confirm`, json({ outcome: "failed" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { topup: TopUp; balance: number };
    expect(body.topup).toMatchObject({ status: "failed", paidAt: null });
    expect(body.balance).toBe(0);

    const flip = await env.request(`/api/billing/topups/${topup.id}/confirm`, json({ outcome: "paid" }));
    expect(await flip.json()).toEqual(body);
    expect(await env.accounts.readLedger(uid)).toEqual([]);
  });

  it("чужий → 404, його стан не змінюється; неіснуючий → 404; невалідний outcome → 400", async () => {
    const env = await setup();
    const other = await seedUser(env, { email: "other@example.com" });
    const foreign = await created({ ...env, request: other.request });

    const res = await env.request(`/api/billing/topups/${foreign.id}/confirm`, json({ outcome: "paid" }));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("not_found");
    expect((await env.accounts.getTopUp(other.user.id, foreign.id))?.status).toBe("pending");
    expect(await env.accounts.balance(other.user.id)).toBe(0);
    expect(await env.accounts.balance(env.user?.id ?? "")).toBe(0);

    expect(
      (await env.request("/api/billing/topups/t_missing/confirm", json({ outcome: "paid" }))).status,
    ).toBe(404);

    const own = await created(env);
    for (const body of [{ outcome: "maybe" }, {}, null]) {
      const bad = await env.request(`/api/billing/topups/${own.id}/confirm`, json(body));
      expect(bad.status).toBe(400);
      expect(((await bad.json()) as { error: string }).error).toBe("invalid_body");
    }
    expect((await env.accounts.getTopUp(env.user?.id ?? "", own.id))?.status).toBe("pending");
  });
});
