import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { usageRoutes } from "../src/routes/usage.ts";
import { type AppEnv, sessionMiddleware } from "../src/session.ts";
import { CSV_BOM, CSV_COLUMNS, csvField, toCsv } from "../src/usage/csv.ts";
import type {
  CsvQuery,
  ProjectsQuery,
  UsageAggregate,
  UsageCsvRow,
  UsageEngine,
  UsageProjectsResponse,
  UsageSummaryResponse,
  UsageUsersResponse,
  UsageWindow,
  UsersQuery,
} from "../src/usage/types.ts";
import { type Env, seedUser, setup } from "./helpers.ts";

/** HTTP-шар «Використання» (B2): розбір параметрів, помилки, CSV. Двигун — фейковий. */

const ZERO: UsageAggregate = {
  calls: 0,
  tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0 },
  audioSeconds: 0,
  renders: 0,
  usd: 0,
};

const CSV_ROW: UsageCsvRow = {
  ownerEmail: "olena@example.com",
  projectId: "p_1",
  host: "zerno.example.com",
  status: "delivered",
  createdAt: "2026-10-03T10:00:00.000Z",
  firstDeliveredAt: null,
  calls: 3,
  tokensInput: 100,
  tokensOutput: 50,
  tokensCacheWrite: 10,
  tokensCacheRead: 5,
  audioSeconds: 12.5,
  renders: 1,
  usd: 2.345678,
  firstDeliveryUsd: 2.2,
  revisionUsd: 0.145678,
};

interface Calls {
  summary: UsageWindow[];
  users: UsersQuery[];
  projects: ProjectsQuery[];
  csv: CsvQuery[];
}

/** Фейковий двигун: пише отримані запити й віддає відповіді з ехом запиту. */
function fakeEngine(over: Partial<{ unknownOwner: string; csv: UsageCsvRow[] }> = {}) {
  const calls: Calls = { summary: [], users: [], projects: [], csv: [] };
  const engine: UsageEngine = {
    async summary(q) {
      calls.summary.push(q);
      return {
        ...q,
        totals: {
          ...ZERO,
          users: 0,
          projects: 0,
          delivered: 0,
          avgUsdPerDelivered: null,
          avgUsdPerRevision: null,
          creditsCharged: null,
          creditsUsd: null,
          marginUsd: null,
        },
        byModel: [],
        byStage: [],
        system: ZERO,
      } satisfies UsageSummaryResponse;
    },
    async users(q) {
      calls.users.push(q);
      return { from: q.from, to: q.to, source: q.source, users: [] } satisfies UsageUsersResponse;
    },
    async projects(q) {
      calls.projects.push(q);
      if (q.owner !== null && q.owner === over.unknownOwner) return null;
      return {
        owner: q.owner,
        from: q.from,
        to: q.to,
        source: q.source,
        page: q.page,
        pageSize: q.pageSize,
        total: 0,
        items: [],
        totals: ZERO,
      } satisfies UsageProjectsResponse;
    },
    async csv(q) {
      calls.csv.push(q);
      if (q.owner !== null && q.owner === over.unknownOwner) return null;
      return over.csv ?? [CSV_ROW];
    },
  };
  return { engine, calls };
}

/** Мінімальний застосунок: сесія → `usageRoutes` з фейковим двигуном (як монтує `app.ts`). */
function mount(env: Env, engine: UsageEngine) {
  const app = new Hono<AppEnv>();
  app.use("*", sessionMiddleware(env));
  app.route("/api/admin/usage", usageRoutes(env, engine));
  return app;
}

async function withAdmin(over: Parameters<typeof fakeEngine>[0] = {}) {
  const env = await setup();
  const admin = await seedUser(env, { email: "boss@example.com", name: "Бос", admin: true });
  const fake = fakeEngine(over);
  const app = mount(env, fake.engine);
  const get = (path: string) => app.request(`/api/admin/usage${path}`, { headers: { cookie: admin.cookie } });
  return { env, app, get, ...fake };
}

/** Тіло CSV з BOM (`Response.text()` його відкидає). */
async function rawText(res: Response): Promise<string> {
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(await res.arrayBuffer());
}

const ENDPOINTS = ["/summary", "/users", "/projects", "/projects.csv"];

describe("/api/admin/usage — доступ", () => {
  it.each(ENDPOINTS)("%s: гість → 401, не адмін → 403, двигун не викликано", async (path) => {
    const env = await setup();
    const { engine, calls } = fakeEngine();
    const app = mount(env, engine);
    const anon = await app.request(`/api/admin/usage${path}`);
    expect(anon.status).toBe(401);
    expect(((await anon.json()) as { error: string }).error).toBe("unauthorized");
    const user = await app.request(`/api/admin/usage${path}`, { headers: { cookie: env.cookie ?? "" } });
    expect(user.status).toBe(403);
    expect(((await user.json()) as { error: string }).error).toBe("forbidden");
    expect(calls).toEqual({ summary: [], users: [], projects: [], csv: [] });
  });

  it("лише GET: POST → не 2xx, двигун не викликано", async () => {
    const { app, calls, env } = await withAdmin();
    const admin = await seedUser(env, { email: "boss2@example.com", admin: true });
    const res = await app.request("/api/admin/usage/summary", {
      method: "POST",
      headers: { cookie: admin.cookie },
    });
    expect(res.status).toBe(404);
    expect(calls.summary).toEqual([]);
  });
});

describe("GET /summary", () => {
  it("дефолти: порожній запит → source=chat, межі null; відповідь двигуна повертається як є", async () => {
    const { get, calls } = await withAdmin();
    const res = await get("/summary");
    expect(res.status).toBe(200);
    expect(calls.summary).toEqual([{ from: null, to: null, source: "chat" }]);
    const body = (await res.json()) as UsageSummaryResponse;
    expect(body).toMatchObject({ from: null, to: null, source: "chat", byModel: [], byStage: [] });
    expect(body.totals.avgUsdPerDelivered).toBeNull();
  });

  it("ехо from/to/source береться з відповіді двигуна", async () => {
    const { get, calls } = await withAdmin();
    const res = await get("/summary?from=2026-10-01&to=2026-10-31&source=all");
    expect(calls.summary).toEqual([{ from: "2026-10-01", to: "2026-10-31", source: "all" }]);
    expect(await res.json()).toMatchObject({ from: "2026-10-01", to: "2026-10-31", source: "all" });
  });

  it("from = to — валідний діапазон; невідомі параметри ігноруються", async () => {
    const { get, calls } = await withAdmin();
    const res = await get("/summary?from=2026-10-05&to=2026-10-05&foo=bar&sort=nonsense");
    expect(res.status).toBe(200);
    expect(calls.summary).toEqual([{ from: "2026-10-05", to: "2026-10-05", source: "chat" }]);
  });

  it("порожні значення = параметр відсутній", async () => {
    const { get, calls } = await withAdmin();
    expect((await get("/summary?from=&to=&source=")).status).toBe(200);
    expect(calls.summary).toEqual([{ from: null, to: null, source: "chat" }]);
  });

  it("високосний день валідний", async () => {
    const { get, calls } = await withAdmin();
    expect((await get("/summary?from=2028-02-29")).status).toBe(200);
    expect(calls.summary[0]?.from).toBe("2028-02-29");
  });

  it.each([
    ["2026-02-30", "неіснуючий день"],
    ["2026-13-01", "неіснуючий місяць"],
    ["2026-02-29", "не високосний рік"],
    ["2026-1-01", "не нульове доповнення"],
    ["20261001", "без дефісів"],
    ["2026-10-01T00:00:00Z", "з часом"],
    ["not-a-date", "сміття"],
    [" 2026-10-01", "пробіл"],
  ])("from=%s (%s) → 400 invalid_query", async (value) => {
    const { get, calls } = await withAdmin();
    const res = await get(`/summary?from=${encodeURIComponent(value)}`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("invalid_query");
    expect(body.message).toContain("from");
    expect(calls.summary).toEqual([]);
  });

  it("to=2026-02-30 → 400 invalid_query з назвою параметра", async () => {
    const { get } = await withAdmin();
    const res = await get("/summary?to=2026-02-30");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("invalid_query");
    expect(body.message).toContain("to");
  });

  it("source=bogus → 400 invalid_query", async () => {
    const { get } = await withAdmin();
    const res = await get("/summary?source=bogus");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("invalid_query");
    expect(body.message).toContain("source");
  });

  it("to < from → 400 invalid_range з точним текстом", async () => {
    const { get, calls } = await withAdmin();
    const res = await get("/summary?from=2026-10-10&to=2026-10-09");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_range", message: "Дата «До» раніша за «Від»." });
    expect(calls.summary).toEqual([]);
  });

  it("нерозбірна дата перемагає invalid_range", async () => {
    const { get } = await withAdmin();
    const res = await get("/summary?from=2026-10-10&to=2026-02-30");
    expect(((await res.json()) as { error: string }).error).toBe("invalid_query");
  });
});

describe("GET /users", () => {
  it("дефолти: sort=usd, order=desc, source=chat", async () => {
    const { get, calls } = await withAdmin();
    const res = await get("/users");
    expect(res.status).toBe(200);
    expect(calls.users).toEqual([{ from: null, to: null, source: "chat", sort: "usd", order: "desc" }]);
    expect(await res.json()).toEqual({ from: null, to: null, source: "chat", users: [] });
  });

  it("усі явні параметри доходять до двигуна", async () => {
    const { get, calls } = await withAdmin();
    await get("/users?from=2026-10-01&to=2026-10-31&source=eval&sort=marginUsd&order=asc");
    expect(calls.users).toEqual([
      { from: "2026-10-01", to: "2026-10-31", source: "eval", sort: "marginUsd", order: "asc" },
    ]);
  });

  it.each(["usd", "email", "projects", "createdAt", "marginUsd"])("sort=%s приймається", async (sort) => {
    const { get } = await withAdmin();
    expect((await get(`/users?sort=${sort}`)).status).toBe(200);
  });

  it.each([
    ["sort=tokens", "sort"], // валідний лише для /projects
    ["sort=USD", "sort"],
    ["order=up", "order"],
    ["order=ASC", "order"],
    ["source=nope", "source"],
    ["from=2026-02-30", "from"],
  ])("%s → 400 invalid_query", async (query, name) => {
    const { get, calls } = await withAdmin();
    const res = await get(`/users?${query}`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("invalid_query");
    expect(body.message).toContain(name);
    expect(calls.users).toEqual([]);
  });

  it("to < from → 400 invalid_range", async () => {
    const { get } = await withAdmin();
    const res = await get("/users?from=2026-10-10&to=2026-10-01");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_range");
  });
});

describe("GET /projects", () => {
  it("дефолти: owner=null, search=null, sort=usd, order=desc, page=1, pageSize=25, source=chat", async () => {
    const { get, calls } = await withAdmin();
    const res = await get("/projects");
    expect(res.status).toBe(200);
    expect(calls.projects).toEqual([
      {
        from: null,
        to: null,
        source: "chat",
        owner: null,
        search: null,
        sort: "usd",
        order: "desc",
        page: 1,
        pageSize: 25,
      },
    ]);
    expect(await res.json()).toMatchObject({ owner: null, page: 1, pageSize: 25, total: 0, items: [] });
  });

  it("усі явні параметри доходять до двигуна; відповідь двигуна повертається як є", async () => {
    const { get, calls } = await withAdmin();
    const res = await get(
      "/projects?owner=none&from=2026-10-01&to=2026-10-31&source=test&search=zerno&sort=host&order=asc&page=3&pageSize=200",
    );
    expect(calls.projects).toEqual([
      {
        owner: "none",
        from: "2026-10-01",
        to: "2026-10-31",
        source: "test",
        search: "zerno",
        sort: "host",
        order: "asc",
        page: 3,
        pageSize: 200,
      },
    ]);
    expect(await res.json()).toMatchObject({
      owner: "none",
      from: "2026-10-01",
      to: "2026-10-31",
      source: "test",
      page: 3,
      pageSize: 200,
    });
  });

  it("owner = id користувача проходить рядком без змін", async () => {
    const { get, calls } = await withAdmin();
    await get("/projects?owner=u_8xk2abcd");
    expect(calls.projects[0]?.owner).toBe("u_8xk2abcd");
  });

  it("search обрізається; порожній або з пробілів → null", async () => {
    const { get, calls } = await withAdmin();
    await get(`/projects?search=${encodeURIComponent("  Zerno  ")}`);
    await get("/projects?search=");
    await get(`/projects?search=${encodeURIComponent("   ")}`);
    expect(calls.projects.map((q) => q.search)).toEqual(["Zerno", null, null]);
  });

  it("owner порожній → null", async () => {
    const { get, calls } = await withAdmin();
    await get("/projects?owner=");
    expect(calls.projects[0]?.owner).toBeNull();
  });

  it.each(["usd", "createdAt", "tokens", "calls", "host", "status", "ownerEmail"])(
    "sort=%s приймається",
    async (sort) => {
      const { get } = await withAdmin();
      expect((await get(`/projects?sort=${sort}`)).status).toBe(200);
    },
  );

  it("межі pageSize: 1 і 200 валідні", async () => {
    const { get, calls } = await withAdmin();
    expect((await get("/projects?pageSize=1")).status).toBe(200);
    expect((await get("/projects?pageSize=200")).status).toBe(200);
    expect(calls.projects.map((q) => q.pageSize)).toEqual([1, 200]);
  });

  it.each([
    ["sort=email", "sort"], // валідний лише для /users
    ["sort=", null], // порожнє — дефолт, не помилка
    ["order=sideways", "order"],
    ["source=prod", "source"],
    ["page=0", "page"],
    ["page=-1", "page"],
    ["page=1.5", "page"],
    ["page=abc", "page"],
    ["page=1e2", "page"],
    ["pageSize=0", "pageSize"],
    ["pageSize=201", "pageSize"],
    ["pageSize=-5", "pageSize"],
    ["pageSize=2.5", "pageSize"],
    ["pageSize=many", "pageSize"],
    ["from=2026-02-30", "from"],
    ["to=2026-13-40", "to"],
  ])("%s → 400 invalid_query", async (query, name) => {
    const { get, calls } = await withAdmin();
    const res = await get(`/projects?${query}`);
    if (name === null) {
      expect(res.status).toBe(200);
      return;
    }
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("invalid_query");
    expect(body.message).toContain(name);
    expect(calls.projects).toEqual([]);
  });

  it("to < from → 400 invalid_range з точним текстом", async () => {
    const { get } = await withAdmin();
    const res = await get("/projects?from=2026-10-10&to=2026-10-09");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_range", message: "Дата «До» раніша за «Від»." });
  });

  it("невідомий власник (двигун → null) → 404 not_found", async () => {
    const { get } = await withAdmin({ unknownOwner: "u_ghost123" });
    const res = await get("/projects?owner=u_ghost123");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found", message: "Користувача не знайдено." });
  });
});

describe("GET /projects.csv", () => {
  it("заголовки, BOM, 16 колонок, CRLF", async () => {
    const { get, calls } = await withAdmin();
    const res = await get("/projects.csv");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    // NOW у helpers = 2026-10-06T10:00:00Z
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="adcreative-usage-2026-10-06.csv"',
    );
    expect(calls.csv).toEqual([{ from: null, to: null, source: "chat", owner: null, search: null }]);

    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
    expect(text.startsWith(CSV_BOM)).toBe(true);
    const lines = text.slice(1).split("\r\n");
    expect(lines.pop()).toBe(""); // кінцевий CRLF
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(
      "owner_email,project_id,host,status,created_at,first_delivered_at,calls,tokens_input,tokens_output,tokens_cache_write,tokens_cache_read,audio_seconds,renders,usd,first_delivery_usd,revision_usd",
    );
    expect(lines[0]?.split(",")).toHaveLength(16);
    expect(lines[1]).toBe(
      "olena@example.com,p_1,zerno.example.com,delivered,2026-10-03T10:00:00.000Z,,3,100,50,10,5,12.5,1,2.345678,2.2,0.145678",
    );
  });

  it("filename бере дату з годинника конфігу (UTC)", async () => {
    const env = await setup({ now: () => new Date("2026-12-31T23:59:59.000Z") });
    const admin = await seedUser(env, { email: "boss@example.com", admin: true });
    const app = mount(env, fakeEngine().engine);
    const res = await app.request("/api/admin/usage/projects.csv", { headers: { cookie: admin.cookie } });
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="adcreative-usage-2026-12-31.csv"',
    );
  });

  it("параметри доходять до двигуна без sort/order/page/pageSize", async () => {
    const { get, calls } = await withAdmin();
    await get(
      "/projects.csv?owner=u_8xk2abcd&from=2026-10-01&to=2026-10-31&source=all&search=%20zerno%20&sort=host&page=2&pageSize=5",
    );
    expect(calls.csv).toEqual([
      { owner: "u_8xk2abcd", from: "2026-10-01", to: "2026-10-31", source: "all", search: "zerno" },
    ]);
  });

  it("кома в host — в лапках; лапки подвоюються; null → порожнє; порядок рядків збережено", async () => {
    const shared: UsageCsvRow = {
      ...CSV_ROW,
      ownerEmail: null,
      projectId: null,
      host: "(спільні витрати)",
      status: null,
      createdAt: null,
    };
    const tricky: UsageCsvRow = { ...CSV_ROW, projectId: "p_2", host: 'a,b.example.com "x"' };
    const { get } = await withAdmin({ csv: [tricky, CSV_ROW, shared] });
    const text = (await rawText(await get("/projects.csv"))).slice(1);
    const lines = text.split("\r\n");
    expect(lines).toHaveLength(5);
    expect(lines[1]?.split(",")[2]).toBe('"a'); // сире ділення по комі показує, що поле в лапках
    expect(lines[1]).toContain(',"a,b.example.com ""x""",');
    expect(lines[2]?.startsWith("olena@example.com,p_1,")).toBe(true);
    expect(lines[3]?.startsWith(",,(спільні витрати),,,,3,")).toBe(true);
  });

  it("порожня вибірка: лише BOM + заголовок", async () => {
    const { get } = await withAdmin({ csv: [] });
    const text = await rawText(await get("/projects.csv"));
    expect(text.split("\r\n")).toHaveLength(2);
    expect(text.startsWith(`${CSV_BOM}owner_email,`)).toBe(true);
  });

  it("помилки — JSON, не CSV: 400 invalid_query / invalid_range, 404 not_found", async () => {
    const { get, calls } = await withAdmin({ unknownOwner: "u_ghost123" });
    const bad = await get("/projects.csv?source=nope");
    expect(bad.status).toBe(400);
    expect(bad.headers.get("content-type")).toContain("application/json");
    expect(((await bad.json()) as { error: string }).error).toBe("invalid_query");

    const range = await get("/projects.csv?from=2026-10-10&to=2026-10-09");
    expect(range.status).toBe(400);
    expect(await range.json()).toEqual({ error: "invalid_range", message: "Дата «До» раніша за «Від»." });

    const missing = await get("/projects.csv?owner=u_ghost123");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("content-type")).toContain("application/json");
    expect(await missing.json()).toEqual({ error: "not_found", message: "Користувача не знайдено." });
    expect(calls.csv).toHaveLength(1); // двигун викликано лише для 404-запиту
  });
});

describe("toCsv / csvField", () => {
  it("csvField: лапки лише за потреби", () => {
    expect(csvField(null)).toBe("");
    expect(csvField("plain")).toBe("plain");
    expect(csvField("a,b")).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField("line\nbreak")).toBe('"line\nbreak"');
    expect(csvField("carriage\rreturn")).toBe('"carriage\rreturn"');
    expect(csvField("кирилиця")).toBe("кирилиця");
  });

  it("числа — як є, з крапкою; 0 не стає порожнім", () => {
    expect(csvField(0)).toBe("0");
    expect(csvField(12.5)).toBe("12.5");
    expect(csvField(0.000001)).toBe("0.000001");
    expect(csvField(1234567)).toBe("1234567");
  });

  it("колонки відповідають контракту й полям UsageCsvRow", () => {
    expect(CSV_COLUMNS).toHaveLength(16);
    expect(CSV_COLUMNS.map(([, key]) => key).sort()).toEqual(Object.keys(CSV_ROW).sort());
  });

  it("без рядків — BOM + заголовок + CRLF", () => {
    const csv = toCsv([]);
    expect(csv.startsWith(`${CSV_BOM}owner_email,project_id,`)).toBe(true);
    expect(csv.endsWith("revision_usd\r\n")).toBe(true);
  });
});
