import { describe, expect, it } from "vitest";
import { createUsageEngine } from "../src/usage/engine.ts";
import { setup } from "./helpers.ts";

/** Крок 0 вкладки «Використання»: доступ і форми відповідей двигуна на порожньому сховищі (`docs/usage-api.md`). */

const AGGREGATE_KEYS = ["audioSeconds", "calls", "renders", "tokens", "usd"];
const TOKENS = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0 };
const EMPTY = { calls: 0, tokens: TOKENS, audioSeconds: 0, renders: 0, usd: 0 };

describe("/api/admin/usage — доступ", () => {
  it("гість → 401, не адмін → 403", async () => {
    const env = await setup();
    const anon = await env.app.request("/api/admin/usage/summary");
    expect(anon.status).toBe(401);
    expect(((await anon.json()) as { error: string }).error).toBe("unauthorized");
    const user = await env.request("/api/admin/usage/summary");
    expect(user.status).toBe(403);
    expect(await user.json()).toEqual({ error: "forbidden", message: "Лише для адміністратора." });
  });
});

describe("createUsageEngine — форми на порожньому сховищі", () => {
  const engine = async () => {
    const env = await setup({}, { user: null });
    return createUsageEngine({ storage: env.storage, accounts: env.accounts, creditsPerUsd: 1 });
  };
  const window = { from: "2026-10-01", to: null, source: "chat" as const };

  it("summary: ехо вікна, нулі, null лише там, де дозволено", async () => {
    const res = await (await engine()).summary(window);
    expect(Object.keys(res).sort()).toEqual([
      "byModel",
      "byStage",
      "from",
      "source",
      "system",
      "to",
      "totals",
    ]);
    expect(res).toMatchObject({ from: "2026-10-01", to: null, source: "chat", byModel: [], byStage: [] });
    expect(res.system).toEqual(EMPTY);
    expect(res.totals).toEqual({
      ...EMPTY,
      users: 0,
      projects: 0,
      delivered: 0,
      avgUsdPerDelivered: null,
      avgUsdPerRevision: null,
      creditsCharged: 0,
      creditsUsd: 0,
      marginUsd: 0,
    });
    const evalRes = await (await engine()).summary({ ...window, source: "eval" });
    expect(evalRes.totals).toMatchObject({ creditsCharged: null, creditsUsd: null, marginUsd: null });
  });

  it("users: ехо вікна, масив", async () => {
    const res = await (await engine()).users({ ...window, sort: "usd", order: "desc" });
    expect(res).toEqual({ from: "2026-10-01", to: null, source: "chat", users: [] });
  });

  it("projects: ехо owner/вікна/сторінки, total і totals", async () => {
    const res = await (await engine()).projects({
      ...window,
      owner: null,
      search: null,
      sort: "usd",
      order: "desc",
      page: 1,
      pageSize: 25,
    });
    expect(res).toEqual({
      owner: null,
      from: "2026-10-01",
      to: null,
      source: "chat",
      page: 1,
      pageSize: 25,
      total: 0,
      items: [],
      totals: EMPTY,
    });
    expect(Object.keys(res?.totals ?? {}).sort()).toEqual(AGGREGATE_KEYS);
  });

  it("csv: без owner — лише рядок спільних витрат", async () => {
    expect(await (await engine()).csv({ ...window, owner: null, search: null })).toEqual([
      {
        ownerEmail: null,
        projectId: null,
        host: "(спільні витрати)",
        status: null,
        createdAt: null,
        firstDeliveredAt: null,
        calls: 0,
        tokensInput: 0,
        tokensOutput: 0,
        tokensCacheWrite: 0,
        tokensCacheRead: 0,
        audioSeconds: 0,
        renders: 0,
        usd: 0,
        firstDeliveryUsd: 0,
        revisionUsd: 0,
      },
    ]);
  });
});
