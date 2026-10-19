import { type CostEvent, type CostStage, projectPaths, type StatsReport } from "@adc/shared";
import { fixtureProject } from "@adc/shared/fixtures";
import { describe, expect, it } from "vitest";
import { seedUser, setup } from "./helpers.ts";

/** Статистика — лише для адміністратора: користувач за замовчуванням з `adminEmails`. */
const ADMIN = { user: { email: "admin@example.com", admin: true } };

function cost(projectId: string, usd: number, stage: CostStage, phase: CostEvent["phase"]): CostEvent {
  return {
    ts: "2026-10-06T10:00:00.000Z",
    projectId,
    rev: 1,
    stage,
    phase,
    source: "chat",
    provider: stage === "render" ? "remotion" : "anthropic",
    model: stage === "render" ? "remotion" : "claude-opus-5-5",
    promptName: null,
    promptHash: null,
    effort: null,
    attempt: 1,
    units:
      stage === "render"
        ? { renders: 1 }
        : { input: 1000, output: 1000, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0 },
    unitPrices: {},
    usd,
    exact: true,
    detail: null,
  };
}

/** Фікстура: дешевий доставлений проєкт, дорогий (понад ціль) і покинутий. */
async function seedStats() {
  const env = await setup({ costTargetUsd: 3.5 }, ADMIN);
  const seed = async (id: string, createdAt: string, delivered: boolean, events: CostEvent[]) => {
    const paths = projectPaths(id);
    await env.storage.writeJson(
      paths.project,
      fixtureProject({
        id,
        createdAt,
        status: delivered ? "delivered" : "awaiting_brand",
        input: { kind: "site", url: `https://${id}.example.com/`, manualText: null },
        firstDeliveredAt: delivered ? createdAt : null,
        deliveredAt: delivered ? createdAt : null,
      }),
    );
    // costs.jsonl — по рядку JSON на платний виклик, плюс битий рядок, який має пропускатись.
    const lines = events.map((e) => JSON.stringify(e));
    lines.splice(1, 0, "{not json");
    await env.storage.write(paths.costs, `${lines.join("\n")}\n`);
  };
  await seed("cheap", "2026-10-01T09:00:00.000Z", true, [
    cost("cheap", 1.0, "brandkit", "first_delivery"),
    cost("cheap", 0.5, "render", "first_delivery"),
    cost("cheap", 0.25, "revise", "revision"),
  ]);
  await seed("pricey", "2026-10-02T09:00:00.000Z", true, [
    cost("pricey", 3.0, "codegen", "first_delivery"),
    cost("pricey", 1.0, "fix", "first_delivery"),
  ]);
  await seed("abandoned", "2026-10-03T09:00:00.000Z", false, [
    cost("abandoned", 0.8, "brandkit", "first_delivery"),
  ]);
  return env;
}

describe("stats", () => {
  it("GET /api/stats — рядки, позначка понад ціль, підсумок", async () => {
    const env = await seedStats();
    const res = await env.request("/api/stats");
    expect(res.status).toBe(200);
    const report = (await res.json()) as StatsReport;
    expect(report.rows.map((r) => r.projectId)).toEqual(["abandoned", "pricey", "cheap"]);
    const byId = Object.fromEntries(report.rows.map((r) => [r.projectId, r]));
    expect(byId.cheap).toMatchObject({
      firstDeliveryUsd: 1.5,
      revisionUsd: 0.25,
      totalUsd: 1.75,
      overTarget: false,
      chatUrl: "/?project=cheap",
    });
    expect(byId.pricey).toMatchObject({ totalUsd: 4, overTarget: true, fixesCount: 1 });
    expect(report.summary.totalUsd).toBeCloseTo(6.55);
    expect(report.summary.deliveredCount).toBe(2);
    expect(report.summary.allInPerDelivered).toBeCloseTo(3.275);
    expect(report.summary.targetUsd).toBe(3.5);
  });

  it("GET /api/stats.csv — та сама таблиця в CSV", async () => {
    const env = await seedStats();
    const res = await env.request("/api/stats.csv");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    const lines = (await res.text()).trim().split("\n");
    expect(lines[0]).toMatch(/^date,project,site,status/);
    expect(lines).toHaveLength(4);
    expect(lines.find((l) => l.includes(",pricey,"))).toContain(",true,");
  });

  it("GET /stats — HTML-таблиця, дорогі рядки позначені", async () => {
    const env = await seedStats();
    const res = await env.request("/stats");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain('<tr data-project="pricey" data-over-target="1">');
    expect(html).toContain('<tr data-project="cheap">');
    expect(html).toContain("понад ціль");
    expect(html).toContain("$6.55");
    expect(html).toContain('href="/?project=cheap"');
  });

  it("порожня статистика і ціль із конфігу", async () => {
    const env = await setup({ costTargetUsd: 5 }, ADMIN);
    const report = (await (await env.request("/api/stats")).json()) as StatsReport;
    expect(report.rows).toEqual([]);
    expect(report.summary.targetUsd).toBe(5);
    expect(await (await env.request("/stats")).text()).toContain("Ще немає проєктів.");
  });

  it("HTML екранується", async () => {
    const env = await setup({}, ADMIN);
    await env.storage.writeJson(
      projectPaths("xss").project,
      fixtureProject({
        id: "xss",
        input: { kind: "site", url: "https://x.example.com/<script>alert(1)</script>", manualText: null },
      }),
    );
    const html = await (await env.request("/stats")).text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("stats — лише для адміністратора", () => {
  it("анонім: JSON/CSV → 401 JSON, /stats → 401 текстом", async () => {
    const env = await setup({}, { user: null });
    for (const route of ["/api/stats", "/api/stats.csv"]) {
      const res = await env.app.request(route);
      expect(res.status, route).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized", message: "Потрібно увійти." });
    }
    const page = await env.app.request("/stats");
    expect(page.status).toBe(401);
    expect(page.headers.get("content-type")).toContain("text/plain");
    expect(await page.text()).toBe("Потрібно увійти.");
  });

  it("не-admin: JSON/CSV → 403 forbidden, /stats → 403 HTML без даних", async () => {
    const env = await seedStats();
    const plain = await seedUser(env, { email: "plain@example.com" });
    for (const route of ["/api/stats", "/api/stats.csv"]) {
      const res = await plain.request(route);
      expect(res.status, route).toBe(403);
      expect(await res.json()).toEqual({ error: "forbidden", message: "Лише для адміністратора." });
    }
    const page = await plain.request("/stats");
    expect(page.status).toBe(403);
    expect(page.headers.get("content-type")).toContain("text/html");
    const html = await page.text();
    expect(html).toContain("Лише для адміністратора");
    expect(html).not.toContain("pricey");
  });

  it("admin → 200 на всіх трьох", async () => {
    const env = await seedStats();
    for (const route of ["/api/stats", "/api/stats.csv", "/stats"]) {
      expect((await env.request(route)).status, route).toBe(200);
    }
  });
});
