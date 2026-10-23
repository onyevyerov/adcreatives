import {
  API_COMMAND_TYPES,
  AssetId,
  appendEvent,
  assertPublicHttpUrl,
  classifySource,
  Format,
  InsufficientCreditsError,
  Language,
  type LedgerEntry,
  makeCommandJobId,
  noopLogger,
  normalizeInputUrl,
  type PipelineCommand,
  type PublicUser,
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
  canSee,
  type IntakeFile,
  intakeKey,
  isProjectId,
  listProjectIds,
  projectExists,
  projectOwner,
  readIntake,
  readProject,
} from "../intake.ts";
import { type AppEnv, requireUser } from "../session.ts";
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

const fail = (c: Context, status: 400 | 401 | 402 | 403 | 404 | 413 | 422, error: string, message: string) =>
  c.json<ApiError>({ error, message }, status);

const notFound = (c: Context) => fail(c, 404, "not_found", "Проєкт не знайдено.");

const CommandId = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);

const CommandBody = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("approve"),
    rev: z.number().int().min(1).nullable().optional(),
    choices: z
      .object({
        formats: z.array(Format).min(1).optional(),
        language: Language.optional(),
      })
      .optional(),
    commandId: CommandId.optional(),
  }),
  z.object({ type: z.literal("set_logo"), assetId: AssetId, commandId: CommandId.optional() }),
  z.object({ type: z.literal("retry"), commandId: CommandId.optional() }),
  z.object({ type: z.literal("restart_confirmed"), commandId: CommandId.optional() }),
]);

const MessageBody = z.object({ text: z.string() });

/** Витрати кредитів по проєкту (N5 «оплачено», N12 — розбивка в кабінеті). */
export interface ProjectCredits {
  /** Сума модулів charge. */
  charged: number;
  /** Сума refund. */
  refunded: number;
  /** Від старіших до новіших; credits зі знаком леджера (charge < 0, refund > 0). */
  parts: {
    kind: "video" | "revision" | "format" | "refund";
    credits: number;
    format?: Format;
    rev?: number;
  }[];
}

/** Записи леджера власника з `ref.projectId === projectId`; `entries` — як з `readLedger` (новіші першими). */
export function projectCredits(entries: readonly LedgerEntry[], projectId: string): ProjectCredits {
  const out: ProjectCredits = { charged: 0, refunded: 0, parts: [] };
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (!e || e.ref.projectId !== projectId) continue;
    if (e.kind === "refund") {
      out.refunded += e.credits;
      out.parts.push({ kind: "refund", credits: e.credits });
    } else if (e.kind === "charge") {
      out.charged += Math.abs(e.credits);
      const { format, rev } = e.ref;
      if (format !== undefined) out.parts.push({ kind: "format", credits: e.credits, format });
      else if (rev !== undefined) out.parts.push({ kind: "revision", credits: e.credits, rev });
      else out.parts.push({ kind: "video", credits: e.credits });
    }
  }
  return out;
}

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

/** Користувач сесії; маршрути нижче стоять за `requireUser()`, тож null тут — помилка монтування. */
function currentUser(c: Context<AppEnv>): PublicUser {
  const user = c.get("user");
  if (!user) throw new Error("projectsRoutes: немає користувача — requireUser() не спрацював");
  return user;
}

export function projectsRoutes(deps: ApiDeps): Hono<AppEnv> {
  const { storage, queue, redis, config, accounts } = deps;
  const logger = deps.logger ?? noopLogger;
  const app = new Hono<AppEnv>();
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

  /**
   * Проєкт існує і поточний користувач його бачить. Чужий і неіснуючий — однаково false,
   * щоб відповідь (404) не видавала існування чужого проєкту.
   */
  const visible = async (c: Context<AppEnv>, id: string | undefined): Promise<boolean> => {
    if (!id || !(await projectExists(storage, id))) return false;
    return canSee(currentUser(c), await projectOwner(storage, id));
  };

  // Усе під /api/projects — лише для користувачів із сесією.
  app.use("*", requireUser());

  // Перевірка ID, наявності й доступу для всіх маршрутів /:id/*.
  app.use("/:id/*", async (c, next) => {
    if (!(await visible(c, c.req.param("id")))) return notFound(c);
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

    const user = currentUser(c);
    const projectId = nanoid();
    const commandId = nanoid();
    const issuedAt = config.now().toISOString();
    const price = config.credits.prices.video;

    // Списання — до будь-якого запису: без кредитів не з'являється ні тека проєкту, ні джоба.
    let balance: number;
    try {
      const { entry } = await accounts.apply(user.id, {
        id: `video:${projectId}`,
        kind: "charge",
        credits: -price,
        ref: { projectId },
        note: "Відео",
      });
      balance = entry.balanceAfter;
    } catch (err) {
      if (err instanceof InsufficientCreditsError) {
        return c.json(
          {
            error: "insufficient_credits",
            message: t("insufficientCredits", { need: err.required, have: err.available }),
            required: err.required,
            available: err.available,
          },
          402,
        );
      }
      throw err;
    }

    try {
      const photos = await saveUploads(storage, projectId, files);
      const intake: IntakeFile = {
        projectId,
        createdAt: issuedAt,
        origin: "chat",
        input: { kind: url ? "site" : "manual", url, manualText },
        photos,
        startCommandId: commandId,
        ownerId: user.id,
      };
      await storage.writeJson(intakeKey(projectId), intake);
      await accounts.addProject(user.id, projectId, issuedAt);
      const echo = [url ?? manualText ?? "", photos.length > 0 ? `Фото: ${photos.length}` : ""]
        .filter(Boolean)
        .join("\n");
      await echoUser(projectId, echo);
      await enqueueCommand({ projectId, commandId, issuedAt, type: "start" });
    } catch (err) {
      // Проєкт не стартував — повертаємо списане (best-effort: збій повернення лише логуємо).
      if (price > 0) {
        await accounts
          .apply(user.id, {
            id: `refund:${projectId}`,
            kind: "refund",
            credits: price,
            ref: { projectId },
            note: "Повернення: проєкт не створено",
          })
          .catch((refundErr: unknown) =>
            logger.error("не вдалося повернути кредити", {
              projectId,
              userId: user.id,
              error: String(refundErr),
            }),
          );
      }
      throw err;
    }
    return c.json({ id: projectId, chatUrl: `/?project=${projectId}`, balance }, 201);
  });

  app.get("/", async (c) => {
    const user = currentUser(c);
    const all = user.isAdmin && c.req.query("all") === "1";
    const ids = all ? await listProjectIds(storage) : await accounts.listProjectIds(user.id);
    // Один readLedger на власника за запит, а не на рядок.
    const ledgers = new Map<string, Promise<LedgerEntry[]>>();
    const ledgerOf = (ownerId: string) => {
      let ledger = ledgers.get(ownerId);
      if (!ledger) {
        ledger = accounts.readLedger(ownerId);
        ledgers.set(ownerId, ledger);
      }
      return ledger;
    };
    const out = [];
    for (const id of ids) {
      if (!isProjectId(id)) continue;
      const project = await readProject(storage, id);
      const intake = project ? null : await readIntake(storage, id);
      // Неіснуючі (або биті) id з індексу пропускаються.
      if (!project && !intake) continue;
      const ownerId = await projectOwner(storage, id);
      if (!canSee(user, ownerId)) continue;
      out.push({
        id,
        ownerId,
        createdAt: project?.createdAt ?? intake?.createdAt ?? null,
        status: project?.status ?? "intake",
        site: (project?.input ?? intake?.input)?.url ?? null,
        formats: project?.formats ?? [],
        totalUsd: sumUsd(await readCosts(storage, id)),
        credits: ownerId ? projectCredits(await ledgerOf(ownerId), id) : null,
        chatUrl: `/?project=${id}`,
      });
    }
    out.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
    return c.json({ projects: out });
  });

  app.get("/:id", async (c) => {
    const id = c.req.param("id");
    if (!isProjectId(id)) return notFound(c);
    const project = await readProject(storage, id);
    const intake = await readIntake(storage, id);
    if (!project && !intake) return notFound(c);
    const ownerId = await projectOwner(storage, id);
    if (!canSee(currentUser(c), ownerId)) return notFound(c);
    return c.json({
      id,
      status: project?.status ?? "intake",
      project,
      intake,
      totalUsd: sumUsd(await readCosts(storage, id)),
      credits: ownerId ? projectCredits(await accounts.readLedger(ownerId), id) : null,
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
        command = {
          ...base,
          type: "approve",
          rev: body.rev ?? null,
          ...(body.choices ? { choices: body.choices } : {}),
        };
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
