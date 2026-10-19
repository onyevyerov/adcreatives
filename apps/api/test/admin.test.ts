import type { LedgerEntry, OutboxMail, PublicUser } from "@adc/shared";
import { describe, expect, it } from "vitest";
import { json, NOW, seedUser, setup } from "./helpers.ts";

type UserRow = PublicUser & { balance: number };

/** Годинник, що зсувається на 1 с при кожному виклику. */
function ticking() {
  let t = NOW.getTime();
  return () => {
    t += 1000;
    return new Date(t);
  };
}

/** Оточення: звичайний користувач за замовчуванням + admin. */
async function withAdmin(overrides: Parameters<typeof setup>[0] = {}) {
  const env = await setup(overrides, { user: { credits: 4 } });
  const admin = await seedUser(env, { email: "boss@example.com", name: "Бос", admin: true });
  return { env, admin, uid: env.user?.id ?? "" };
}

describe("/api/admin — доступ", () => {
  const paths: [string, RequestInit?][] = [
    ["/api/admin/users"],
    ["/api/admin/users/u_whatever1"],
    ["/api/admin/users/u_whatever1/credits", json({ credits: 5 })],
    ["/api/admin/users/u_whatever1/transactions"],
    ["/api/admin/outbox"],
  ];

  it("анонім → 401, не-admin → 403", async () => {
    const env = await setup();
    for (const [path, init] of paths) {
      const anon = await env.app.request(path, init);
      expect(anon.status, path).toBe(401);
      expect(((await anon.json()) as { error: string }).error).toBe("unauthorized");
      const user = await env.request(path, init);
      expect(user.status, path).toBe(403);
      expect(await user.json()).toEqual({ error: "forbidden", message: "Лише для адміністратора." });
    }
  });
});

describe("користувачі", () => {
  it("GET /users → PublicUser + balance, за createdAt, без passwordHash", async () => {
    const env = await setup({ now: ticking() }, { user: { email: "first@example.com", credits: 4 } });
    const admin = await seedUser(env, { email: "boss@example.com", admin: true });
    const third = await seedUser(env, { email: "third@example.com", activated: false });

    const res = await admin.request("/api/admin/users");
    expect(res.status).toBe(200);
    const { users } = (await res.json()) as { users: UserRow[] };
    expect(users.map((u) => u.email)).toEqual(["first@example.com", "boss@example.com", "third@example.com"]);
    expect(users[0]).toEqual({ ...env.user, balance: 4 });
    expect(users[1]).toMatchObject({ id: admin.user.id, isAdmin: true, balance: 0 });
    expect(users[2]).toMatchObject({ id: third.user.id, activatedAt: null, isAdmin: false });
    for (const u of users) expect(u).not.toHaveProperty("passwordHash");
  });

  it("GET /users/:id → {user, balance}; неіснуючий/невалідний → 404", async () => {
    const { env, admin, uid } = await withAdmin();
    const res = await admin.request(`/api/admin/users/${uid}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: env.user, balance: 4 });

    for (const id of ["u_missing00", "bad"]) {
      const miss = await admin.request(`/api/admin/users/${id}`);
      expect(miss.status, id).toBe(404);
      expect(((await miss.json()) as { error: string }).error).toBe("not_found");
    }
  });
});

describe("ручне нарахування", () => {
  type Adjusted = { entry: LedgerEntry; balance: number };

  it("додає й віднімає: запис adjust:<id> з byUserId і note", async () => {
    const { env, admin, uid } = await withAdmin();
    const add = await admin.request(`/api/admin/users/${uid}/credits`, json({ credits: 20, note: "Тест" }));
    expect(add.status).toBe(200);
    const added = (await add.json()) as Adjusted;
    expect(added.balance).toBe(24);
    expect(added.entry).toMatchObject({
      userId: uid,
      kind: "adjust",
      credits: 20,
      balanceAfter: 24,
      ref: { byUserId: admin.user.id },
      note: "Тест",
    });
    expect(added.entry.id).toMatch(/^adjust:[A-Za-z0-9_-]+$/);

    const sub = await admin.request(`/api/admin/users/${uid}/credits`, json({ credits: -24 }));
    expect(sub.status).toBe(200);
    const subbed = (await sub.json()) as Adjusted;
    expect(subbed).toMatchObject({ balance: 0, entry: { credits: -24, balanceAfter: 0, note: "" } });
    expect(subbed.entry.id).not.toBe(added.entry.id);
    expect(await env.accounts.balance(uid)).toBe(0);
  });

  it("від'ємне нижче нуля → 402 insufficient_credits з required/available, баланс без змін", async () => {
    const { env, admin, uid } = await withAdmin();
    const res = await admin.request(`/api/admin/users/${uid}/credits`, json({ credits: -5 }));
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ error: "insufficient_credits", required: 5, available: 4 });
    expect(await env.accounts.balance(uid)).toBe(4);
    expect(await env.accounts.readLedger(uid)).toHaveLength(1);
  });

  it("credits 0 / нецілий / рядок, note > 200 → 400; неіснуючий користувач → 404", async () => {
    const { env, admin, uid } = await withAdmin();
    for (const body of [
      { credits: 0 },
      { credits: 1.5 },
      { credits: "5" },
      {},
      { credits: 5, note: "x".repeat(201) },
    ]) {
      const res = await admin.request(`/api/admin/users/${uid}/credits`, json(body));
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("invalid_body");
    }
    expect(await env.accounts.balance(uid)).toBe(4);
    const miss = await admin.request("/api/admin/users/u_missing00/credits", json({ credits: 5 }));
    expect(miss.status).toBe(404);
  });
});

describe("транзакції користувача", () => {
  it("пагінуються як у кабінеті; неіснуючий → 404", async () => {
    const { env, admin, uid } = await withAdmin();
    for (let i = 0; i < 9; i++)
      await env.accounts.apply(uid, { id: `adjust:a${i}`, kind: "adjust", credits: 1 });
    type Page = { entries: LedgerEntry[]; nextBefore: string | null };
    const p1 = (await (await admin.request(`/api/admin/users/${uid}/transactions?limit=6`)).json()) as Page;
    expect(p1.entries.map((e) => e.id)).toEqual(
      ["a8", "a7", "a6", "a5", "a4", "a3"].map((s) => `adjust:${s}`),
    );
    expect(p1.nextBefore).toBe("adjust:a3");
    const p2 = (await (
      await admin.request(`/api/admin/users/${uid}/transactions?limit=6&before=${p1.nextBefore}`)
    ).json()) as Page;
    expect(p2.entries.map((e) => e.id)).toEqual(["adjust:a2", "adjust:a1", "adjust:a0", `bonus:seed:${uid}`]);
    expect(p2.nextBefore).toBeNull();

    expect((await admin.request(`/api/admin/users/${uid}/transactions?limit=0`)).status).toBe(400);
    expect((await admin.request("/api/admin/users/u_missing00/transactions")).status).toBe(404);
  });
});

describe("outbox", () => {
  it("повертає листи з link, новіші першими; limit", async () => {
    const { env, admin } = await withAdmin({ now: ticking() });
    const mailer = env.mailer;
    // Мейлер оточення створено з config.now — кожен лист має свою мітку часу.
    await mailer.send({
      to: "a@example.com",
      kind: "activate",
      subject: "Активація акаунта AdCreative",
      text: "перший",
      link: `${env.config.appUrl}/?auth=activate&token=one`,
    });
    await mailer.send({
      to: "b@example.com",
      kind: "reset",
      subject: "Скидання пароля AdCreative",
      text: "другий",
      link: `${env.config.appUrl}/?auth=reset&token=two`,
    });

    const res = await admin.request("/api/admin/outbox");
    expect(res.status).toBe(200);
    const { mails } = (await res.json()) as { mails: OutboxMail[] };
    expect(mails.map((m) => m.to)).toEqual(["b@example.com", "a@example.com"]);
    expect(mails[1]).toMatchObject({
      kind: "activate",
      link: "http://localhost:3000/?auth=activate&token=one",
    });

    const one = (await (await admin.request("/api/admin/outbox?limit=1")).json()) as { mails: OutboxMail[] };
    expect(one.mails.map((m) => m.to)).toEqual(["b@example.com"]);
    expect((await admin.request("/api/admin/outbox?limit=999")).status).toBe(400);
  });
});
