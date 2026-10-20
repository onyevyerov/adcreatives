import { projectPaths } from "@adc/shared";
import { fixtureProject } from "@adc/shared/fixtures";
import { describe, expect, it, vi } from "vitest";
import { type Env, form, seedUser, setup } from "./helpers.ts";

/** Витрати проєкту в рядку `GET /api/projects` і в `GET /api/projects/:id`. */
interface Credits {
  charged: number;
  refunded: number;
  parts: { kind: string; credits: number; format?: string; rev?: number }[];
}
interface Row {
  id: string;
  ownerId: string | null;
  credits: Credits | null;
}

async function create(request: Env["request"], url: string): Promise<string> {
  const res = await request("/api/projects", { method: "POST", body: form({ url }) });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

async function rows(request: Env["request"], query = ""): Promise<Row[]> {
  const res = await request(`/api/projects${query}`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { projects: Row[] }).projects;
}

async function detail(request: Env["request"], id: string): Promise<Credits | null> {
  const res = await request(`/api/projects/${id}`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { credits: Credits | null }).credits;
}

/**
 * Дані Референсу (`_base`): «zerno» — ролик −10, формат 1:1 −2, правка рев. 2 −3;
 * «shyna» — ролик −10 і повернення за збій +10. Плюс чужий проєкт і безхазяйний legacy.
 */
async function world() {
  const env = await setup({}, { user: { credits: 100 } });
  const uid = env.user?.id ?? "";
  const zerno = await create(env.request, "https://zerno.example.com");
  const shyna = await create(env.request, "https://shyna-lviv.example.com");
  await env.accounts.apply(uid, {
    id: `format:${zerno}:square`,
    kind: "charge",
    credits: -2,
    ref: { projectId: zerno, format: "square" },
    note: "Додатковий формат: 1:1",
  });
  await env.accounts.apply(uid, {
    id: `refund:${shyna}`,
    kind: "refund",
    credits: 10,
    ref: { projectId: shyna },
    note: "Повернення за збій",
  });
  await env.accounts.apply(uid, {
    id: `revision:${zerno}:r2`,
    kind: "charge",
    credits: -3,
    ref: { projectId: zerno, rev: 2 },
    note: "Правка",
  });
  // Записи без проєкту не потрапляють у жодний рядок.
  await env.accounts.apply(uid, { id: "adjust:comp0001", kind: "adjust", credits: 5, note: "компенсація" });

  const other = await seedUser(env, { email: "other@example.com", credits: 100 });
  const foreign = await create(other.request, "https://foreign.example.com");
  await env.storage.writeJson(projectPaths("legacy").project, fixtureProject({ id: "legacy" }));
  return { env, uid, zerno, shyna, other, foreign };
}

const ZERNO: Credits = {
  charged: 15,
  refunded: 0,
  parts: [
    { kind: "video", credits: -10 },
    { kind: "format", credits: -2, format: "square" },
    { kind: "revision", credits: -3, rev: 2 },
  ],
};

const SHYNA: Credits = {
  charged: 10,
  refunded: 10,
  parts: [
    { kind: "video", credits: -10 },
    { kind: "refund", credits: 10 },
  ],
};

describe("credits по проєкту", () => {
  it("GET /api/projects: zerno → 15 / 0, три parts у хронології; збій з поверненням → 10 / 10", async () => {
    const { env, zerno, shyna } = await world();
    const list = await rows(env.request);
    expect(list.map((r) => r.id).sort()).toEqual([zerno, shyna].sort());
    expect(list.find((r) => r.id === zerno)?.credits).toEqual(ZERNO);
    expect(list.find((r) => r.id === shyna)?.credits).toEqual(SHYNA);
  });

  it("GET /api/projects/:id повертає ті самі credits", async () => {
    const { env, zerno, shyna } = await world();
    expect(await detail(env.request, zerno)).toEqual(ZERNO);
    expect(await detail(env.request, shyna)).toEqual(SHYNA);
  });

  it("свіжий проєкт без додаткових списань → лише ролик", async () => {
    const env = await setup({}, { user: { credits: 100 } });
    const id = await create(env.request, "https://new.example.com");
    const price = env.config.credits.prices.video;
    expect(await detail(env.request, id)).toEqual({
      charged: price,
      refunded: 0,
      parts: [{ kind: "video", credits: -price }],
    });
  });

  it("один readLedger на користувача на запит; чужий леджер не читається", async () => {
    const { env, uid, zerno, other, foreign } = await world();
    const spy = vi.spyOn(env.accounts, "readLedger");

    await rows(env.request);
    expect(spy.mock.calls.map(([u]) => u)).toEqual([uid]);

    spy.mockClear();
    await detail(env.request, zerno);
    expect(spy.mock.calls.map(([u]) => u)).toEqual([uid]);

    // Чужий проєкт — 404 без читання леджера власника.
    spy.mockClear();
    expect((await env.request(`/api/projects/${foreign}`)).status).toBe(404);
    expect(spy).not.toHaveBeenCalled();

    // `?all=1` для не-admin ігнорується — лише свій леджер.
    spy.mockClear();
    await rows(env.request, "?all=1");
    expect(spy.mock.calls.map(([u]) => u)).toEqual([uid]);

    // Леджер іншого користувача не змішується з моїм.
    spy.mockClear();
    const theirs = await rows(other.request);
    expect(theirs.map((r) => r.id)).toEqual([foreign]);
    expect(theirs[0]?.credits?.parts).toEqual([{ kind: "video", credits: -env.config.credits.prices.video }]);
    expect(spy.mock.calls.map(([u]) => u)).toEqual([other.user.id]);
  });

  it("admin ?all=1: леджер власника кожного проєкту, по одному читанню; безхазяйний → null", async () => {
    const { env, uid, zerno, shyna, other, foreign } = await world();
    const admin = await seedUser(env, { email: "admin@example.com", admin: true });
    const spy = vi.spyOn(env.accounts, "readLedger");

    const list = await rows(admin.request, "?all=1");
    const byId = new Map(list.map((r) => [r.id, r]));
    expect(byId.get(zerno)?.credits).toEqual(ZERNO);
    expect(byId.get(shyna)?.credits).toEqual(SHYNA);
    expect(byId.get(foreign)?.credits?.charged).toBe(env.config.credits.prices.video);
    expect(byId.get("legacy")).toMatchObject({ ownerId: null, credits: null });
    expect(spy.mock.calls.map(([u]) => u).sort()).toEqual([uid, other.user.id].sort());

    spy.mockClear();
    expect(await detail(admin.request, zerno)).toEqual(ZERNO);
    expect(spy.mock.calls.map(([u]) => u)).toEqual([uid]);

    spy.mockClear();
    expect(await detail(admin.request, "legacy")).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
});
