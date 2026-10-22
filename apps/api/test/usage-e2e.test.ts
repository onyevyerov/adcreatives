import { type CostEvent, projectPaths, sharedPaths } from "@adc/shared";
import { fixtureProject } from "@adc/shared/fixtures";
import { describe, expect, it } from "vitest";
import type { UsageProjectsResponse, UsageSummaryResponse, UsageUsersResponse } from "../src/usage/types.ts";
import { type Env, seedUser, setup } from "./helpers.ts";

/**
 * Інтеграція вкладки «Використання»: справжній двигун через справжні роути. Інваріанти:
 * підсумок = користувачі + «Система»; проєкти (усі сторінки) + спільні = підсумок; CSV — `total + 1`
 * рядків; вікно, що відсікає частину подій, зменшує всі три відповіді узгоджено.
 */

const EPS = 1e-6;

type EventInput = Partial<CostEvent> & Pick<CostEvent, "ts" | "usd">;

function event(projectId: string | null, e: EventInput): CostEvent {
  return {
    projectId,
    rev: 1,
    stage: "brandkit",
    phase: "first_delivery",
    source: "chat",
    provider: "anthropic",
    model: "claude-opus-5-5",
    promptName: null,
    promptHash: null,
    effort: null,
    attempt: 1,
    units: { input: 1000, output: 200, cacheWrite: 10, cacheWrite1h: 5, cacheRead: 300 },
    unitPrices: {},
    exact: true,
    detail: null,
    ...e,
  };
}

const writeCosts = (env: Env, key: string, events: CostEvent[]) =>
  env.storage.write(key, `${events.map((e) => JSON.stringify(e)).join("\n")}\n`);

/** Адмін + 2 клієнти, 4 проєкти (один без власника, один лише з intake.json), спільні витрати, леджер. */
async function seed() {
  const env = await setup({}, { user: { email: "admin@example.com", admin: true } });
  const olena = (await seedUser(env, { email: "olena@example.com", name: "Олена", credits: 30 })).user;
  const petro = (await seedUser(env, { email: "petro@example.com", name: "Петро", credits: 30 })).user;

  const project = async (id: string, ownerId: string | undefined, deliveredAt: string | null) =>
    env.storage.writeJson(
      projectPaths(id).project,
      fixtureProject({
        id,
        createdAt: "2026-09-15T09:00:00.000Z",
        status: deliveredAt ? "delivered" : "awaiting_brand",
        input: { kind: "site", url: `https://${id}.example.com/`, manualText: null },
        firstDeliveredAt: deliveredAt,
        deliveredAt,
        ...(ownerId ? { ownerId } : {}),
      }),
    );

  await project("olena-site", olena.id, "2026-10-03T12:00:00.000Z");
  await writeCosts(env, projectPaths("olena-site").costs, [
    event("olena-site", { ts: "2026-10-03T10:00:00.000Z", usd: 2 }),
    event("olena-site", {
      ts: "2026-10-05T10:00:00.000Z",
      usd: 0.5,
      phase: "revision",
      rev: 2,
      stage: "revise",
    }),
  ]);

  // Лише intake.json — власник усе одно Олена.
  await env.storage.writeJson(projectPaths("olena-intake").intake, {
    projectId: "olena-intake",
    createdAt: "2026-10-09T09:00:00.000Z",
    origin: "chat",
    input: { kind: "site", url: "https://intake.example.com/", manualText: null },
    photos: [],
    ownerId: olena.id,
  });
  await writeCosts(env, projectPaths("olena-intake").costs, [
    event("olena-intake", { ts: "2026-10-10T10:00:00.000Z", usd: 1, stage: "crawl" }),
  ]);

  await project("petro-site", petro.id, null);
  await writeCosts(env, projectPaths("petro-site").costs, [
    // до вікна 2026-10-01
    event("petro-site", { ts: "2026-09-20T10:00:00.000Z", usd: 3 }),
    event("petro-site", {
      ts: "2026-10-02T10:00:00.000Z",
      usd: 0.25,
      stage: "render",
      provider: "remotion",
      model: "remotion",
      units: { renders: 1 },
    }),
    // eval не входить у дефолтне джерело chat
    event("petro-site", { ts: "2026-10-02T11:00:00.000Z", usd: 9, source: "eval" }),
  ]);

  await project("no-owner", undefined, null);
  await writeCosts(env, projectPaths("no-owner").costs, [
    event("no-owner", { ts: "2026-10-04T10:00:00.000Z", usd: 0.7 }),
  ]);

  await writeCosts(env, sharedPaths.costs, [
    event(null, {
      ts: "2026-10-04T12:00:00.000Z",
      usd: 0.1,
      stage: "sfx-cache",
      provider: "elevenlabs",
      model: "eleven_sfx",
      units: { seconds: 5 },
      rev: null,
    }),
  ]);

  await env.accounts.apply(olena.id, {
    id: "video:olena-site",
    kind: "charge",
    credits: -10,
    ref: { projectId: "olena-site" },
  });
  await env.accounts.apply(olena.id, { id: "refund:olena-site", kind: "refund", credits: 3, ref: {} });
  await env.accounts.apply(petro.id, {
    id: "video:petro-site",
    kind: "charge",
    credits: -4,
    ref: { projectId: "petro-site" },
  });
  return { env, olena, petro };
}

async function getJson<T>(env: Env, path: string): Promise<T> {
  const res = await env.request(path);
  expect(res.status, path).toBe(200);
  return (await res.json()) as T;
}

/** Усі сторінки `projects` без owner. */
async function allProjects(env: Env, qs: string) {
  const first = await getJson<UsageProjectsResponse>(env, `/api/admin/usage/projects?pageSize=2${qs}`);
  const items = [...first.items];
  for (let page = 2; (page - 1) * 2 < first.total; page++) {
    const next = await getJson<UsageProjectsResponse>(
      env,
      `/api/admin/usage/projects?pageSize=2&page=${page}${qs}`,
    );
    items.push(...next.items);
  }
  return { first, items };
}

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);

/** Три відповіді для вікна `qs` + перевірка інваріантів між ними. */
async function consistent(env: Env, qs: string) {
  const summary = await getJson<UsageSummaryResponse>(env, `/api/admin/usage/summary?${qs}`);
  const users = await getJson<UsageUsersResponse>(env, `/api/admin/usage/users?${qs}`);
  const { first, items } = await allProjects(env, qs ? `&${qs}` : "");

  expect(
    Math.abs(summary.totals.usd - (sum(users.users.map((u) => u.usd)) + summary.system.usd)),
  ).toBeLessThan(EPS * (users.users.length + 1));
  expect(items).toHaveLength(first.total);
  expect(Math.abs(sum(items.map((p) => p.usd)) - first.totals.usd)).toBeLessThan(EPS * items.length + EPS);
  expect(summary.totals.projects).toBe(first.total);

  const csv = await env.request(`/api/admin/usage/projects.csv?${qs}`);
  expect(csv.status).toBe(200);
  const lines = (await csv.text()).replace(/^﻿/, "").trimEnd().split(/\r?\n/);
  expect(lines).toHaveLength(1 + first.total + 1);
  const shared = lines.at(-1)?.split(",") ?? [];
  expect(shared[1]).toBe("");
  expect(shared[2]).toBe("(спільні витрати)");
  const sharedUsd = Number(shared[13]);
  expect(Math.abs(first.totals.usd + sharedUsd - summary.totals.usd)).toBeLessThan(EPS * 10);

  return { summary, users, projects: first, sharedUsd };
}

/** Кожен тест сіє користувачів і проєкти: під паралельним навантаженням 5 с замало. */
const SLOW = { timeout: 20_000 };

describe("usage — e2e", SLOW, () => {
  it("без вікна: інваріанти, атрибуція, кредити й маржа", async () => {
    const { env, olena, petro } = await seed();
    const { summary, users, projects, sharedUsd } = await consistent(env, "");

    expect(summary.totals.usd).toBeCloseTo(2 + 0.5 + 1 + 3 + 0.25 + 0.7 + 0.1, 6);
    expect(summary.system.usd).toBeCloseTo(0.7 + 0.1, 6);
    expect(sharedUsd).toBeCloseTo(0.1, 6);
    expect(summary.totals).toMatchObject({ users: 2, projects: 4, delivered: 1, creditsCharged: 11 });
    expect(summary.totals.avgUsdPerDelivered).toBeCloseTo(2, 6);
    expect(summary.totals.avgUsdPerRevision).toBeCloseTo(0.5, 6);

    const byId = Object.fromEntries(users.users.map((u) => [u.id, u]));
    // адмін теж у списку — з нулями
    expect(users.users).toHaveLength(3);
    expect(byId[olena.id]).toMatchObject({ projects: 2, delivered: 1, creditsCharged: 7 });
    expect(byId[olena.id]?.usd).toBeCloseTo(3.5, 6);
    expect(byId[petro.id]?.usd).toBeCloseTo(3.25, 6);
    expect(byId[petro.id]?.creditsCharged).toBe(4);
    expect(users.users[0]?.id).toBe(olena.id);

    const intake = (await allProjects(env, "&search=intake")).items;
    expect(intake.map((p) => [p.projectId, p.ownerEmail, p.status])).toEqual([
      ["olena-intake", "olena@example.com", "intake"],
    ]);
    expect(projects.total).toBe(4);

    const none = await getJson<UsageProjectsResponse>(env, "/api/admin/usage/projects?owner=none");
    expect(none.items.map((p) => p.projectId)).toEqual(["no-owner"]);
    const own = await getJson<UsageProjectsResponse>(env, `/api/admin/usage/projects?owner=${olena.id}`);
    expect(own.items.map((p) => p.projectId).sort()).toEqual(["olena-intake", "olena-site"]);
  });

  it("вікно від 2026-10-01 зменшує всі три відповіді на ту саму суму", async () => {
    const { env, petro } = await seed();
    const full = await consistent(env, "");
    const cut = await consistent(env, "from=2026-10-01");
    const dropped = 3;
    expect(full.summary.totals.usd - cut.summary.totals.usd).toBeCloseTo(dropped, 6);
    expect(full.projects.totals.usd - cut.projects.totals.usd).toBeCloseTo(dropped, 6);
    const usd = (r: UsageUsersResponse) => r.users.find((u) => u.id === petro.id)?.usd ?? 0;
    expect(usd(full.users) - usd(cut.users)).toBeCloseTo(dropped, 6);
  });

  it("source=eval: лише eval-події, кредити й маржа — null", async () => {
    const { env } = await seed();
    const summary = await getJson<UsageSummaryResponse>(env, "/api/admin/usage/summary?source=eval");
    expect(summary.totals.usd).toBeCloseTo(9, 6);
    expect(summary.totals).toMatchObject({ creditsCharged: null, creditsUsd: null, marginUsd: null });
  });

  it("клієнт → 403 на всіх ендпоінтах", async () => {
    const { env } = await seed();
    const client = await seedUser(env, { email: "client@example.com" });
    for (const p of ["summary", "users", "projects", "projects.csv"]) {
      const res = await client.request(`/api/admin/usage/${p}`);
      expect(res.status, p).toBe(403);
    }
  });
});
