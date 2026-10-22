import {
  type CostEvent,
  type CostStage,
  type IntakeFile,
  PROJECTS_DIR,
  type ProjectState,
  type PublicUser,
  projectPaths,
  type RunSource,
  sharedPaths,
} from "@adc/shared";
import { fixtureProject } from "@adc/shared/fixtures";
import { describe, expect, it, vi } from "vitest";
import {
  byModel,
  byStage,
  createUsageEngine,
  csvOf,
  projectsOf,
  SHARED_CSV_HOST,
  summaryOf,
  usersOf,
} from "../src/usage/engine.ts";
import { SNAPSHOT_TTL_MS, type UsageSnapshot } from "../src/usage/snapshot.ts";
import type { ProjectsQuery, UsageWindow } from "../src/usage/types.ts";
import { type Env, seedUser, setup } from "./helpers.ts";

/** B1 · Двигун вкладки «Використання»: правила таблиць `docs/usage-api.md` над справжнім `LocalStorage`. */

const OPUS = "claude-opus-5-5";
const SONNET = "claude-sonnet-5";
const CREDITS_PER_USD = 10;

type Units = CostEvent["units"];
const tokens = (input: number, output = 0, cacheWrite = 0, cacheWrite1h = 0, cacheRead = 0): Units => ({
  input,
  output,
  cacheWrite,
  cacheWrite1h,
  cacheRead,
});

interface EvInput {
  ts: string;
  usd: number;
  stage?: CostStage;
  phase?: CostEvent["phase"];
  rev?: number | null;
  source?: RunSource;
  provider?: CostEvent["provider"];
  model?: string;
  units?: Units;
}

/** Подія за зразком `stats.test.ts`; дефолт — Anthropic Opus, chat, first_delivery, rev 1. */
function ev(projectId: string | null, e: EvInput): CostEvent {
  return {
    ts: e.ts,
    projectId,
    rev: e.rev === undefined ? 1 : e.rev,
    stage: e.stage ?? "codegen",
    phase: e.phase ?? "first_delivery",
    source: e.source ?? "chat",
    provider: e.provider ?? "anthropic",
    model: e.model ?? OPUS,
    promptName: null,
    promptHash: null,
    effort: null,
    attempt: 1,
    units: e.units ?? tokens(10),
    unitPrices: {},
    usd: e.usd,
    exact: true,
    detail: null,
  };
}

const remotion = (e: EvInput): EvInput => ({
  stage: "render",
  provider: "remotion",
  model: "remotion",
  units: { renders: 1 },
  ...e,
});
const audio = (seconds: number, e: EvInput): EvInput => ({
  stage: "audio",
  provider: "elevenlabs",
  model: "music_v1",
  units: { seconds },
  ...e,
});

async function writeCosts(env: Env, projectId: string | null, events: CostEvent[]) {
  const key = projectId === null ? sharedPaths.costs : projectPaths(projectId).costs;
  // Битий рядок має пропускатись, як у `readCosts`.
  await env.storage.write(key, `${["{not json", ...events.map((e) => JSON.stringify(e))].join("\n")}\n`);
}

async function writeProject(env: Env, p: Partial<ProjectState> & { id: string }, events: CostEvent[]) {
  await env.storage.writeJson(projectPaths(p.id).project, fixtureProject({ status: "scripting", ...p }));
  await writeCosts(env, p.id, events);
}

interface Fixture {
  env: Env;
  clock: { now: Date };
  alice: PublicUser;
  bob: PublicUser;
  carol: PublicUser;
  engine: ReturnType<typeof createUsageEngine>;
}

/**
 * Фікстура:
 * - alice (створена 09-01): `pA1` (сайт alpha, здано 10-02), `pA2` — лише `intake.json` (beta);
 * - bob (09-15): `pB1` (manual, здано 09-25), `pEval` (лише eval-події, здано 10-04);
 * - carol (10-03): без проєктів;
 * - «Система»: `pX` (без власника, здано 10-03), `pGhost` (власника немає серед користувачів),
 *   `pBroken` (битий `project.json`), `costs-shared.jsonl`.
 * Леджери: списання/повернення в різні дні, бонуси й adjust (не рахуються).
 */
async function seed(): Promise<Fixture> {
  const clock = { now: new Date("2026-09-01T08:00:00.000Z") };
  const env = await setup({ now: () => clock.now }, { user: null });
  const at = (iso: string) => {
    clock.now = new Date(iso);
  };

  const alice = (await seedUser(env, { email: "alice@example.com", name: "Аліса", credits: 100 })).user;
  at("2026-09-15T08:00:00.000Z");
  const bob = (await seedUser(env, { email: "bob@example.com", name: "Боб", credits: 100 })).user;
  at("2026-10-03T08:00:00.000Z");
  const carol = (await seedUser(env, { email: "carol@example.com", name: "Керол" })).user;

  // Леджери.
  const charge = async (
    u: PublicUser,
    when: string,
    id: string,
    credits: number,
    kind = "charge" as const,
  ) => {
    at(when);
    await env.accounts.apply(u.id, { id, kind, credits });
  };
  await charge(alice, "2026-09-29T10:00:00.000Z", "video:old", -7); // поза вікном
  await charge(alice, "2026-10-01T10:00:00.000Z", "video:pA1", -30);
  await charge(alice, "2026-10-05T10:00:00.000Z", "revision:pA1:r2", -10);
  at("2026-10-06T10:00:00.000Z");
  await env.accounts.apply(alice.id, { id: "refund:pA1", kind: "refund", credits: 5 });
  await charge(bob, "2026-09-20T10:00:00.000Z", "video:pB1", -20); // поза вікном
  at("2026-10-03T10:00:00.000Z");
  await env.accounts.apply(bob.id, { id: "adjust:x", kind: "adjust", credits: -3 }); // не рахується
  await charge(bob, "2026-10-10T12:00:00.000Z", "revision:pB1:r2", -8); // останній день вікна

  // Проєкти.
  await writeProject(
    env,
    {
      id: "pA1",
      ownerId: alice.id,
      status: "delivered",
      createdAt: "2026-10-01T09:00:00.000Z",
      input: { kind: "site", url: "https://alpha.example.com/", manualText: null },
      firstDeliveredAt: "2026-10-02T12:00:00.000Z",
    },
    [
      ev("pA1", { ts: "2026-09-30T23:59:59.999Z", usd: 1, stage: "brandkit" }), // за мить до вікна
      ev("pA1", { ts: "2026-10-01T00:00:00.000Z", usd: 2, units: tokens(1000, 200, 30, 20, 400) }),
      ev("pA1", remotion({ ts: "2026-10-02T10:00:00.000Z", usd: 0.5 })),
      ev("pA1", {
        ts: "2026-10-05T10:00:00.000Z",
        usd: 0.3,
        stage: "revise",
        phase: "revision",
        rev: 2,
        model: SONNET,
        units: tokens(100, 50),
      }),
      ev("pA1", remotion({ ts: "2026-10-05T11:00:00.000Z", usd: 0.2, phase: "revision", rev: 2 })),
      ev("pA1", { ts: "2026-10-05T12:00:00.000Z", usd: 5, source: "eval" }),
    ],
  );
  const intake: IntakeFile = {
    projectId: "pA2",
    createdAt: "2026-10-04T09:00:00.000Z",
    origin: "chat",
    input: { kind: "site", url: "https://Beta.Example.com/landing", manualText: null },
    photos: [],
    ownerId: alice.id,
  };
  await env.storage.writeJson(projectPaths("pA2").intake, intake);
  await writeCosts(env, "pA2", [ev("pA2", audio(12.5, { ts: "2026-10-04T10:00:00.000Z", usd: 0.25 }))]);

  await writeProject(
    env,
    {
      id: "pB1",
      ownerId: bob.id,
      status: "revising",
      createdAt: "2026-09-20T09:00:00.000Z",
      input: { kind: "manual", url: null, manualText: "Кав'ярня" },
      firstDeliveredAt: "2026-09-25T12:00:00.000Z",
    },
    [
      ev("pB1", { ts: "2026-09-25T10:00:00.000Z", usd: 3 }),
      ev("pB1", { ts: "2026-10-10T23:59:59.999Z", usd: 0.4, stage: "revise", phase: "revision", rev: 2 }),
      ev("pB1", { ts: "2026-10-11T00:00:00.000Z", usd: 0.6, stage: "revise", phase: "revision", rev: 3 }),
    ],
  );
  await writeProject(
    env,
    {
      id: "pEval",
      ownerId: bob.id,
      status: "delivered",
      createdAt: "2026-10-03T09:00:00.000Z",
      input: { kind: "site", url: "https://evalsite.example.com/", manualText: null },
      firstDeliveredAt: "2026-10-04T12:00:00.000Z",
    },
    [ev("pEval", { ts: "2026-10-03T10:00:00.000Z", usd: 1.1, source: "eval" })],
  );
  await writeProject(
    env,
    {
      id: "pX",
      status: "delivered",
      createdAt: "2026-10-02T09:00:00.000Z",
      input: { kind: "site", url: "https://xeno.example.com/", manualText: null },
      firstDeliveredAt: "2026-10-03T12:00:00.000Z",
    },
    [
      ev("pX", { ts: "2026-10-03T10:00:00.000Z", usd: 0.7 }),
      ev("pX", { ts: "2026-10-03T11:00:00.000Z", usd: 0.1, source: "test" }),
    ],
  );
  await writeProject(
    env,
    {
      id: "pGhost",
      ownerId: "u_ghost_000",
      createdAt: "2026-10-03T09:00:00.000Z",
      input: { kind: "site", url: "https://ghost.example.com/", manualText: null },
    },
    [ev("pGhost", { ts: "2026-10-03T10:00:00.000Z", usd: 0.15 })],
  );
  await env.storage.write(projectPaths("pBroken").project, "{not json");
  await writeCosts(env, "pBroken", [ev("pBroken", { ts: "2026-10-03T10:00:00.000Z", usd: 0.05 })]);

  await writeCosts(env, null, [
    ev(null, audio(2, { ts: "2026-10-03T10:00:00.000Z", usd: 0.02, stage: "sfx-cache", rev: null })),
    ev(null, audio(3, { ts: "2026-08-01T10:00:00.000Z", usd: 0.03, stage: "sfx-cache", rev: null })),
  ]);

  at("2026-10-20T10:00:00.000Z");
  const engine = createUsageEngine({
    storage: env.storage,
    accounts: env.accounts,
    creditsPerUsd: CREDITS_PER_USD,
    now: () => clock.now,
  });
  return { env, clock, alice, bob, carol, engine };
}

const W: UsageWindow = { from: "2026-10-01", to: "2026-10-10", source: "chat" };
const ALL_TIME: UsageWindow = { from: null, to: null, source: "chat" };
const PQ: Omit<ProjectsQuery, keyof UsageWindow> = {
  owner: null,
  search: null,
  sort: "usd",
  order: "desc",
  page: 1,
  pageSize: 25,
};

const round = (x: number) => Math.round(x * 1e6) / 1e6;
const close = (a: number, b: number, groups = 1) =>
  expect(Math.abs(a - b)).toBeLessThanOrEqual(1e-6 * groups);

describe("usage engine — summary", () => {
  it("вікно (межі включно, дні UTC), source=chat, система, кредити й маржа", async () => {
    const { engine } = await seed();
    const s = await engine.summary(W);
    expect(s).toMatchObject({ from: "2026-10-01", to: "2026-10-10", source: "chat" });
    // pA1 3.0 + pA2 0.25 + pB1 0.4 + pX 0.7 + pGhost 0.15 + pBroken 0.05 + спільні 0.02.
    expect(s.totals).toEqual({
      calls: 10,
      tokens: { input: 1140, output: 250, cacheWrite: 50, cacheRead: 400, total: 1840 },
      audioSeconds: 14.5,
      renders: 2,
      usd: 4.57,
      users: 2,
      projects: 6,
      // pA1 (10-02) і pX (10-03); pB1 здано до вікна, pEval — лише eval-події.
      delivered: 2,
      // (pA1: 1 + 2 + 0.5, з подією до вікна; pX: 0.7) / 2.
      avgUsdPerDelivered: 2.1,
      // (pA1 r2: 0.3 + 0.2; pB1 r2: 0.4) / 2 різні (projectId, rev).
      avgUsdPerRevision: 0.45,
      // alice: 30 + 10 − 5; bob: 8 (останній день вікна). Бонус, adjust і списання до вікна — ні.
      creditsCharged: 43,
      creditsUsd: 4.3,
      // 4.3 − (alice 3.25 + bob 0.4).
      marginUsd: 0.65,
    });
    // pX + pGhost (власника немає серед користувачів) + pBroken (мета не читається) + спільні.
    expect(s.system).toEqual({
      calls: 4,
      tokens: { input: 30, output: 0, cacheWrite: 0, cacheRead: 0, total: 30 },
      audioSeconds: 2,
      renders: 0,
      usd: 0.92,
    });
    expect(s.byModel.map((m) => [m.provider, m.model, m.calls, m.usd])).toEqual([
      ["anthropic", OPUS, 5, 3.3],
      ["remotion", "remotion", 2, 0.7],
      ["anthropic", SONNET, 1, 0.3],
      ["elevenlabs", "music_v1", 2, 0.27],
    ]);
    expect(s.byModel[0]?.tokens).toEqual({
      input: 1040,
      output: 200,
      cacheWrite: 50,
      cacheRead: 400,
      total: 1690,
    });
    expect(s.byStage).toEqual([
      { stage: "codegen", calls: 4, usd: 2.9 },
      { stage: "render", calls: 2, usd: 0.7 },
      { stage: "revise", calls: 2, usd: 0.7 },
      { stage: "audio", calls: 1, usd: 0.25 },
      { stage: "sfx-cache", calls: 1, usd: 0.02 },
    ]);
  });

  it("лише from / лише to / без вікна", async () => {
    const { engine } = await seed();
    const fromOnly = await engine.summary({ ...W, to: null });
    // + pB1 0.6 (10-11).
    expect(fromOnly.totals.usd).toBe(5.17);
    const toOnly = await engine.summary({ ...W, from: null });
    // + pA1 1 (09-30), pB1 3 (09-25), спільні 0.03 (08-01).
    expect(toOnly.totals.usd).toBe(8.6);
    const all = await engine.summary(ALL_TIME);
    expect(all.totals.usd).toBe(9.2);
    // Без вікна — усі з firstDeliveredAt ≠ null і ≥1 chat-подією: pA1, pB1, pX.
    expect(all.totals.delivered).toBe(3);
    expect(all.totals.avgUsdPerDelivered).toBe(round((3.5 + 3 + 0.7) / 3));
    // Без вікна кредити — увесь леджер: alice 7 + 30 + 10 − 5, bob 20 + 8.
    expect(all.totals.creditsCharged).toBe(70);
  });

  it("source: eval → кредити null, delivered лише з eval-подіями; all — усе; test", async () => {
    const { engine } = await seed();
    const evalRes = await engine.summary({ ...ALL_TIME, source: "eval" });
    expect(evalRes.totals).toMatchObject({
      usd: 6.1,
      calls: 2,
      users: 2,
      projects: 2,
      // pA1 (є eval-подія) і pEval.
      delivered: 2,
      avgUsdPerDelivered: round((5 + 1.1) / 2),
      avgUsdPerRevision: null,
      creditsCharged: null,
      creditsUsd: null,
      marginUsd: null,
    });
    expect(evalRes.system.usd).toBe(0);
    const testRes = await engine.summary({ ...ALL_TIME, source: "test" });
    expect(testRes.totals).toMatchObject({ usd: 0.1, users: 0, projects: 1, creditsCharged: null });
    expect(testRes.system.usd).toBe(0.1);
    const all = await engine.summary({ ...ALL_TIME, source: "all" });
    expect(all.totals.usd).toBe(round(9.2 + 6.1 + 0.1));
    expect(all.totals.creditsCharged).toBe(70);
  });

  it("порожнє сховище — нулі, null лише там, де дозволено", async () => {
    const env = await setup({}, { user: null });
    const engine = createUsageEngine({ storage: env.storage, accounts: env.accounts, creditsPerUsd: 1 });
    const s = await engine.summary(W);
    expect(s.totals).toMatchObject({
      usd: 0,
      calls: 0,
      delivered: 0,
      avgUsdPerDelivered: null,
      avgUsdPerRevision: null,
      creditsCharged: 0,
      marginUsd: 0,
    });
    expect(s.byModel).toEqual([]);
    expect(s.byStage).toEqual([]);
  });
});

describe("usage engine — users", () => {
  it("усі користувачі (без подій — нулі), агрегати, кредити й маржа; Система не входить", async () => {
    const { engine, alice, bob, carol } = await seed();
    const res = await engine.users({ ...W, sort: "usd", order: "desc" });
    expect(res).toMatchObject({ from: "2026-10-01", to: "2026-10-10", source: "chat" });
    expect(res.users.map((u) => u.email)).toEqual([
      "alice@example.com",
      "bob@example.com",
      "carol@example.com",
    ]);
    const [a, b, c] = res.users;
    expect(a).toMatchObject({
      id: alice.id,
      name: "Аліса",
      createdAt: alice.createdAt,
      calls: 5,
      usd: 3.25,
      audioSeconds: 12.5,
      renders: 2,
      tokens: { input: 1100, output: 250, cacheWrite: 50, cacheRead: 400, total: 1800 },
      // pA2 лише з intake.json, але з ownerId — атрибутується alice.
      projects: 2,
      delivered: 1,
      creditsCharged: 35,
      marginUsd: 0.25,
    });
    expect(a?.byModel.map((m) => [m.model, m.usd])).toEqual([
      [OPUS, 2],
      ["remotion", 0.7],
      [SONNET, 0.3],
      ["music_v1", 0.25],
    ]);
    expect(b).toMatchObject({
      id: bob.id,
      usd: 0.4,
      projects: 1,
      delivered: 0,
      creditsCharged: 8,
      marginUsd: 0.4,
    });
    expect(c).toEqual({
      id: carol.id,
      email: "carol@example.com",
      name: "Керол",
      createdAt: carol.createdAt,
      calls: 0,
      tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0 },
      audioSeconds: 0,
      renders: 0,
      usd: 0,
      projects: 0,
      delivered: 0,
      creditsCharged: 0,
      marginUsd: 0,
      byModel: [],
    });
    expect(res.users.some((u) => u.id === "u_ghost_000")).toBe(false);
  });

  it("інваріант: summary.totals.usd = Σ users.usd + system.usd", async () => {
    const { engine } = await seed();
    for (const w of [
      W,
      ALL_TIME,
      { ...ALL_TIME, source: "eval" as const },
      { ...W, source: "all" as const },
    ]) {
      const s = await engine.summary(w);
      const u = await engine.users({ ...w, sort: "usd", order: "desc" });
      const sum = u.users.reduce((acc, r) => acc + r.usd, 0) + s.system.usd;
      close(s.totals.usd, sum, u.users.length + 1);
    }
  });

  it("сортування за кожним ключем, order, тайбрейкер email ↑", async () => {
    const { engine } = await seed();
    const emails = async (
      sort: "usd" | "email" | "projects" | "createdAt" | "marginUsd",
      order: "asc" | "desc",
    ) => (await engine.users({ ...W, sort, order })).users.map((u) => u.email[0]);
    expect(await emails("usd", "desc")).toEqual(["a", "b", "c"]);
    expect(await emails("usd", "asc")).toEqual(["c", "b", "a"]);
    expect(await emails("email", "desc")).toEqual(["c", "b", "a"]);
    expect(await emails("email", "asc")).toEqual(["a", "b", "c"]);
    expect(await emails("projects", "desc")).toEqual(["a", "b", "c"]);
    expect(await emails("createdAt", "desc")).toEqual(["c", "b", "a"]);
    expect(await emails("createdAt", "asc")).toEqual(["a", "b", "c"]);
    // marginUsd: bob 0.4 > alice 0.25 > carol 0.
    expect(await emails("marginUsd", "desc")).toEqual(["b", "a", "c"]);
    expect(await emails("marginUsd", "asc")).toEqual(["c", "a", "b"]);
    // Рівні usd = 0 (source=test, у користувачів подій немає) — тайбрейкер email ↑ за будь-якого order.
    const tie = await engine.users({ ...W, source: "test", sort: "usd", order: "desc" });
    expect(tie.users.map((u) => u.email[0])).toEqual(["a", "b", "c"]);
    const tieAsc = await engine.users({ ...W, source: "test", sort: "usd", order: "asc" });
    expect(tieAsc.users.map((u) => u.email[0])).toEqual(["a", "b", "c"]);
  });

  it("source=eval: creditsCharged/marginUsd null; null при сортуванні по marginUsd — у кінці, далі email", async () => {
    const { engine } = await seed();
    for (const order of ["asc", "desc"] as const) {
      const res = await engine.users({ ...ALL_TIME, source: "eval", sort: "marginUsd", order });
      expect(res.users.map((u) => u.email[0])).toEqual(["a", "b", "c"]);
      for (const u of res.users) expect(u).toMatchObject({ creditsCharged: null, marginUsd: null });
    }
  });
});

describe("usage engine — projects", () => {
  it("склад вибірки, мета (intake-only, manual, битий файл, неіснуючий власник), поля рядка", async () => {
    const { engine, alice, bob } = await seed();
    const res = await engine.projects({ ...W, ...PQ });
    expect(res).toMatchObject({ owner: null, from: "2026-10-01", to: "2026-10-10", source: "chat" });
    expect(res?.page).toBe(1);
    expect(res?.pageSize).toBe(25);
    // pEval — лише eval-події, не у вибірці.
    expect(res?.items.map((p) => p.projectId)).toEqual(["pA1", "pX", "pB1", "pA2", "pGhost", "pBroken"]);
    expect(res?.total).toBe(6);
    const byId = Object.fromEntries((res?.items ?? []).map((p) => [p.projectId, p]));
    expect(byId.pA1).toMatchObject({
      ownerId: alice.id,
      ownerEmail: "alice@example.com",
      host: "alpha.example.com",
      url: "https://alpha.example.com/",
      status: "delivered",
      createdAt: "2026-10-01T09:00:00.000Z",
      firstDeliveredAt: "2026-10-02T12:00:00.000Z",
      calls: 4,
      usd: 3,
      revisions: 1,
      firstDeliveryUsd: 2.5,
      revisionUsd: 0.5,
    });
    expect(byId.pA1?.byStage).toEqual([
      { stage: "codegen", calls: 1, usd: 2 },
      { stage: "render", calls: 2, usd: 0.7 },
      { stage: "revise", calls: 1, usd: 0.3 },
    ]);
    expect(byId.pA1?.byModel.map((m) => m.model)).toEqual([OPUS, "remotion", SONNET]);
    expect(byId.pA2).toMatchObject({
      ownerId: alice.id,
      status: "intake",
      host: "beta.example.com",
      url: "https://Beta.Example.com/landing",
      createdAt: "2026-10-04T09:00:00.000Z",
      firstDeliveredAt: null,
      audioSeconds: 12.5,
    });
    expect(byId.pB1).toMatchObject({
      ownerId: bob.id,
      host: null,
      url: null,
      revisions: 1,
      revisionUsd: 0.4,
    });
    expect(byId.pGhost).toMatchObject({ ownerId: null, ownerEmail: null, host: "ghost.example.com" });
    expect(byId.pBroken).toMatchObject({
      ownerId: null,
      ownerEmail: null,
      host: null,
      url: null,
      status: null,
      createdAt: null,
      firstDeliveredAt: null,
      usd: 0.05,
      calls: 1,
    });
    // Спільні витрати — не проєкт.
    expect(res?.totals.usd).toBe(4.55);
  });

  it("owner: null / none / id / невідомий id → null", async () => {
    const { engine, alice, bob, carol } = await seed();
    const ids = async (owner: string | null) =>
      (await engine.projects({ ...W, ...PQ, owner }))?.items.map((p) => p.projectId);
    expect(await ids("none")).toEqual(["pX", "pGhost", "pBroken"]);
    expect(await ids(alice.id)).toEqual(["pA1", "pA2"]);
    expect(await ids(bob.id)).toEqual(["pB1"]);
    expect(await ids(carol.id)).toEqual([]);
    expect(await engine.projects({ ...W, ...PQ, owner: "u_ghost_000" })).toBeNull();
    const none = await engine.projects({ ...W, ...PQ, owner: "none" });
    expect(none?.owner).toBe("none");
    expect(none?.totals.usd).toBe(0.9);
  });

  it("search: без регістру по host, url, projectId; ownerEmail — лише без owner; порожній не фільтрує", async () => {
    const { engine, alice } = await seed();
    const ids = async (search: string | null, owner: string | null = null) =>
      (await engine.projects({ ...W, ...PQ, owner, search }))?.items.map((p) => p.projectId);
    expect(await ids("ALPHA")).toEqual(["pA1"]);
    expect(await ids("/landing")).toEqual(["pA2"]);
    expect(await ids("pbro")).toEqual(["pBroken"]);
    expect(await ids("Alice@")).toEqual(["pA1", "pA2"]);
    expect(await ids("alice@", alice.id)).toEqual([]);
    expect(await ids("beta", alice.id)).toEqual(["pA2"]);
    expect(await ids("")).toHaveLength(6);
    expect(await ids("   ")).toHaveLength(6);
    expect(await ids("nothing-matches")).toEqual([]);
    const filtered = await engine.projects({ ...W, ...PQ, search: "alice" });
    expect(filtered?.total).toBe(2);
    expect(filtered?.totals.usd).toBe(3.25);
  });

  it("сортування: кожен ключ, null — у кінці незалежно від order", async () => {
    const { engine } = await seed();
    const ids = async (sort: ProjectsQuery["sort"], order: ProjectsQuery["order"]) =>
      (await engine.projects({ ...W, ...PQ, sort, order }))?.items.map((p) => p.projectId);
    expect(await ids("usd", "asc")).toEqual(["pBroken", "pGhost", "pA2", "pB1", "pX", "pA1"]);
    expect(await ids("calls", "desc")).toEqual(["pA1", "pA2", "pGhost", "pX", "pB1", "pBroken"]);
    expect(await ids("tokens", "desc")).toEqual(["pA1", "pGhost", "pX", "pB1", "pBroken", "pA2"]);
    expect(await ids("createdAt", "desc")).toEqual(["pA2", "pGhost", "pX", "pA1", "pB1", "pBroken"]);
    expect(await ids("createdAt", "asc")).toEqual(["pB1", "pA1", "pX", "pGhost", "pA2", "pBroken"]);
    expect(await ids("host", "asc")).toEqual(["pA1", "pA2", "pGhost", "pX", "pB1", "pBroken"]);
    expect(await ids("host", "desc")).toEqual(["pX", "pGhost", "pA2", "pA1", "pB1", "pBroken"]);
    // pA1 і pX — обидва delivered: тайбрейкер createdAt ↓ (pX створено пізніше).
    expect(await ids("status", "asc")).toEqual(["pX", "pA1", "pA2", "pB1", "pGhost", "pBroken"]);
    expect(await ids("ownerEmail", "asc")).toEqual(["pA2", "pA1", "pB1", "pGhost", "pX", "pBroken"]);
    expect(await ids("ownerEmail", "desc")).toEqual(["pB1", "pA2", "pA1", "pGhost", "pX", "pBroken"]);
  });

  it("пагінація: total правильний, за межами — items: [], Σ items.usd по сторінках = totals.usd", async () => {
    const { engine } = await seed();
    let sum = 0;
    const seen: string[] = [];
    for (let page = 1; page <= 3; page++) {
      const res = await engine.projects({ ...W, ...PQ, page, pageSize: 2 });
      expect(res?.total).toBe(6);
      expect(res?.items).toHaveLength(2);
      for (const p of res?.items ?? []) {
        sum += p.usd;
        seen.push(p.projectId);
      }
    }
    expect(new Set(seen).size).toBe(6);
    const full = await engine.projects({ ...W, ...PQ });
    close(sum, full?.totals.usd ?? Number.NaN, 6);
    const beyond = await engine.projects({ ...W, ...PQ, page: 4, pageSize: 2 });
    expect(beyond).toMatchObject({ page: 4, pageSize: 2, total: 6, items: [] });
    expect(beyond?.totals.usd).toBe(full?.totals.usd);
  });
});

describe("usage engine — csv", () => {
  it("без owner: вибірка за usd ↓ і останній рядок спільних витрат", async () => {
    const { engine } = await seed();
    const rows = (await engine.csv({ ...W, owner: null, search: null })) ?? [];
    expect(rows.map((r) => r.projectId)).toEqual(["pA1", "pX", "pB1", "pA2", "pGhost", "pBroken", null]);
    expect(rows[0]).toEqual({
      ownerEmail: "alice@example.com",
      projectId: "pA1",
      host: "alpha.example.com",
      status: "delivered",
      createdAt: "2026-10-01T09:00:00.000Z",
      firstDeliveredAt: "2026-10-02T12:00:00.000Z",
      calls: 4,
      tokensInput: 1100,
      tokensOutput: 250,
      tokensCacheWrite: 50,
      tokensCacheRead: 400,
      audioSeconds: 0,
      renders: 2,
      usd: 3,
      firstDeliveryUsd: 2.5,
      revisionUsd: 0.5,
    });
    expect(rows.at(-1)).toEqual({
      ownerEmail: null,
      projectId: null,
      host: SHARED_CSV_HOST,
      status: null,
      createdAt: null,
      firstDeliveredAt: null,
      calls: 1,
      tokensInput: 0,
      tokensOutput: 0,
      tokensCacheWrite: 0,
      tokensCacheRead: 0,
      audioSeconds: 2,
      renders: 0,
      usd: 0.02,
      firstDeliveryUsd: 0.02,
      revisionUsd: 0,
    });
    // Σ рядків = summary.totals.usd.
    const s = await engine.summary(W);
    close(
      rows.reduce((acc, r) => acc + r.usd, 0),
      s.totals.usd,
      rows.length,
    );
  });

  it("рядок спільних витрат — завжди без owner (нульовий і з search); з owner — немає; невідомий owner → null", async () => {
    const { engine, alice } = await seed();
    const searched = (await engine.csv({ ...W, owner: null, search: "alpha" })) ?? [];
    expect(searched.map((r) => r.projectId)).toEqual(["pA1", null]);
    const empty = (await engine.csv({ ...W, source: "eval", owner: null, search: null })) ?? [];
    expect(empty.at(-1)).toMatchObject({ projectId: null, host: SHARED_CSV_HOST, calls: 0, usd: 0 });
    const own = (await engine.csv({ ...W, owner: alice.id, search: null })) ?? [];
    expect(own.map((r) => r.projectId)).toEqual(["pA1", "pA2"]);
    const none = (await engine.csv({ ...W, owner: "none", search: null })) ?? [];
    expect(none.map((r) => r.projectId)).toEqual(["pX", "pGhost", "pBroken"]);
    expect(await engine.csv({ ...W, owner: "u_ghost_000", search: null })).toBeNull();
  });
});

describe("usage engine — знімок", () => {
  it("другий виклик у межах TTL не читає сховище; після TTL — читає знову", async () => {
    const { env, clock, engine } = await seed();
    const spy = vi.spyOn(env.storage, "listDirs");
    await engine.summary(W);
    const first = spy.mock.calls.length;
    expect(spy.mock.calls.filter(([p]) => p === PROJECTS_DIR)).toHaveLength(1);
    spy.mockClear();
    clock.now = new Date(clock.now.getTime() + SNAPSHOT_TTL_MS - 1);
    await engine.users({ ...W, sort: "usd", order: "desc" });
    await engine.projects({ ...W, ...PQ });
    await engine.csv({ ...W, owner: null, search: null });
    expect(spy).not.toHaveBeenCalled();
    clock.now = new Date(clock.now.getTime() + 1);
    await engine.summary(W);
    expect(spy.mock.calls.length).toBe(first);
  });

  it("знімок не залежить від параметрів і оновлюється після TTL", async () => {
    const { env, clock, engine } = await seed();
    const before = await engine.summary(ALL_TIME);
    await writeCosts(env, "pNew", [ev("pNew", { ts: "2026-10-03T10:00:00.000Z", usd: 1 })]);
    expect((await engine.summary(W)).totals.projects).toBe(6);
    clock.now = new Date(clock.now.getTime() + SNAPSHOT_TTL_MS);
    const after = await engine.summary(ALL_TIME);
    expect(after.totals.usd).toBe(round(before.totals.usd + 1));
    // pNew без мети: гроші — «Системі», поля мети — null.
    const row = (await engine.projects({ ...ALL_TIME, ...PQ, search: "pnew" }))?.items[0];
    expect(row).toMatchObject({ projectId: "pNew", status: null, ownerId: null, usd: 1 });
  });

  it("паралельні виклики під час збору чекають один проміс", async () => {
    const { env, engine } = await seed();
    const spy = vi.spyOn(env.storage, "listDirs");
    const [s, u, p, c] = await Promise.all([
      engine.summary(W),
      engine.users({ ...W, sort: "usd", order: "desc" }),
      engine.projects({ ...W, ...PQ }),
      engine.csv({ ...W, owner: null, search: null }),
    ]);
    expect(spy.mock.calls.filter(([prefix]) => prefix === PROJECTS_DIR)).toHaveLength(1);
    expect(s.totals.projects).toBe(p?.total);
    expect(u.users).toHaveLength(3);
    expect(c).toHaveLength(7);
  });

  it("невдалий збір не кешується", async () => {
    const { env, engine } = await seed();
    const spy = vi.spyOn(env.storage, "listDirs").mockRejectedValueOnce(new Error("диск"));
    await expect(engine.summary(W)).rejects.toThrow("диск");
    expect((await engine.summary(W)).totals.usd).toBe(4.57);
    expect(spy.mock.calls.filter(([p]) => p === PROJECTS_DIR)).toHaveLength(2);
  });
});

describe("usage engine — чисті функції", () => {
  it("byModel: usd ↓, provider ↑, model ↑; byStage: usd ↓, stage ↑; округлення до 6 знаків", () => {
    const ts = "2026-10-03T10:00:00.000Z";
    const events = [
      ev("p", { ts, usd: 0.1, model: "b" }),
      ev("p", { ts, usd: 0.1, model: "a" }),
      ev("p", remotion({ ts, usd: 0.1 })),
      ev("p", { ts, usd: 0.2, model: "a" }),
      ev("p", audio(1, { ts, usd: 0.1 })),
    ];
    expect(byModel(events).map((m) => [m.provider, m.model, m.usd])).toEqual([
      ["anthropic", "a", 0.3],
      ["anthropic", "b", 0.1],
      ["elevenlabs", "music_v1", 0.1],
      ["remotion", "remotion", 0.1],
    ]);
    expect(byStage(events)).toEqual([
      { stage: "codegen", calls: 3, usd: 0.4 },
      { stage: "audio", calls: 1, usd: 0.1 },
      { stage: "render", calls: 1, usd: 0.1 },
    ]);
    // 0.1 + 0.2 у плаваючій комі — 0.30000000000000004.
    expect(byModel(events)[0]?.usd).toBe(0.3);
  });

  it("тайбрейкер проєктів: createdAt ↓, далі projectId ↑", () => {
    const meta = (createdAt: string) => ({
      ownerId: null,
      status: "delivered" as const,
      url: null,
      host: null,
      createdAt,
      firstDeliveredAt: null,
    });
    const ts = "2026-10-03T10:00:00.000Z";
    const snap: UsageSnapshot = {
      projects: [
        { id: "b", meta: meta("2026-10-01T00:00:00.000Z"), events: [ev("b", { ts, usd: 1 })] },
        { id: "a", meta: meta("2026-10-01T00:00:00.000Z"), events: [ev("a", { ts, usd: 1 })] },
        { id: "c", meta: meta("2026-10-02T00:00:00.000Z"), events: [ev("c", { ts, usd: 1 })] },
        { id: "d", meta: null, events: [ev("d", { ts, usd: 1 })] },
      ],
      shared: [],
      users: [],
      ledgers: new Map(),
    };
    for (const order of ["asc", "desc"] as const) {
      const res = projectsOf(snap, { ...ALL_TIME, ...PQ, order });
      expect(res?.items.map((p) => p.projectId)).toEqual(["c", "a", "b", "d"]);
    }
    expect(csvOf(snap, { ...ALL_TIME, owner: null, search: null })?.map((r) => r.projectId)).toEqual([
      "c",
      "a",
      "b",
      "d",
      null,
    ]);
    expect(summaryOf(snap, ALL_TIME, 1).totals).toMatchObject({ users: 0, projects: 4, usd: 4 });
    expect(usersOf(snap, { ...ALL_TIME, sort: "usd", order: "desc" }, 1).users).toEqual([]);
  });
});
