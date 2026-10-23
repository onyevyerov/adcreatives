import {
  makeCommandJobId,
  type PipelineJob,
  type ProjectState,
  projectPaths,
  readEvents,
  t,
} from "@adc/shared";
import { fixtureBrandKitFile, fixtureProject } from "@adc/shared/fixtures";
import { describe, expect, it } from "vitest";
import { IntakeFile, intakeKey } from "../src/intake.ts";
import { type Env, form, json, NOW, photo, setup } from "./helpers.ts";

const commands = (pipeline: PipelineJob[]) =>
  pipeline.flatMap((j) => (j.kind === "command" ? [j.command] : []));

/** Користувач із запасом кредитів на кілька стартів проєкту. */
const funded = () => setup({}, { user: { credits: 100 } });

async function createProject(env: Env, fields = {}) {
  const res = await env.request("/api/projects", {
    method: "POST",
    body: form({ url: "https://zerno.example.com", ...fields }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

describe("POST /api/projects", () => {
  it("створює проєкт з URL і фото: intake.json, uploads/, команда start, ехо в чат", async () => {
    const env = await funded();
    const res = await env.request("/api/projects", {
      method: "POST",
      body: form({ url: "zerno.example.com/menu", photos: [photo("кава 1.jpg"), photo("b.HEIC", 64)] }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; chatUrl: string; balance: number };
    expect(body.id).toMatch(/^[A-Za-z0-9_-]{21}$/);
    expect(body.chatUrl).toBe(`/?project=${body.id}`);
    expect(body.balance).toBe(100 - env.config.credits.prices.video);

    const intake = await env.storage.readJson(intakeKey(body.id), (v) => IntakeFile.parse(v));
    expect(intake).toMatchObject({
      projectId: body.id,
      createdAt: NOW.toISOString(),
      origin: "chat",
      input: { kind: "site", url: "https://zerno.example.com/menu", manualText: null },
    });
    expect(intake.photos).toHaveLength(2);
    for (const key of intake.photos) {
      expect(key.startsWith(`${projectPaths(body.id).uploadsDir}/`)).toBe(true);
      expect(await env.storage.exists(key)).toBe(true);
    }
    expect(intake.photos[0]).toMatch(/-кава-1\.jpg$/);
    expect(intake.photos[1]).toMatch(/-b\.heic$/);

    // API не пише project.json — це робить оркестратор.
    expect(await env.storage.exists(projectPaths(body.id).project)).toBe(false);

    expect(env.queue.pipeline).toHaveLength(1);
    const [cmd] = commands(env.queue.pipeline);
    expect(cmd).toMatchObject({ projectId: body.id, type: "start", issuedAt: NOW.toISOString() });
    expect(cmd?.commandId).toBe(intake.startCommandId);

    const events = await readEvents(env.redis, body.id);
    expect(events).toHaveLength(1);
    const echo = events[0]?.event;
    expect(echo?.type === "message" && echo.role === "user").toBe(true);
    expect(echo?.type === "message" ? echo.text : "").toContain("https://zerno.example.com/menu");
  });

  it("ручний режим: лише текст → input.kind = manual", async () => {
    const env = await funded();
    const res = await env.request("/api/projects", {
      method: "POST",
      body: form({ manualText: "Кав'ярня «Зерно», Львів. Капучино 65 грн." }),
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const intake = await env.storage.readJson(intakeKey(id), (v) => IntakeFile.parse(v));
    expect(intake.input).toEqual({
      kind: "manual",
      url: null,
      manualText: "Кав'ярня «Зерно», Львів. Капучино 65 грн.",
    });
    expect(intake.photos).toEqual([]);
  });

  it("приймає JSON без фото", async () => {
    const env = await funded();
    const res = await env.request("/api/projects", json({ url: "https://zerno.example.com/" }));
    expect(res.status).toBe(201);
  });

  it.each([
    ["https://www.instagram.com/zerno.coffee/", "social"],
    ["t.me/zerno", "social"],
    ["https://rozetka.com.ua/ua/shop/zerno/", "marketplace"],
    ["https://www.amazon.de/dp/B000", "marketplace"],
  ])("соцмережа/маркетплейс %s → дружня відмова, краулер не стартує", async (url, kind) => {
    const env = await funded();
    const res = await env.request("/api/projects", { method: "POST", body: form({ url }) });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; kind: string; message: string };
    expect(body).toEqual({ error: "unsupported_source", kind, message: t("needSiteOrManual") });
    expect(env.queue.pipeline).toHaveLength(0);
    expect(await env.storage.listDirs("projects")).toEqual([]);
  });

  it.each([
    ["http://127.0.0.1/", "private_address"],
    ["http://10.1.2.3:8080/admin", "private_address"],
    ["http://[::1]/", "private_address"],
    ["http://169.254.169.254/latest/meta-data/", "private_address"],
    ["http://localhost:3000/", "blocked_host"],
    ["http://metadata.google.internal/", "blocked_host"],
    ["https://intranet.example.com/", "private_address"],
    ["https://nxdomain.example.com/", "dns"],
    ["ftp://example.com/file", "protocol"],
    ["https://user:pass@example.com/", "credentials"],
  ])("небезпечна адреса %s → 422 (%s)", async (url, reason) => {
    const env = await funded();
    const res = await env.request("/api/projects", { method: "POST", body: form({ url }) });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; reason: string; message: string };
    expect(body.error).toBe("unsafe_url");
    expect(body.reason).toBe(reason);
    expect(body.message).toMatch(/^Не можу відкрити цю адресу: /);
    expect(env.queue.pipeline).toHaveLength(0);
    expect(await env.storage.listDirs("projects")).toEqual([]);
  });

  it("порожній запит → 400", async () => {
    const env = await funded();
    const res = await env.request("/api/projects", { method: "POST", body: form({ url: "  " }) });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("empty_input");
  });

  it("понад 10 фото → 400, нічого не створено", async () => {
    const env = await funded();
    const photos = Array.from({ length: 11 }, (_, i) => photo(`p${i}.jpg`));
    const res = await env.request("/api/projects", {
      method: "POST",
      body: form({ url: "https://zerno.example.com", photos }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("too_many_files");
    expect(await env.storage.listDirs("projects")).toEqual([]);
  });

  it("порожня частина input file ігнорується", async () => {
    const env = await funded();
    const id = await createProject(env, { photos: new File([], "", { type: "application/octet-stream" }) });
    const intake = await env.storage.readJson(intakeKey(id), (v) => IntakeFile.parse(v));
    expect(intake.photos).toEqual([]);
  });
});

describe("GET /api/projects[/:id]", () => {
  it("до project.json віддає стан intake, після — стан оркестратора; список і trace", async () => {
    const env = await funded();
    const id = await createProject(env);

    let res = await env.request(`/api/projects/${id}`);
    expect(res.status).toBe(200);
    let body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ id, status: "intake", project: null, totalUsd: 0 });
    expect(body.intake).toMatchObject({ projectId: id });

    // Оркестратор створив project.json.
    await env.storage.writeJson(
      projectPaths(id).project,
      fixtureProject({ id, status: "awaiting_brand", createdAt: NOW.toISOString() }),
    );
    res = await env.request(`/api/projects/${id}`);
    body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("awaiting_brand");
    expect(body.project).toMatchObject({ id, status: "awaiting_brand" });

    res = await env.request("/api/projects");
    const list = (await res.json()) as { projects: Array<{ id: string; status: string }> };
    expect(list.projects).toEqual([
      expect.objectContaining({ id, status: "awaiting_brand", chatUrl: `/?project=${id}` }),
    ]);

    await env.storage.append(
      projectPaths(id).trace,
      JSON.stringify({
        projectId: id,
        rev: 1,
        stage: "crawl",
        attempt: 1,
        phase: "first_delivery",
        jobId: null,
        startedAt: NOW.toISOString(),
        durationMs: 1500,
        ok: true,
        error: null,
        prompts: [],
      }),
    );
    res = await env.request(`/api/projects/${id}/trace`);
    expect(res.status).toBe(200);
    const trace = (await res.json()) as { totalMs: number; entries: unknown[] };
    expect(trace.totalMs).toBe(1500);
    expect(trace.entries).toHaveLength(1);
  });

  it("неіснуючий або некоректний ID → 404", async () => {
    const env = await funded();
    expect((await env.request("/api/projects/nope")).status).toBe(404);
    expect((await env.request("/api/projects/a.b")).status).toBe(404);
    expect((await env.request("/api/projects/nope/trace")).status).toBe(404);
    expect((await env.request("/api/projects/nope/messages", json({ text: "x" }))).status).toBe(404);
  });
});

describe("messages, commands, uploads", () => {
  it("повідомлення → user_message у черзі + ехо в стрім", async () => {
    const env = await funded();
    const id = await createProject(env);
    const res = await env.request(`/api/projects/${id}/messages`, json({ text: "  Зробіть 16:9  " }));
    expect(res.status).toBe(202);
    const body = (await res.json()) as { commandId: string; messageId: string; eventId: string };
    const cmd = commands(env.queue.pipeline).at(-1);
    expect(cmd).toMatchObject({ type: "user_message", text: "Зробіть 16:9", messageId: body.messageId });
    const events = await readEvents(env.redis, id);
    expect(events.at(-1)).toMatchObject({ id: body.eventId, event: { role: "user", text: "Зробіть 16:9" } });

    expect((await env.request(`/api/projects/${id}/messages`, json({ text: "   " }))).status).toBe(400);
    expect((await env.request(`/api/projects/${id}/messages`, json({ text: "x".repeat(4001) }))).status).toBe(
      400,
    );
  });

  it("команди approve | set_logo | retry | restart_confirmed з jobId за commandId", async () => {
    const env = await funded();
    const id = await createProject(env);
    const send = (body: unknown) => env.request(`/api/projects/${id}/commands`, json(body));

    expect((await send({ type: "approve", rev: 2 })).status).toBe(202);
    expect((await send({ type: "approve" })).status).toBe(202);
    expect((await send({ type: "set_logo", assetId: "a3" })).status).toBe(202);
    expect((await send({ type: "retry" })).status).toBe(202);
    expect((await send({ type: "restart_confirmed" })).status).toBe(202);

    const cmds = commands(env.queue.pipeline).slice(1);
    expect(cmds.map((c) => c.type)).toEqual(["approve", "approve", "set_logo", "retry", "restart_confirmed"]);
    expect(cmds[0]).toMatchObject({ type: "approve", rev: 2 });
    expect(cmds[1]).toMatchObject({ type: "approve", rev: null });
    expect(cmds[2]).toMatchObject({ type: "set_logo", assetId: "a3" });

    // Той самий commandId (подвійний клік) не ставиться вдруге.
    const before = env.queue.pipeline.length;
    const res = await send({ type: "approve", rev: 1, commandId: "click-12345678" });
    expect(((await res.json()) as { commandId: string }).commandId).toBe("click-12345678");
    await send({ type: "approve", rev: 1, commandId: "click-12345678" });
    expect(env.queue.pipeline.length).toBe(before + 1);
    expect(makeCommandJobId(id, "click-12345678")).toBe(`${id}.cmd.click-12345678`);
  });

  describe("approve з choices (вибір панелі ЧП1)", () => {
    async function atBrand(over: Partial<ProjectState> = {}) {
      const env = await funded();
      const id = await createProject(env);
      await env.storage.writeJson(
        projectPaths(id).project,
        fixtureProject({ id, status: "awaiting_brand", brandkitVersion: 1, ...over }),
      );
      await env.storage.writeJson(projectPaths(id).brandkit(1), fixtureBrandKitFile);
      const send = (body: unknown) => env.request(`/api/projects/${id}/commands`, json(body));
      const messages = async () =>
        (await readEvents(env.redis, id))
          .map((e) => e.event)
          .flatMap((e) => (e.type === "message" && e.role === "user" ? [e.text] : []))
          .slice(1); // перше — ехо старту
      return { env, id, send, messages };
    }

    it("1:1 + en → рядок вибору в чаті і команда з choices", async () => {
      const { env, send, messages } = await atBrand();
      const res = await send({ type: "approve", rev: 1, choices: { formats: ["square"], language: "en" } });
      expect(res.status).toBe(202);
      expect(await messages()).toEqual(["Формати: 1:1 · Мова відео: англійська"]);
      expect(await messages()).toEqual([t("choicesLine", { formats: "1:1", language: "англійська" })]);
      const cmd = commands(env.queue.pipeline).at(-1);
      expect(cmd).toMatchObject({
        type: "approve",
        rev: 1,
        choices: { formats: ["square"], language: "en" },
      });
    });

    it("лише формати → мова з проєкту, інакше з бренд-кіта; формати в канонічному порядку", async () => {
      const a = await atBrand();
      await a.send({ type: "approve", rev: null, choices: { formats: ["landscape", "vertical"] } });
      expect(await a.messages()).toEqual([
        t("choicesLine", { formats: "9:16, 16:9", language: "українська" }),
      ]);

      const b = await atBrand({ language: "en", formats: ["vertical", "square"] });
      await b.send({ type: "approve", rev: null, choices: { language: "uk" } });
      expect(await b.messages()).toEqual([
        t("choicesLine", { formats: "9:16, 1:1", language: "українська" }),
      ]);

      const c = await atBrand({ language: "en" });
      await c.send({ type: "approve", rev: null, choices: { formats: ["square"] } });
      expect(await c.messages()).toEqual([t("choicesLine", { formats: "1:1", language: "англійська" })]);
    });

    it("без choices або поза ЧП1 — повідомлення немає, команда йде як була", async () => {
      const a = await atBrand();
      await a.send({ type: "approve", rev: 1 });
      expect(await a.messages()).toEqual([]);
      expect(commands(a.env.queue.pipeline).at(-1)).not.toHaveProperty("choices");

      const b = await atBrand({ status: "awaiting_script" });
      expect((await b.send({ type: "approve", rev: 1, choices: { formats: ["square"] } })).status).toBe(202);
      expect(await b.messages()).toEqual([]);
      expect(commands(b.env.queue.pipeline).at(-1)).toMatchObject({ type: "approve" });
    });

    it("порожні формати → 400 без повідомлення", async () => {
      const { env, send, messages } = await atBrand();
      const before = env.queue.pipeline.length;
      expect((await send({ type: "approve", rev: 1, choices: { formats: [] } })).status).toBe(400);
      expect(await messages()).toEqual([]);
      expect(env.queue.pipeline.length).toBe(before);
    });
  });

  it("невідомі або некоректні команди → 400", async () => {
    const env = await funded();
    const id = await createProject(env);
    const send = (body: unknown) => env.request(`/api/projects/${id}/commands`, json(body));
    for (const body of [
      { type: "start" },
      { type: "user_message", text: "x" },
      { type: "photos_added" },
      {},
    ]) {
      const res = await send(body);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("unknown_command");
    }
    const res = await send({ type: "set_logo" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_command");
    expect((await send({ type: "approve", rev: "x" })).status).toBe(400);
    expect(commands(env.queue.pipeline)).toHaveLength(1);
  });

  it("uploads → файли в uploads/ і photos_added з ключами", async () => {
    const env = await funded();
    const id = await createProject(env);
    const res = await env.request(`/api/projects/${id}/uploads`, {
      method: "POST",
      body: form({ photos: [photo("../../evil.jpg"), photo("IMG_0001.HEIC")] }),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { files: string[] };
    expect(body.files).toHaveLength(2);
    for (const key of body.files) {
      expect(key.startsWith(`projects/${id}/uploads/`)).toBe(true);
      expect(key.split("/")).toHaveLength(4);
      expect(await env.storage.exists(key)).toBe(true);
    }
    const cmd = commands(env.queue.pipeline).at(-1);
    expect(cmd).toEqual(expect.objectContaining({ type: "photos_added", files: body.files }));

    const empty = await env.request(`/api/projects/${id}/uploads`, { method: "POST", body: form({}) });
    expect(empty.status).toBe(400);
  });
});
