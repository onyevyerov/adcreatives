import {
  addVersion,
  assetsForPrompt,
  baseRevOf,
  brandForCode,
  type CodegenContext,
  carryScene,
  contextVars,
  currentVersion,
  directorPaths,
  formatsOf,
  llmStageError,
  loadCodegenContext,
  progress,
  readAssets,
  readCurrentBrandKit,
  readCurrentCode,
  readLedger,
  readOptional,
  readProject,
  readStoryboard,
  readTemplateScenes,
  rejectedScenes,
  typecheckScenes,
  writeLedger,
  writeScenesIndex,
} from "@adc/director";
import {
  inputsHash,
  LlmError,
  RevisionPlan,
  readTuning,
  revPaths,
  type Stage,
  type StageContext,
  StageError,
  type Storage,
  type Tuning,
} from "@adc/shared";
import { z } from "zod";
import { authorLimits, budgetText, createDeadline, stopReason } from "./budget.ts";
import { type AuthorSession, closeEngine, type EngineSource } from "./session.ts";
import { authorTools, type IterationInfo } from "./tools/index.ts";
import { unfinishedTargets } from "./tools/meta.ts";

export const AUTHOR_PROMPT = "author";

export const AuthorReport = z.object({
  sceneIds: z.array(z.string()),
  carried: z.array(z.string()),
  written: z.array(z.string()),
  missing: z.array(z.string()),
  iterations: z.number().int(),
  renders: z.number().int(),
  usd: z.number(),
  stoppedBy: z.enum(["done", "budget", "iterations", "time"]),
  finished: z.boolean(),
  summary: z.string().nullable(),
  durationMs: z.number().int(),
});
export type AuthorReport = z.infer<typeof AuthorReport>;

export function authorReportKey(projectId: string, rev: number): string {
  return `${directorPaths(projectId, rev).root}/author/report.json`;
}

export interface AuthorStageDeps {
  /** Рушій рендеру або фабрика; дефолт — Remotion з `@adc/render` (створюється при першому рендері). */
  engine?: EngineSource;
  /** Контекст промпта (дефолт — vendor + motion-kit з диска, як у codegen). */
  context?: () => CodegenContext;
  /** Перемикачі й бюджети; дефолт — `readTuning()` з env на кожен запуск. */
  tuning?: () => Tuning;
  now?: () => Date;
}

const defaultEngine: EngineSource = async () => (await import("@adc/render")).createRenderEngine();

/**
 * Інструкції правок по сценах — як у codegen: пер-сценні інструкції з `director/revision.json`
 * (RevisionPlan стадії revise) мають пріоритет над params.
 */
async function instructionsFor(
  storage: Storage,
  projectId: string,
  rev: number,
  params: StageContext<"author">["params"],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const record = await readOptional(storage, directorPaths(projectId, rev).revision, (v) =>
    z.object({ scenesToRegenerate: RevisionPlan.shape.scenesToRegenerate }).parse(v),
  );
  for (const s of params.instructions) map.set(s.sceneId, s.instruction);
  for (const s of record?.scenesToRegenerate ?? []) map.set(s.sceneId, s.instruction);
  return map;
}

/** Поточний код сцен ревізії як `<file>`-блоки (позначка «yours» — ціль цього запуску). */
async function currentScenesText(session: AuthorSession): Promise<string> {
  const { ctx } = session;
  const blocks: string[] = [];
  for (const id of session.allIds) {
    if (session.templates.has(id)) continue;
    const ver = currentVersion(session.ledger, id);
    const code = await readCurrentCode(ctx.storage, ctx.projectId, ctx.rev, session.ledger, id);
    if (!code) continue;
    const role = session.targets.includes(id) ? "yours" : "read-only";
    const state = ver && !ver.guardOk ? ' guard="rejected"' : "";
    const types = session.existingTypeErrors.get(id)?.length ? ' compiles="no"' : "";
    blocks.push(`<file name="${id}.tsx" role="${role}"${state}${types}>\n${code.trim()}\n</file>`);
  }
  return blocks.join("\n\n");
}

/**
 * Стадія `author` (агентний режим, `ADC_GENERATION_MODE=agent`): один агент робить те, що
 * codegen → check → qa → fix, одним циклом з інструментами — пише сцени (`write_scene`: guard +
 * типи + журнал версій), рендерить і дивиться їх (`render_strip`, `render_frames`, `contact_sheet`),
 * читає звукові події (`audio_events`) і завершує (`finish`). Бюджет — `Tuning.author*`.
 *
 * - `params.sceneIds = null` — усі сцени; інакше — лише ці (решта тільки для читання). Код сцен, якого
 *   ще немає в ревізії, спершу переноситься з ревізії-основи: агент бачить поточний код і править його.
 * - Повторна спроба після збою продовжує з коду, вже записаного в журнал цієї ревізії.
 * - Зупинка без `finish` (бюджет, ітерації, час): цільові сцени без коду записуються як `missing`
 *   (як у codegen), сцени з помилками guard лишаються відхиленими — далі `check` → `fix`.
 * Артефакти — ті самі ключі, що в codegen (`video/scenes/*.tsx`, `director/scenes.json`,
 * `director/versions/**`), плюс `director/author/{log.jsonl,report.json}` і аркуші рендерів агента.
 */
export function createAuthorStage(deps: AuthorStageDeps = {}): Stage<"author"> {
  const now = deps.now ?? (() => new Date());
  const getContext = deps.context ?? (() => loadCodegenContext());
  const getTuning = deps.tuning ?? (() => readTuning());
  return async (ctx) => {
    const started = Date.now();
    const { storage, projectId, rev, params, logger } = ctx;
    const project = await readProject(storage, projectId);
    const brandFile = await readCurrentBrandKit(storage, projectId, project);
    const storyboard = await readStoryboard(storage, projectId, rev);
    const manifest = await readAssets(storage, projectId);
    const formats = formatsOf(project);
    const templates = new Set(await readTemplateScenes(storage, projectId, rev));
    const ledger = await readLedger(storage, projectId, rev);
    const instructions = await instructionsFor(storage, projectId, rev, params);
    const limits = authorLimits(getTuning());
    const allIds = storyboard.scenes.map((s) => s.id);

    let targets: string[];
    if (params.sceneIds === null) {
      targets = [...allIds];
    } else {
      targets = params.sceneIds.filter((id) => allIds.includes(id));
      const unknown = params.sceneIds.filter((id) => !allIds.includes(id));
      if (unknown.length) logger.warn("author: невідомі сцени пропущено", { unknown });
    }
    targets = targets.filter((id) => !templates.has(id));

    const session: AuthorSession = {
      ctx,
      project,
      brandFile,
      storyboard,
      manifest,
      formats,
      templates,
      allIds,
      targets,
      ledger,
      written: new Map(),
      existingTypeErrors: new Map(),
      artifacts: new Set(),
      renders: 0,
      finished: null,
      now,
      bundle: null,
      engineSource: deps.engine ?? defaultEngine,
      engine: null,
    };

    // Код, якого ще немає в ревізії, — з ревізії-основи (агент править поточний, а не пише з нуля).
    const carried: string[] = [];
    const base = baseRevOf(project, rev);
    if (base !== null) {
      const baseLedger = await readLedger(storage, projectId, base);
      for (const id of allIds) {
        if (
          templates.has(id) ||
          ledger.scenes[id] ||
          (await storage.exists(revPaths(projectId, rev).scene(id)))
        )
          continue;
        const written = await carryScene(storage, projectId, rev, base, ledger, baseLedger, id, now(), null);
        if (written.length) {
          carried.push(id);
          for (const k of written) session.artifacts.add(k);
        }
      }
      if (carried.length) session.artifacts.add(await writeLedger(storage, projectId, rev, ledger));
    }

    // Наявний код, що не компілюється (з попередньої спроби), не йде в бандл, доки агент його не виправить.
    const existing: Record<string, string> = {};
    for (const id of allIds) {
      if (templates.has(id) || currentVersion(ledger, id)?.guardOk === false) continue;
      const code = await readCurrentCode(storage, projectId, rev, ledger, id);
      if (code) existing[id] = code;
    }
    if (Object.keys(existing).length) {
      for (const [id, errors] of Object.entries(typecheckScenes(existing).byScene)) {
        session.existingTypeErrors.set(
          id,
          errors.map((e) => `TS${e.code}: ${e.message}`),
        );
      }
    }

    const context = getContext();
    const current = await currentScenesText(session);
    const vars = {
      ...contextVars(context, brandFile),
      mode: current ? "edit" : "film",
      targets: targets.join(", "),
      readonlyScenes: allIds.filter((id) => !targets.includes(id)).join(", ") || "(немає)",
      language: project?.language ?? brandFile.identity.language,
      formats: formats.join(", "),
      brand: brandForCode(brandFile),
      storyboard,
      assets: assetsForPrompt(brandFile, manifest),
      instructions:
        targets
          .filter((id) => instructions.has(id))
          .map((id) => `- ${id}: ${instructions.get(id)}`)
          .join("\n") || "(немає — перша генерація за розкадровкою)",
      currentScenes: current || "(немає)",
      budget: budgetText(limits),
    };

    let last: IterationInfo = { iteration: 0, usd: 0, tokens: 0 };
    const tools = authorTools(session, () => last);
    const deadline = createDeadline(limits.maxMinutes * 60_000, ctx.signal);
    await progress(ctx, "author", "Автор пише сцени…");
    let result: Awaited<ReturnType<typeof ctx.llm.agent>>;
    try {
      result = await ctx.llm.agent(AUTHOR_PROMPT, vars, {
        tools,
        maxIterations: limits.maxIterations,
        tokenBudget: limits.tokenBudget,
        costDetail: "author",
        signal: deadline.signal,
        onIteration: (info) => {
          last = { iteration: info.iteration, usd: info.usd, tokens: info.tokens };
          const done = targets.filter((id) => session.written.has(id)).length;
          void progress(
            ctx,
            "author",
            `Автор працює: крок ${info.iteration}, сцен написано ${done}/${targets.length}…`,
            done,
            targets.length,
          );
        },
      });
    } catch (err) {
      if (ctx.signal?.aborted) throw err;
      if (err instanceof LlmError) llmStageError(err, "генерація сцен");
      throw err;
    } finally {
      deadline.dispose();
      await closeEngine(session);
    }
    if (ctx.signal?.aborted) throw ctx.signal.reason ?? new Error("author: скасовано");
    const stoppedBy = stopReason(result.stoppedBy, deadline.timedOut());

    // ---------- сцени без коду — у missing (далі check → fix), як у codegen ----------
    const open = unfinishedTargets(session);
    const missing: string[] = [];
    for (const id of open) {
      const ver = currentVersion(ledger, id);
      if (ver && !ver.missing) continue; // код є, але не пройшов guard/типи — його лагодить fix
      missing.push(id);
      if (ver) continue;
      await addVersion(storage, projectId, rev, ledger, id, {
        origin: "author",
        code: null,
        guardOk: false,
        violations: ["агент не написав код сцени"],
        now: now(),
      });
    }
    if (targets.length > 0 && missing.length === targets.length) {
      throw new StageError(
        `author: агент не написав жодної сцени (${stoppedBy})`,
        "author_no_scenes",
        "Модель не написала код сцен — спробуйте ще раз.",
        true,
      );
    }
    if (open.length) logger.warn("author: сцени без робочого коду підуть у check → fix", { open, stoppedBy });

    const index = await writeScenesIndex(storage, projectId, rev, storyboard, rejectedScenes(ledger));
    session.artifacts.add(index.key);
    session.artifacts.add(await writeLedger(storage, projectId, rev, ledger));

    const usd = Math.round(result.usd * 1e6) / 1e6;
    const report: AuthorReport = {
      sceneIds: targets,
      carried,
      written: targets.filter((id) => session.written.has(id)),
      missing,
      iterations: result.iterations,
      renders: session.renders,
      usd,
      stoppedBy,
      finished: session.finished !== null,
      summary: session.finished?.summary ?? (result.text.trim() || null),
      durationMs: Date.now() - started,
    };
    const reportKey = authorReportKey(projectId, rev);
    await storage.writeJson(reportKey, AuthorReport.parse(report));
    session.artifacts.add(reportKey);
    logger.info("author: готово", { ...report, summary: undefined });

    return {
      artifacts: [...session.artifacts],
      outputs: { sceneIds: targets, iterations: result.iterations, renders: session.renders, usd, stoppedBy },
      inputsHash: inputsHash({ targets, storyboard, prompt: result.prompt.hash, context: context.hash }),
    };
  };
}

export const authorStage: Stage<"author"> = createAuthorStage();
