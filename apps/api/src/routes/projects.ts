import {
  API_COMMAND_TYPES,
  AssetId,
  appendEvent,
  assertPublicHttpUrl,
  classifySource,
  makeCommandJobId,
  normalizeInputUrl,
  type PipelineCommand,
  readCosts,
  readTrace,
  sumUsd,
  t,
  UnsafeUrlError,
  type UnsafeUrlReason,
} from "@adc/shared";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { nanoid } from "nanoid";
import { z } from "zod";
import { MAX_MANUAL_TEXT_CHARS, MAX_MESSAGE_CHARS, MAX_UPLOAD_BODY_BYTES } from "../config.ts";
import type { ApiDeps, ApiError } from "../deps.ts";
import {
  type IntakeFile,
  intakeKey,
  isProjectId,
  listProjectIds,
  projectExists,
  readIntake,
  readProject,
} from "../intake.ts";
import {
  collectFiles,
  fieldString,
  type ParsedBody,
  saveUploads,
  UploadError,
  validateFiles,
} from "../uploads.ts";
import { sseHandler } from "./events.ts";

/** Причина відмови URL простими словами (підставляється в `uk.unsafeUrl`). */
const UNSAFE_REASON_TEXT: Record<UnsafeUrlReason, string> = {
  invalid: "некоректна адреса",
  protocol: "підтримуються лише адреси http:// і https://",
  credentials: "адреса не повинна містити логін і пароль",
  private_address: "це внутрішня або приватна адреса",
  blocked_host: "це внутрішня або службова адреса",
  dns: "такий сайт не знайдено",
};

const fail = (c: Context, status: 400 | 403 | 404 | 413 | 422, error: string, message: string) =>
  c.json<ApiError>({ error, message }, status);

const CommandId = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);

const CommandBody = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("approve"),
    rev: z.number().int().min(1).nullable().optional(),
    commandId: CommandId.optional(),
  }),
  z.object({ type: z.literal("set_logo"), assetId: AssetId, commandId: CommandId.optional() }),
  z.object({ type: z.literal("retry"), commandId: CommandId.optional() }),
  z.object({ type: z.literal("restart_confirmed"), commandId: CommandId.optional() }),
]);

const MessageBody = z.object({ text: z.string() });

/** Тіло multipart / urlencoded / JSON як плаский запис полів. */
async function readBody(c: Context): Promise<ParsedBody> {
  const type = c.req.header("content-type") ?? "";
  if (type.includes("application/json")) {
    const json: unknown = await c.req.json().catch(() => null);
    if (!json || typeof json !== "object") return {};
    const out: ParsedBody = {};
    for (const [k, v] of Object.entries(json)) if (typeof v === "string") out[k] = v;
    return out;
  }
  if (type.includes("multipart/form-data") || type.includes("application/x-www-form-urlencoded")) {
    return (await c.req.parseBody({ all: true })) as ParsedBody;
  }
  return {};
}

async function readJsonBody(c: Context): Promise<unknown> {
  const type = c.req.header("content-type") ?? "";
  if (type.includes("application/json")) return c.req.json().catch(() => null);
  if (type.includes("form")) {
    const body = (await c.req.parseBody()) as Record<string, unknown>;
    // З форми rev приходить рядком.
    if (typeof body.rev === "string") body.rev = body.rev === "" ? null : Number(body.rev);
    return body;
  }
  return null;
}

export function projectsRoutes(deps: ApiDeps): Hono {
  const { storage, queue, redis, config } = deps;
  const app = new Hono();
  const uploadLimit = bodyLimit({
    maxSize: MAX_UPLOAD_BODY_BYTES,
    onError: (c) => fail(c, 413, "body_too_large", "Забагато даних за раз: до 10 фото по 25 МБ."),
  });

  const enqueueCommand = async (command: PipelineCommand) => {
    await queue.enqueuePipeline(
      { kind: "command", command },
      { jobId: makeCommandJobId(command.projectId, command.commandId) },
    );
  };

  const echoUser = (projectId: string, text: string) =>
    appendEvent(redis, projectId, { type: "message", at: config.now().toISOString(), role: "user", text });

  // Перевірка ID і наявності проєкту для всіх маршрутів /:id/*.
  app.use("/:id/*", async (c, next) => {
    const id = c.req.param("id");
    if (!id || !(await projectExists(storage, id))) return fail(c, 404, "not_found", "Проєкт не знайдено.");
    return next();
  });

  /** Створення проєкту: URL або текст вручну + фото → intake.json + команда `start`. */
  app.post("/", uploadLimit, async (c) => {
    const body = await readBody(c);
    const rawUrl = fieldString(body.url);
    const manualText = fieldString(body.manualText);
    if (!rawUrl && !manualText) {
      return fail(c, 400, "empty_input", "Вставте адресу сайту або напишіть кілька речень про бізнес.");
    }
    if (manualText && manualText.length > MAX_MANUAL_TEXT_CHARS) {
      return fail(c, 400, "text_too_long", `Текст задовгий: до ${MAX_MANUAL_TEXT_CHARS} символів.`);
    }

    let url: string | null = null;
    if (rawUrl) {
      const normalized = normalizeInputUrl(rawUrl);
      const kind = classifySource(normalized);
      if (kind !== "site") {
        // Соцмережа / маркетплейс: краулер не стартує, проєкт не створюється.
        return c.json({ error: "unsupported_source", kind, message: t("needSiteOrManual") }, 422);
      }
      try {
        url = (await assertPublicHttpUrl(normalized, config.resolve ? { resolve: config.resolve } : {})).href;
      } catch (err) {
        if (err instanceof UnsafeUrlError) {
          return c.json(
            {
              error: "unsafe_url",
              reason: err.reason,
              message: t("unsafeUrl", { reason: UNSAFE_REASON_TEXT[err.reason] }),
            },
            422,
          );
        }
        throw err;
      }
    }

    const files = collectFiles(body);
    try {
      validateFiles(files);
    } catch (err) {
      if (err instanceof UploadError) return fail(c, 400, err.code, err.message);
      throw err;
    }

    const projectId = nanoid();
    const commandId = nanoid();
    const issuedAt = config.now().toISOString();
    const photos = await saveUploads(storage, projectId, files);
    const intake: IntakeFile = {
      projectId,
      createdAt: issuedAt,
      origin: "chat",
      input: { kind: url ? "site" : "manual", url, manualText },
      photos,
      startCommandId: commandId,
    };
    await storage.writeJson(intakeKey(projectId), intake);
    const echo = [url ?? manualText ?? "", photos.length > 0 ? `Фото: ${photos.length}` : ""]
      .filter(Boolean)
      .join("\n");
    await echoUser(projectId, echo);
    await enqueueCommand({ projectId, commandId, issuedAt, type: "start" });
    return c.json({ id: projectId, chatUrl: `/?project=${projectId}` }, 201);
  });

  app.get("/", async (c) => {
    const out = [];
    for (const id of await listProjectIds(storage)) {
      const project = await readProject(storage, id);
      const intake = project ? null : await readIntake(storage, id);
      if (!project && !intake) continue;
      out.push({
        id,
        createdAt: project?.createdAt ?? intake?.createdAt ?? null,
        status: project?.status ?? "intake",
        site: (project?.input ?? intake?.input)?.url ?? null,
        formats: project?.formats ?? [],
        totalUsd: sumUsd(await readCosts(storage, id)),
        chatUrl: `/?project=${id}`,
      });
    }
    out.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
    return c.json({ projects: out });
  });

  app.get("/:id", async (c) => {
    const id = c.req.param("id");
    if (!isProjectId(id)) return fail(c, 404, "not_found", "Проєкт не знайдено.");
    const project = await readProject(storage, id);
    const intake = await readIntake(storage, id);
    if (!project && !intake) return fail(c, 404, "not_found", "Проєкт не знайдено.");
    return c.json({
      id,
      status: project?.status ?? "intake",
      project,
      intake,
      totalUsd: sumUsd(await readCosts(storage, id)),
    });
  });

  app.get("/:id/trace", async (c) => {
    const id = c.req.param("id");
    const entries = await readTrace(storage, id);
    return c.json({ projectId: id, totalMs: entries.reduce((a, e) => a + e.durationMs, 0), entries });
  });

  app.get("/:id/events", sseHandler(deps));

  app.post("/:id/messages", async (c) => {
    const projectId = c.req.param("id");
    const parsed = MessageBody.safeParse(await readJsonBody(c));
    const text = parsed.success ? parsed.data.text.trim() : "";
    if (!text) return fail(c, 400, "empty_message", "Порожнє повідомлення.");
    if (text.length > MAX_MESSAGE_CHARS) {
      return fail(c, 400, "message_too_long", `Повідомлення задовге: до ${MAX_MESSAGE_CHARS} символів.`);
    }
    const messageId = nanoid();
    const commandId = nanoid();
    const eventId = await echoUser(projectId, text);
    await enqueueCommand({
      projectId,
      commandId,
      issuedAt: config.now().toISOString(),
      type: "user_message",
      text,
      messageId,
    });
    return c.json({ commandId, messageId, eventId }, 202);
  });

  app.post("/:id/commands", async (c) => {
    const projectId = c.req.param("id");
    const raw = await readJsonBody(c);
    const parsed = CommandBody.safeParse(raw);
    if (!parsed.success) {
      const type = (raw as { type?: unknown } | null)?.type;
      const known = (API_COMMAND_TYPES as readonly unknown[]).includes(type);
      return fail(
        c,
        400,
        known ? "invalid_command" : "unknown_command",
        known
          ? "Некоректні параметри команди."
          : `Невідома команда. Дозволено: ${API_COMMAND_TYPES.join(", ")}.`,
      );
    }
    const body = parsed.data;
    const commandId = body.commandId ?? nanoid();
    const base = { projectId, commandId, issuedAt: config.now().toISOString() };
    let command: PipelineCommand;
    switch (body.type) {
      case "approve":
        command = { ...base, type: "approve", rev: body.rev ?? null };
        break;
      case "set_logo":
        command = { ...base, type: "set_logo", assetId: body.assetId };
        break;
      case "retry":
        command = { ...base, type: "retry" };
        break;
      case "restart_confirmed":
        command = { ...base, type: "restart_confirmed" };
        break;
    }
    await enqueueCommand(command);
    return c.json({ commandId }, 202);
  });

  app.post("/:id/uploads", uploadLimit, async (c) => {
    const projectId = c.req.param("id");
    const files = collectFiles(await readBody(c));
    if (files.length === 0) return fail(c, 400, "no_files", "Оберіть хоча б одне фото.");
    try {
      validateFiles(files);
    } catch (err) {
      if (err instanceof UploadError) return fail(c, 400, err.code, err.message);
      throw err;
    }
    const keys = await saveUploads(storage, projectId, files);
    const commandId = nanoid();
    await echoUser(projectId, `Додаю фото: ${files.map((f) => f.name).join(", ")}`);
    await enqueueCommand({
      projectId,
      commandId,
      issuedAt: config.now().toISOString(),
      type: "photos_added",
      files: keys,
    });
    return c.json({ commandId, files: keys }, 202);
  });

  return app;
}
