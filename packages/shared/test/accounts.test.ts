import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import RedisMock from "ioredis-mock";
import { beforeEach, describe, expect, it } from "vitest";
import {
  type AccountStore,
  accountPaths,
  CreditsConfig,
  createAccountStore,
  createOutboxMailer,
  createSessionStore,
  createStubPayment,
  createTokenStore,
  DUMMY_PASSWORD_HASH,
  defaultCredits,
  EmailTakenError,
  emailHash,
  hashPassword,
  InsufficientCreditsError,
  LedgerEntry,
  loadCredits,
  OutboxMail,
  readOutbox,
  verifyPassword,
} from "../src/accounts/index.ts";
import { fixtureProject } from "../src/fixtures.ts";
import { createMemoryLock } from "../src/lock.ts";
import type { Logger, LogMeta } from "../src/logger.ts";
import { LocalStorage } from "../src/storage/local.ts";

const NOW = new Date("2026-10-19T10:00:00.000Z");

function makeStore(): { store: AccountStore; storage: LocalStorage } {
  const storage = new LocalStorage(mkdtempSync(path.join(tmpdir(), "adc-accounts-")));
  let seq = 0;
  const store = createAccountStore({
    storage,
    lock: createMemoryLock(),
    now: () => NOW,
    idGen: () => `u_test${String(++seq).padStart(4, "0")}`,
  });
  return { store, storage };
}

async function seed(store: AccountStore, credits = 0) {
  const user = await store.createUser({ email: "olena@example.com", name: "Олена", password: "password123" });
  if (credits) await store.apply(user.id, { id: `bonus:seed:${user.id}`, kind: "bonus", credits });
  return user;
}

describe("AccountStore: користувачі", () => {
  it("дубль e-mail (інший регістр і пробіли) → EmailTakenError; findByEmail нормалізує", async () => {
    const { store } = makeStore();
    const user = await store.createUser({
      email: "Olena@Example.com",
      name: "Олена",
      password: "password123",
    });
    expect(user.email).toBe("olena@example.com");
    expect(user.activatedAt).toBeNull();
    await expect(
      store.createUser({ email: "  OLENA@example.COM ", name: "Інша", password: "password456" }),
    ).rejects.toBeInstanceOf(EmailTakenError);
    expect((await store.findByEmail(" OLENA@EXAMPLE.COM"))?.id).toBe(user.id);
    expect(await store.findByEmail("nobody@example.com")).toBeNull();
    expect(await store.findByEmail("не e-mail")).toBeNull();
    expect(await store.listUsers()).toHaveLength(1);
  });

  it("паралельна реєстрація того самого e-mail створює рівно одного користувача", async () => {
    const { store } = makeStore();
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        store.createUser({ email: "same@example.com", name: "X", password: "password123" }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await store.listUsers()).toHaveLength(1);
  });

  it("updateUser змінює дозволені поля; getUser з невалідним id → null", async () => {
    const { store } = makeStore();
    const user = await seed(store);
    const updated = await store.updateUser(user.id, { name: "Олена К.", activatedAt: NOW.toISOString() });
    expect(updated).toMatchObject({ id: user.id, email: user.email, name: "Олена К." });
    expect((await store.getUser(user.id))?.activatedAt).toBe(NOW.toISOString());
    expect(await store.getUser("../etc")).toBeNull();
    expect(await verifyPassword("password123", updated.passwordHash)).toBe(true);
  });
});

describe("AccountStore: леджер", () => {
  it("ідемпотентний apply: другий виклик → applied: false, той самий запис, один рядок у файлі", async () => {
    const { store, storage } = makeStore();
    const user = await seed(store, 20);
    const input = {
      id: "video:p1",
      kind: "charge" as const,
      credits: -10,
      ref: { projectId: "p1" },
      note: "Відео",
    };
    const first = await store.apply(user.id, input);
    const second = await store.apply(user.id, input);
    expect(first.applied).toBe(true);
    expect(first.entry).toMatchObject({ balanceAfter: 10, at: NOW.toISOString(), userId: user.id });
    expect(second).toEqual({ entry: first.entry, applied: false });
    const lines = (await storage.readText(accountPaths.ledger(user.id))).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(LedgerEntry.parse(JSON.parse(lines[1] ?? ""))).toEqual(first.entry);
    expect(await store.balance(user.id)).toBe(10);
  });

  it("InsufficientCreditsError з required/available; запис не додається", async () => {
    const { store } = makeStore();
    const user = await seed(store, 5);
    const err = await store
      .apply(user.id, { id: "video:p1", kind: "charge", credits: -10 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InsufficientCreditsError);
    expect(err).toMatchObject({ required: 10, available: 5 });
    expect(await store.balance(user.id)).toBe(5);
    expect(await store.readLedger(user.id)).toHaveLength(1);
  });

  it("20 паралельних apply(-1) при балансі 10 → рівно 10 успішних, баланс 0", async () => {
    const { store } = makeStore();
    const user = await seed(store, 10);
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) =>
        store.apply(user.id, { id: `c:${i}`, kind: "charge", credits: -1 }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(10);
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected).toHaveLength(10);
    for (const r of rejected) expect(r.reason).toBeInstanceOf(InsufficientCreditsError);
    expect(await store.balance(user.id)).toBe(0);
  });

  it("биті рядки пропускаються; readLedger({limit, before}) пагінує новіші першими", async () => {
    const { store, storage } = makeStore();
    const user = await seed(store);
    for (let i = 1; i <= 5; i++)
      await store.apply(user.id, { id: `adjust:${i}`, kind: "adjust", credits: i });
    await storage.append(accountPaths.ledger(user.id), "{не json");
    expect(await store.balance(user.id)).toBe(15);
    const page1 = await store.readLedger(user.id, { limit: 2 });
    expect(page1.map((e) => e.id)).toEqual(["adjust:5", "adjust:4"]);
    const page2 = await store.readLedger(user.id, { limit: 2, before: "adjust:4" });
    expect(page2.map((e) => e.id)).toEqual(["adjust:3", "adjust:2"]);
    const page3 = await store.readLedger(user.id, { limit: 2, before: "adjust:2" });
    expect(page3.map((e) => e.id)).toEqual(["adjust:1"]);
    expect(await store.readLedger(user.id, { before: "unknown" })).toEqual([]);
  });

  it("індекс проєктів: новіші першими, без дублів", async () => {
    const { store } = makeStore();
    const user = await seed(store);
    await store.addProject(user.id, "p1", "2026-10-19T10:00:00.000Z");
    await store.addProject(user.id, "p2", "2026-10-19T11:00:00.000Z");
    expect(await store.listProjectIds(user.id)).toEqual(["p2", "p1"]);
    expect(await store.listProjectIds("u_nobody01")).toEqual([]);
  });
});

describe("AccountStore: поповнення", () => {
  it("settleTopUp('paid') двічі → один запис topup:<id>, баланс +credits один раз", async () => {
    const { store } = makeStore();
    const user = await seed(store);
    const topup = await store.createTopUp({
      id: "t_1",
      userId: user.id,
      packageId: "starter",
      credits: 10,
      priceUsd: 10,
    });
    expect(topup).toMatchObject({ status: "pending", paidAt: null, createdAt: NOW.toISOString() });
    const [a, b] = await Promise.all([
      store.settleTopUp(user.id, "t_1", "paid"),
      store.settleTopUp(user.id, "t_1", "paid"),
    ]);
    expect(a.status).toBe("paid");
    expect(b).toEqual(a);
    const ledger = await store.readLedger(user.id);
    expect(ledger.filter((e) => e.id === "topup:t_1")).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ kind: "topup", credits: 10, ref: { topupId: "t_1" } });
    expect(await store.balance(user.id)).toBe(10);
    // paid → failed: стан не змінюється.
    expect((await store.settleTopUp(user.id, "t_1", "failed")).status).toBe("paid");
  });

  it("settleTopUp після failed не стає paid; чужий топап не видно", async () => {
    const { store } = makeStore();
    const user = await seed(store);
    const other = await store.createUser({
      email: "other@example.com",
      name: "Інший",
      password: "password123",
    });
    await store.createTopUp({ id: "t_2", userId: user.id, packageId: "custom", credits: 7, priceUsd: 7 });
    expect((await store.settleTopUp(user.id, "t_2", "failed")).status).toBe("failed");
    const again = await store.settleTopUp(user.id, "t_2", "paid");
    expect(again).toMatchObject({ status: "failed", paidAt: null });
    expect(await store.balance(user.id)).toBe(0);
    expect(await store.getTopUp(other.id, "t_2")).toBeNull();
    expect(await store.getTopUp(user.id, "../x")).toBeNull();
    await expect(store.settleTopUp(other.id, "t_2", "paid")).rejects.toThrow();
    expect((await store.listTopUps(user.id)).map((t) => t.id)).toEqual(["t_2"]);
    expect(await store.listTopUps(other.id)).toEqual([]);
  });
});

describe("паролі", () => {
  it("hashPassword/verifyPassword: вірний, невірний, зіпсований рядок", async () => {
    const hash = await hashPassword("correct horse");
    expect(hash).toMatch(/^scrypt\$16384\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
    expect(await hashPassword("correct horse")).not.toBe(hash);
    expect(await verifyPassword("correct horse", hash)).toBe(true);
    expect(await verifyPassword("wrong horse", hash)).toBe(false);
    for (const broken of ["", "plain", "scrypt$1$2$3", hash.replace("scrypt", "bcrypt"), `${hash}$x`])
      expect(await verifyPassword("correct horse", broken)).toBe(false);
    expect(await verifyPassword("correct horse", hash.replace("$16384$", "$999999999$"))).toBe(false);
    expect(await verifyPassword("anything", DUMMY_PASSWORD_HASH)).toBe(false);
  });
});

describe("outbox, оплата, кредити", () => {
  it("createOutboxMailer пише файл за схемою OutboxMail і рядок у лог; readOutbox — новіші першими", async () => {
    const storage = new LocalStorage(mkdtempSync(path.join(tmpdir(), "adc-outbox-")));
    const logged: Array<{ msg: string; meta?: LogMeta }> = [];
    const logger = {
      info: (msg: string, meta?: LogMeta) => logged.push({ msg, meta }),
    } as unknown as Logger;
    let tick = 0;
    const mailer = createOutboxMailer({
      storage,
      logger,
      now: () => {
        tick += 1;
        return new Date(NOW.getTime() + tick * 1000);
      },
    });
    const link = "http://localhost:3000/?auth=activate&token=abc";
    const sent = await mailer.send({
      to: "olena@example.com",
      kind: "activate",
      subject: "S",
      text: "T",
      link,
    });
    await mailer.send({ to: "olena@example.com", kind: "reset", subject: "S2", text: "T2", link });
    const keys = await storage.list(accountPaths.outboxDir);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(/^outbox\/2026-10-19T10-00-01-000Z-[0-9a-f]+\.json$/);
    expect(OutboxMail.parse(await storage.readJson(keys[0] ?? ""))).toEqual(sent);
    expect(logged[0]).toEqual({
      msg: "лист в outbox",
      meta: { to: "olena@example.com", kind: "activate", link },
    });
    const mails = await readOutbox(storage);
    expect(mails.map((m) => m.kind)).toEqual(["reset", "activate"]);
    expect(await readOutbox(storage, 1)).toHaveLength(1);
  });

  it("createStubPayment повертає локальний checkout URL", async () => {
    const pay = createStubPayment("http://localhost:3000/");
    const { checkoutUrl } = await pay.createCheckout({
      id: "t_1",
      userId: "u_test0001",
      packageId: "starter",
      credits: 10,
      priceUsd: 10,
      status: "pending",
      createdAt: NOW.toISOString(),
      paidAt: null,
    });
    expect(checkoutUrl).toBe("http://localhost:3000/?checkout=t_1");
  });

  it("loadCredits() читає config/credits.json; defaultCredits збігається з ним; битий файл падає", () => {
    const credits = loadCredits();
    expect(credits).toEqual(defaultCredits());
    expect(credits.prices).toEqual({ video: 10, revision: 3, extraFormat: 2 });
    expect(defaultCredits({ signupBonus: 5 }).signupBonus).toBe(5);
    const bad = path.join(mkdtempSync(path.join(tmpdir(), "adc-credits-")), "credits.json");
    writeFileSync(bad, JSON.stringify({ ...credits, packages: [] }));
    expect(() => loadCredits(bad)).toThrow();
    expect(CreditsConfig.safeParse({ ...credits, currency: "usd" }).success).toBe(false);
  });

  it("emailHash нормалізує адресу", () => {
    expect(emailHash(" A@Example.com ")).toBe(emailHash("a@example.com"));
    expect(() => emailHash("не e-mail")).toThrow();
  });
});

describe("сесії й токени (Redis)", () => {
  const redis = new RedisMock();
  beforeEach(async () => {
    await redis.flushall();
  });

  it("сесія: create → resolve; у Redis лише хеш токена; destroy і destroyAll", async () => {
    const sessions = createSessionStore(redis as never, { ttlMs: 60_000 });
    const a = await sessions.create("u_test0001");
    const b = await sessions.create("u_test0001");
    const c = await sessions.create("u_test0002");
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await sessions.resolve(a)).toBe("u_test0001");
    expect((await redis.keys("*")).some((k) => k.includes(a))).toBe(false);
    await sessions.destroy(a);
    expect(await sessions.resolve(a)).toBeNull();
    expect(await sessions.resolve(b)).toBe("u_test0001");
    await sessions.destroyAll("u_test0001");
    expect(await sessions.resolve(b)).toBeNull();
    expect(await sessions.resolve(c)).toBe("u_test0002");
    expect(await sessions.resolve("unknown")).toBeNull();
    expect(await sessions.resolve("")).toBeNull();
  });

  it("сесія з ковзним TTL: resolve продовжує строк", async () => {
    const sessions = createSessionStore(redis as never, { ttlMs: 60_000 });
    const token = await sessions.create("u_test0001");
    const [key] = await redis.keys("session:*");
    await redis.pexpire(key ?? "", 1_000);
    await sessions.resolve(token);
    expect(await redis.pttl(key ?? "")).toBeGreaterThan(1_000);
  });

  it("токен одноразовий і прив'язаний до kind", async () => {
    const tokens = createTokenStore(redis as never);
    const t = await tokens.issue("activate", "u_test0001", 60_000);
    expect(await tokens.consume("reset", t)).toBeNull();
    expect(await tokens.consume("activate", t)).toBe("u_test0001");
    expect(await tokens.consume("activate", t)).toBeNull();
  });
});

describe("сумісність", () => {
  it("fixtureProject() без ownerId", () => {
    expect(fixtureProject().ownerId).toBeUndefined();
    expect(fixtureProject({ ownerId: "u_test0001" }).ownerId).toBe("u_test0001");
  });
});
