import { accountPaths, projectPaths, readEvents, t } from "@adc/shared";
import { fixtureProject } from "@adc/shared/fixtures";
import { describe, expect, it, vi } from "vitest";
import { canSee, IntakeFile, intakeKey, projectOwner } from "../src/intake.ts";
import { type Env, form, json, NOW, photo, seedUser, setup } from "./helpers.ts";

const PRICE = 10; // defaultCredits().prices.video

async function post(request: Env["request"], fields: Record<string, string | File | File[]> = {}) {
  return request("/api/projects", {
    method: "POST",
    body: form({ url: "https://zerno.example.com", ...fields }),
  });
}

async function createOwn(env: Env): Promise<string> {
  const res = await post(env.request);
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

/** Власник (env.user) з проєктом, чужий користувач, безхазяйний (legacy) проєкт. */
async function world() {
  const env = await setup({}, { user: { credits: 100 } });
  const own = await createOwn(env);
  const other = await seedUser(env, { email: "other@example.com", credits: 100 });
  const foreignRes = await post(other.request);
  const foreign = ((await foreignRes.json()) as { id: string }).id;
  await env.storage.writeJson(projectPaths("legacy").project, fixtureProject({ id: "legacy" }));
  return { env, own, other, foreign };
}

describe("projectOwner і canSee", () => {
  it("ownerId з project.json, інакше з intake.json; без файлів → null", async () => {
    const env = await setup();
    expect(await projectOwner(env.storage, "nope")).toBeNull();
    expect(await projectOwner(env.storage, "../x")).toBeNull();
    await env.storage.writeJson(intakeKey("a1"), { projectId: "a1", ownerId: "u_intake01" });
    expect(await projectOwner(env.storage, "a1")).toBe("u_intake01");
    // project.json без ownerId → беремо з intake.
    await env.storage.writeJson(projectPaths("a1").project, fixtureProject({ id: "a1" }));
    expect(await projectOwner(env.storage, "a1")).toBe("u_intake01");
    await env.storage.writeJson(
      projectPaths("a1").project,
      fixtureProject({ id: "a1", ownerId: "u_project1" }),
    );
    expect(await projectOwner(env.storage, "a1")).toBe("u_project1");
    await env.storage.writeJson(projectPaths("a2").project, fixtureProject({ id: "a2" }));
    expect(await projectOwner(env.storage, "a2")).toBeNull();
  });

  it("canSee: admin — усе, користувач — лише своє, безхазяйне — ні", () => {
    const user = { id: "u_00000001", isAdmin: false };
    expect(canSee(user, "u_00000001")).toBe(true);
    expect(canSee(user, "u_00000002")).toBe(false);
    expect(canSee(user, null)).toBe(false);
    expect(canSee(user, undefined)).toBe(false);
    expect(canSee({ ...user, isAdmin: true }, null)).toBe(true);
  });
});

describe("анонім на /api/projects/* → 401", () => {
  it("усі маршрути, нічого не створюється", async () => {
    const { env, own } = await world();
    const jobs = env.queue.pipeline.length;
    const anon = env.app.request.bind(env.app);
    const requests: Array<[string, RequestInit | undefined]> = [
      ["/api/projects", undefined],
      ["/api/projects?all=1", undefined],
      ["/api/projects", { method: "POST", body: form({ url: "https://zerno.example.com" }) }],
      [`/api/projects/${own}`, undefined],
      [`/api/projects/${own}/trace`, undefined],
      [`/api/projects/${own}/events`, undefined],
      [`/api/projects/${own}/messages`, json({ text: "привіт" })],
      [`/api/projects/${own}/commands`, json({ type: "retry" })],
      [`/api/projects/${own}/uploads`, { method: "POST", body: form({ photos: photo() }) }],
      ["/api/projects/nope", undefined],
    ];
    for (const [path, init] of requests) {
      const res = await anon(path, init);
      expect(res.status, path).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized", message: "Потрібно увійти." });
    }
    expect(env.queue.pipeline.length).toBe(jobs);
  });
});

describe("чужий проєкт → 404, як неіснуючий", () => {
  it("GET /:id, /:id/trace, /:id/events, /:id/messages, /:id/commands, /:id/uploads", async () => {
    const { env, foreign } = await world();
    const jobs = env.queue.pipeline.length;
    const eventsBefore = (await readEvents(env.redis, foreign)).length;
    const routes = (id: string): Array<[string, RequestInit | undefined]> => [
      [`/api/projects/${id}`, undefined],
      [`/api/projects/${id}/trace`, undefined],
      [`/api/projects/${id}/events`, undefined],
      [`/api/projects/${id}/messages`, json({ text: "привіт" })],
      [`/api/projects/${id}/commands`, json({ type: "retry" })],
      [`/api/projects/${id}/uploads`, { method: "POST", body: form({ photos: photo() }) }],
    ];
    const missing = routes("doesNotExist1");
    for (const [i, [path, init]] of routes(foreign).entries()) {
      const res = await env.request(path, init);
      expect(res.status, path).toBe(404);
      const body = await res.json();
      expect(body).toEqual({ error: "not_found", message: "Проєкт не знайдено." });
      const [missingPath, missingInit] = missing[i] as [string, RequestInit | undefined];
      const ghost = await env.request(missingPath, missingInit);
      expect(ghost.status).toBe(404);
      expect(await ghost.json()).toEqual(body);
    }
    // Нічого не поставлено в чергу, нічого не дописано в стрім і в uploads чужого проєкту.
    expect(env.queue.pipeline.length).toBe(jobs);
    expect(await readEvents(env.redis, foreign)).toHaveLength(eventsBefore);
    const intake = await env.storage.readJson(intakeKey(foreign), (v) => IntakeFile.parse(v));
    expect(await env.storage.list(projectPaths(foreign).uploadsDir)).toEqual(intake.photos);
  });

  it("безхазяйний (без ownerId) не бачить звичайний користувач, бачить admin; admin бачить чужі", async () => {
    const { env, foreign } = await world();
    expect((await env.request("/api/projects/legacy")).status).toBe(404);
    expect((await env.request("/api/projects/legacy/trace")).status).toBe(404);
    const admin = await seedUser(env, { email: "admin@example.com", admin: true });
    expect((await admin.request("/api/projects/legacy")).status).toBe(200);
    expect((await admin.request("/api/projects/legacy/trace")).status).toBe(200);
    const res = await admin.request(`/api/projects/${foreign}`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { id: string }).id).toBe(foreign);
  });

  it("свій — 200, власник із project.json (після оркестратора) теж рахується", async () => {
    const { env, own } = await world();
    expect((await env.request(`/api/projects/${own}`)).status).toBe(200);
    await env.storage.writeJson(
      projectPaths(own).project,
      fixtureProject({ id: own, ownerId: env.user?.id, status: "awaiting_brand" }),
    );
    const res = await env.request(`/api/projects/${own}`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe("awaiting_brand");
    expect((await env.request(`/api/projects/${own}/messages`, json({ text: "ок" }))).status).toBe(202);
  });
});

describe("POST /api/projects — списання на старті", () => {
  it("успіх: intake з ownerId, леджер video:<id> з balanceAfter, індекс projects.jsonl, balance у відповіді", async () => {
    const env = await setup({}, { user: { credits: 25 } });
    const uid = env.user?.id as string;
    const res = await post(env.request);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; chatUrl: string; balance: number };
    expect(body).toEqual({ id: body.id, chatUrl: `/?project=${body.id}`, balance: 25 - PRICE });

    const intake = await env.storage.readJson(intakeKey(body.id), (v) => IntakeFile.parse(v));
    expect(intake.ownerId).toBe(uid);

    const [entry] = await env.accounts.readLedger(uid, { limit: 1 });
    expect(entry).toMatchObject({
      id: `video:${body.id}`,
      kind: "charge",
      credits: -PRICE,
      balanceAfter: 25 - PRICE,
      ref: { projectId: body.id },
      note: "Відео",
    });
    expect(await env.accounts.listProjectIds(uid)).toEqual([body.id]);
    const index = await env.storage.read(accountPaths.projects(uid));
    expect(JSON.parse(String(index).trim())).toEqual({ projectId: body.id, createdAt: NOW.toISOString() });

    // Другий проєкт списує ще раз.
    const second = await post(env.request, { url: "https://second.example.com" });
    expect(second.status).toBe(201);
    const secondBody = (await second.json()) as { id: string; balance: number };
    expect(secondBody.balance).toBe(25 - 2 * PRICE);
    expect(await env.accounts.balance(uid)).toBe(25 - 2 * PRICE);
    expect(await env.accounts.listProjectIds(uid)).toEqual([secondBody.id, body.id]);
    const ledger = await env.accounts.readLedger(uid);
    expect(ledger.filter((e) => e.kind === "charge").map((e) => e.id)).toEqual([
      `video:${secondBody.id}`,
      `video:${body.id}`,
    ]);
  });

  it("402 при балансі < ціни: жодної теки, джоби, ехо; тіло з required/available", async () => {
    const env = await setup({}, { user: { credits: PRICE - 1 } });
    const res = await post(env.request, { photos: photo() });
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({
      error: "insufficient_credits",
      message: t("insufficientCredits", { need: PRICE, have: PRICE - 1 }),
      required: PRICE,
      available: PRICE - 1,
    });
    expect(await env.storage.listDirs("projects")).toEqual([]);
    expect(env.queue.pipeline).toHaveLength(0);
    expect(await env.accounts.balance(env.user?.id as string)).toBe(PRICE - 1);
    expect(await env.accounts.listProjectIds(env.user?.id as string)).toEqual([]);
  });

  it("баланс рівно ціна → 201 з balance 0, наступний → 402 з available 0", async () => {
    const env = await setup({}, { user: { credits: PRICE } });
    const ok = await post(env.request);
    expect(ok.status).toBe(201);
    expect(((await ok.json()) as { balance: number }).balance).toBe(0);
    const no = await post(env.request);
    expect(no.status).toBe(402);
    expect(await no.json()).toMatchObject({ required: PRICE, available: 0 });
    expect(await env.storage.listDirs("projects")).toHaveLength(1);
  });

  it("помилки валідації не списують", async () => {
    const env = await setup({}, { user: { credits: 100 } });
    expect((await post(env.request, { url: "  " })).status).toBe(400);
    expect((await post(env.request, { url: "https://www.instagram.com/x/" })).status).toBe(422);
    expect((await post(env.request, { url: "http://127.0.0.1/" })).status).toBe(422);
    const photos = Array.from({ length: 11 }, (_, i) => photo(`p${i}.jpg`));
    expect((await post(env.request, { photos })).status).toBe(400);
    expect(await env.accounts.balance(env.user?.id as string)).toBe(100);
    expect(await env.accounts.readLedger(env.user?.id as string)).toHaveLength(1); // лише seed-бонус
  });

  it("збій після списання → refund:<id>, баланс повернуто, 500", async () => {
    const env = await setup({}, { user: { credits: 100 } });
    const uid = env.user?.id as string;
    vi.spyOn(env.queue, "enqueuePipeline").mockRejectedValueOnce(new Error("redis down"));
    const res = await post(env.request);
    expect(res.status).toBe(500);
    expect(await env.accounts.balance(uid)).toBe(100);
    const [refund, charge] = await env.accounts.readLedger(uid);
    expect(charge?.id).toMatch(/^video:/);
    const projectId = charge?.ref.projectId;
    expect(refund).toMatchObject({
      id: `refund:${projectId}`,
      kind: "refund",
      credits: PRICE,
      balanceAfter: 100,
    });
  });
});

describe("GET /api/projects — лише свої; admin ?all=1 — усі", () => {
  type Row = { id: string; ownerId: string | null; chatUrl: string };
  const ids = async (res: Response) => ((await res.json()) as { projects: Row[] }).projects.map((p) => p.id);

  it("користувач бачить лише свої (без чужих і безхазяйних), рядок містить ownerId", async () => {
    const { env, own, other, foreign } = await world();
    const res = await env.request("/api/projects");
    expect(res.status).toBe(200);
    const { projects } = (await res.json()) as { projects: Row[] };
    expect(projects).toEqual([
      expect.objectContaining({ id: own, ownerId: env.user?.id, chatUrl: `/?project=${own}` }),
    ]);
    // ?all=1 для не-admin нічого не змінює.
    expect(await ids(await env.request("/api/projects?all=1"))).toEqual([own]);
    expect(await ids(await other.request("/api/projects"))).toEqual([foreign]);
  });

  it("неіснуючі id з індексу пропускаються", async () => {
    const { env, own } = await world();
    await env.accounts.addProject(env.user?.id as string, "ghostProject1", NOW.toISOString());
    expect(await ids(await env.request("/api/projects"))).toEqual([own]);
  });

  it("admin: без all — свої (порожньо), з ?all=1 — усі, включно з безхазяйними", async () => {
    const { env, own, foreign } = await world();
    const admin = await seedUser(env, { email: "admin@example.com", admin: true });
    expect(await ids(await admin.request("/api/projects"))).toEqual([]);
    const all = await admin.request("/api/projects?all=1");
    const rows = ((await all.json()) as { projects: Row[] }).projects;
    expect(rows.map((r) => r.id).sort()).toEqual([foreign, "legacy", own].sort());
    expect(rows.find((r) => r.id === "legacy")?.ownerId).toBeNull();
  });
});
