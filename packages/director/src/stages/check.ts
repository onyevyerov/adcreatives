import { mkdir } from "node:fs/promises";
import path from "node:path";
import { parseQaLog } from "@adc/motion-kit";
import {
  type AutoIssue,
  type BrowserLog,
  CheckReport,
  type Format,
  inputsHash,
  QaLogEntry,
  type RenderEngine,
  revPaths,
  type Stage,
  type StageContext,
  StageError,
  type StillRef,
  type Storage,
  sha256,
  stillFrames,
} from "@adc/shared";
import { z } from "zod";
import { loadCodegenContext } from "../context.ts";
import {
  baseRevOf,
  directorPaths,
  formatsOf,
  progress,
  readCurrentBrandKit,
  readOptional,
  readProject,
  readStoryboard,
  readTemplateScenes,
} from "../io.ts";
import { type PreparedJob, prepareJob, scenePreviewProps, writeScenesIndex } from "../job.ts";
import {
  carryScene,
  currentVersion,
  readLedger,
  type SceneCheckData,
  type SceneLedger,
  writeLedger,
} from "../ledger.ts";
import { buildSheet, type SheetCell } from "../sheets.ts";
import { typecheckScenes } from "../typecheck.ts";

/**
 * Стадія `check` (CPU, без LLM): типи сцен → бандл → стіли ScenePreview (50% і 90% сцени) у всіх
 * обраних форматах з QA-режимом → `autoIssues` з логів `ADC_QA` → зведені аркуші → `check.json`.
 *
 * `params.sceneIds` — які сцени знімати (null — усі). Типи перевіряються для всіх сцен (усі
 * потрапляють у бандл), записи інших сцен беруться з попереднього check.json цієї ревізії або
 * переносяться з ревізії-основи, якщо їхній хеш входів не змінився (тоді стіли копіюються).
 * Сцени з `pipeline.json → templateScenes` знімаються як TemplateScene і не вважаються помилковими.
 */

export interface CheckStageDeps {
  /** RenderEngine (B3). Екземпляр не закривається стадією; фабрика — створюється і закривається на кожен запуск. */
  engine: RenderEngine | (() => RenderEngine);
  now?: () => Date;
}

export const CheckMeta = z.object({
  /** sceneId → хеш входів стілів сцени. */
  scenes: z.record(z.string(), z.string()),
});
export type CheckMeta = z.infer<typeof CheckMeta>;

const SCENE_FILE_IN_MESSAGE = /scenes[\\/](s\d{1,2})\.tsx/g;
const MAX_BUNDLE_ATTEMPTS = 3;

function errorLogs(err: unknown): BrowserLog[] {
  const logs = (err as { logs?: unknown } | null)?.logs;
  return Array.isArray(logs) ? (logs as BrowserLog[]) : [];
}

function errorMessage(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 4000);
}

/** ADC_QA-рядки логу браузера → AutoIssue сцени. */
export function collectAutoIssues(
  logs: readonly BrowserLog[],
  sceneId: string,
  format: Format,
  frame: number,
): AutoIssue[] {
  const out: AutoIssue[] = [];
  for (const log of logs) {
    const raw = parseQaLog(log.text);
    if (!raw) continue;
    const entry = QaLogEntry.safeParse(raw);
    if (!entry.success) continue;
    out.push({ ...entry.data, frame: entry.data.frame ?? log.frame ?? frame, sceneId, format });
  }
  return out;
}

function dedupeIssues(issues: readonly AutoIssue[]): AutoIssue[] {
  const seen = new Set<string>();
  return issues.filter((i) => {
    const key = [i.sceneId, i.format, i.kind, i.component, i.detail].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function emptyReport(): CheckReport {
  return {
    compileErrors: [],
    bundleError: null,
    runtimeErrors: [],
    autoIssues: [],
    stills: [],
    sheets: [],
    durationMs: 0,
  };
}

function sceneData(report: CheckReport, sceneId: string): Omit<SceneCheckData, "checkedAt"> {
  return {
    compileErrors: report.compileErrors.filter((e) => e.sceneId === sceneId),
    runtimeErrors: report.runtimeErrors.filter((e) => e.sceneId === sceneId),
    autoIssues: report.autoIssues.filter((e) => e.sceneId === sceneId),
    stills: report.stills.filter((e) => e.sceneId === sceneId),
  };
}

/** Замінює в звіті записи сцени (крім compileErrors, якщо withCompile=false). */
export function replaceSceneData(
  report: CheckReport,
  sceneId: string,
  data: Omit<SceneCheckData, "checkedAt">,
  withCompile = true,
): void {
  const other = <T extends { sceneId: string }>(xs: T[]) => xs.filter((x) => x.sceneId !== sceneId);
  if (withCompile) report.compileErrors = [...other(report.compileErrors), ...data.compileErrors];
  report.runtimeErrors = [...other(report.runtimeErrors), ...data.runtimeErrors];
  report.autoIssues = [...other(report.autoIssues), ...data.autoIssues];
  report.stills = [...other(report.stills), ...data.stills];
}

/** Перебудовує `sheets/<format>.png` з поточних стілів звіту. */
export async function rebuildSheets(
  storage: Storage,
  projectId: string,
  rev: number,
  sceneIds: readonly string[],
  formats: readonly Format[],
  report: CheckReport,
): Promise<string[]> {
  const rp = revPaths(projectId, rev);
  const written: string[] = [];
  const failed = new Set([...report.compileErrors, ...report.runtimeErrors].map((e) => e.sceneId));
  report.sheets = [];
  for (const format of formats) {
    const cells: SheetCell[] = [];
    for (const sceneId of sceneIds) {
      for (const variant of ["a", "b"] as const) {
        const still = report.stills.find(
          (s) => s.sceneId === sceneId && s.format === format && s.variant === variant,
        );
        let png: Buffer | null = null;
        if (still && (await storage.exists(still.path))) png = await storage.read(still.path);
        cells.push({
          sceneId,
          variant,
          png,
          label: `${sceneId} · ${variant}${still ? ` · кадр ${still.frame}` : ""}`,
          note: failed.has(sceneId) ? `${sceneId}: помилка` : `${sceneId}: немає кадру`,
        });
      }
    }
    const key = rp.sheet(format);
    await storage.write(key, await buildSheet(format, cells));
    report.sheets.push({ format, path: key });
    written.push(key);
  }
  return written;
}

/** Хеш входів стілів сцени: код, сцена, бренд, асети, формати, шаблонність, версія motion-kit. */
function sceneCheckHash(args: {
  code: string | null;
  sceneJson: unknown;
  job: Pick<PreparedJob, "brand" | "assets">;
  formats: readonly Format[];
  template: boolean;
  contextHash: string;
}): string {
  return inputsHash({
    code: args.code === null ? null : sha256(args.code),
    scene: args.sceneJson,
    brand: args.job.brand,
    assets: args.job.assets,
    formats: args.formats,
    template: args.template,
    motionKit: args.contextHash,
  });
}

export function createCheckStage(deps: CheckStageDeps): Stage<"check"> {
  const now = deps.now ?? (() => new Date());
  return async (ctx: StageContext<"check">) => {
    const started = Date.now();
    const { storage, projectId, rev, logger } = ctx;
    const rp = revPaths(projectId, rev);
    const dp = directorPaths(projectId, rev);
    const project = await readProject(storage, projectId);
    const brandFile = await readCurrentBrandKit(storage, projectId, project);
    const storyboard = await readStoryboard(storage, projectId, rev);
    const formats = formatsOf(project);
    const templates = new Set(await readTemplateScenes(storage, projectId, rev));
    const ledger: SceneLedger = await readLedger(storage, projectId, rev);
    const allIds = storyboard.scenes.map((s) => s.id);
    const targets = (ctx.params.sceneIds ?? allIds).filter((id) => allIds.includes(id));
    const artifacts = new Set<string>();

    const report: CheckReport =
      (await readOptional(storage, rp.check, (v) => CheckReport.parse(v), logger)) ?? emptyReport();
    report.bundleError = null;
    // Видалені з розкадровки сцени — геть зі звіту.
    const keep = <T extends { sceneId: string }>(xs: T[]) => xs.filter((x) => allIds.includes(x.sceneId));
    report.compileErrors = keep(report.compileErrors);
    report.runtimeErrors = keep(report.runtimeErrors);
    report.autoIssues = keep(report.autoIssues);
    report.stills = keep(report.stills);

    // ---------- 0. нова ревізія: код незмінених сцен — з ревізії-основи ----------
    const base = baseRevOf(project, rev);
    if (base !== null) {
      const baseLedger = await readLedger(storage, projectId, base);
      for (const id of allIds) {
        if (templates.has(id) || ledger.scenes[id] || (await storage.exists(rp.scene(id)))) continue;
        for (const k of await carryScene(
          storage,
          projectId,
          rev,
          base,
          ledger,
          baseLedger,
          id,
          now(),
          null,
        )) {
          artifacts.add(k);
        }
      }
    }

    // ---------- 1. код і типи ----------
    const code = new Map<string, string | null>();
    const compileErrors: CheckReport["compileErrors"] = [];
    for (const id of allIds) {
      if (templates.has(id)) {
        code.set(id, null);
        continue;
      }
      const ver = currentVersion(ledger, id);
      if (ver && !ver.guardOk) {
        code.set(id, null);
        const reasons = ver.violations.length ? ver.violations : ["код сцени не пройшов AST-guard"];
        for (const message of reasons) {
          compileErrors.push({ sceneId: id, message: `AST-guard: ${message}`, line: null, column: null });
        }
        continue;
      }
      const key = rp.scene(id);
      if (!(await storage.exists(key))) {
        code.set(id, null);
        compileErrors.push({ sceneId: id, message: "немає коду сцени", line: null, column: null });
        continue;
      }
      code.set(id, await storage.readText(key));
    }
    const toTypecheck: Record<string, string> = {};
    for (const [id, c] of code) if (c !== null) toTypecheck[id] = c;
    await progress(ctx, "check", "Перевіряю код сцен…");
    const types = typecheckScenes(toTypecheck);
    for (const e of types.errors) {
      compileErrors.push({
        sceneId: e.sceneId,
        message: `TS${e.code}: ${e.message}`,
        line: e.line,
        column: e.column,
      });
    }
    report.compileErrors = compileErrors;
    const compileFailed = new Set(compileErrors.map((e) => e.sceneId));

    // ---------- 2. задача і бандл ----------
    const job = await prepareJob({
      storage,
      projectId,
      rev,
      project,
      brandFile,
      storyboard,
      excludeFromIndex: [...templates, ...compileFailed],
    });
    for (const k of job.written) artifacts.add(k);

    const contextHash = loadCodegenContext().hash;
    const hashes: Record<string, string> = {};
    for (const scene of storyboard.scenes) {
      hashes[scene.id] = sceneCheckHash({
        code: code.get(scene.id) ?? null,
        sceneJson: scene,
        job,
        formats,
        template: templates.has(scene.id),
        contextHash,
      });
    }

    // Пропуск за хешем входів: стіли незмінених сцен — з ревізії-основи.
    const reusedScenes = new Set<string>();
    if (base !== null) {
      const baseMeta = await readOptional(storage, directorPaths(projectId, base).checkMeta, (v) =>
        CheckMeta.parse(v),
      );
      const baseReport = await readOptional(storage, revPaths(projectId, base).check, (v) =>
        CheckReport.parse(v),
      );
      if (baseMeta && baseReport) {
        const candidates = allIds.filter(
          (id) =>
            !compileFailed.has(id) &&
            baseMeta.scenes[id] === hashes[id] &&
            (targets.includes(id) || !report.stills.some((s) => s.sceneId === id)),
        );
        for (const id of candidates) {
          const data = sceneData(baseReport, id);
          if (data.runtimeErrors.length || data.compileErrors.length) continue;
          const stills: StillRef[] = [];
          let ok = data.stills.length === formats.length * 2;
          for (const s of data.stills) {
            const dest = rp.still(s.format, s.sceneId, s.variant);
            if (!(await storage.exists(s.path))) {
              ok = false;
              break;
            }
            await storage.copy(s.path, dest);
            artifacts.add(dest);
            stills.push({ ...s, path: dest });
          }
          if (!ok) continue;
          replaceSceneData(report, id, { ...data, compileErrors: [], stills }, false);
          reusedScenes.add(id);
        }
      }
    }

    // Знімаємо цільові сцени, а також нецільові без стілів у цій ревізії (інакше аркуші й чекпоінт 3
    // були б неповні — напр., сцена перенесена з основи, але її вхідні дані змінились).
    const stillsMissing = allIds.filter(
      (id) => !targets.includes(id) && !reusedScenes.has(id) && !report.stills.some((s) => s.sceneId === id),
    );
    const renderTargets = [...targets, ...stillsMissing].filter(
      (id) => !compileFailed.has(id) && !reusedScenes.has(id),
    );
    const engine = typeof deps.engine === "function" ? deps.engine() : deps.engine;
    try {
      let serveUrl: string | null = null;
      if (renderTargets.length > 0) {
        await progress(ctx, "check", "Збираю відео-проєкт…");
        const excluded = new Set([...templates, ...compileFailed]);
        for (let attempt = 1; serveUrl === null; attempt++) {
          try {
            serveUrl = (
              await engine.bundleJob({ jobDir: job.jobDir, ...(ctx.signal ? { signal: ctx.signal } : {}) })
            ).serveUrl;
          } catch (err) {
            const message = errorMessage(err);
            const blamed = [
              ...new Set([...message.matchAll(SCENE_FILE_IN_MESSAGE)].map((m) => m[1] as string)),
            ].filter((id) => allIds.includes(id) && !excluded.has(id));
            if (blamed.length === 0 || attempt >= MAX_BUNDLE_ATTEMPTS) {
              report.bundleError = message;
              report.durationMs = Date.now() - started;
              await storage.writeJson(rp.check, CheckReport.parse(report));
              throw new StageError(
                `check: бандл не зібрався: ${message.slice(0, 500)}`,
                "check_bundle_failed",
                "Не вдалося зібрати відео-проєкт для перевірки — спробуйте ще раз.",
                true,
                { cause: err },
              );
            }
            for (const id of blamed) {
              excluded.add(id);
              compileFailed.add(id);
              report.compileErrors.push({
                sceneId: id,
                message: `bundle: ${message}`,
                line: null,
                column: null,
              });
            }
            logger.warn("check: бандл впав на сценах, виключаю їх", { blamed });
            artifacts.add((await writeScenesIndex(storage, projectId, rev, storyboard, excluded)).key);
          }
        }
      }

      // ---------- 3. стіли ----------
      const toRender = renderTargets.filter((id) => !compileFailed.has(id));
      const total = toRender.length * formats.length * 2;
      let done = 0;
      for (const id of toRender) {
        const scene = storyboard.scenes.find((s) => s.id === id);
        if (!scene || serveUrl === null) continue;
        const frames = stillFrames(scene.durationFrames);
        const data: Omit<SceneCheckData, "checkedAt"> = {
          compileErrors: [],
          runtimeErrors: [],
          autoIssues: [],
          stills: [],
        };
        for (const format of formats) {
          for (const [i, variant] of (["a", "b"] as const).entries()) {
            const frame = frames[i] as number;
            const key = rp.still(format, id, variant);
            const out = storage.absPath(key);
            await mkdir(path.dirname(out), { recursive: true });
            try {
              const res = await engine.renderStill({
                serveUrl,
                composition: "ScenePreview",
                inputProps: scenePreviewProps(job, id, format, templates.has(id)),
                frame,
                format,
                out,
                ...(ctx.signal ? { signal: ctx.signal } : {}),
              });
              data.autoIssues.push(...collectAutoIssues(res.logs, id, format, frame));
              data.stills.push({ sceneId: id, format, variant, frame, path: key });
              artifacts.add(key);
            } catch (err) {
              if (ctx.signal?.aborted) throw err;
              data.autoIssues.push(...collectAutoIssues(errorLogs(err), id, format, frame));
              data.runtimeErrors.push({ sceneId: id, format, frame, message: errorMessage(err) });
            }
            done++;
            await progress(ctx, "check", `Знімаю кадри сцен… ${done}/${total}`, done, total);
          }
        }
        data.autoIssues = dedupeIssues(data.autoIssues);
        replaceSceneData(report, id, data, false);
      }
    } finally {
      if (typeof deps.engine === "function") {
        try {
          await engine.close();
        } catch (err) {
          logger.warn("check: не вдалося закрити RenderEngine", { err: String(err) });
        }
      }
    }

    // Сцени без коду/з помилкою компіляції — без стілів і runtime-записів цієї спроби.
    for (const id of compileFailed) {
      report.stills = report.stills.filter((s) => s.sceneId !== id);
      report.runtimeErrors = report.runtimeErrors.filter((s) => s.sceneId !== id);
      report.autoIssues = report.autoIssues.filter((s) => s.sceneId !== id);
    }

    // ---------- 4. аркуші і звіт ----------
    for (const k of await rebuildSheets(storage, projectId, rev, allIds, formats, report)) artifacts.add(k);
    report.durationMs = Date.now() - started;
    const valid = CheckReport.parse(report);
    await storage.writeJson(rp.check, valid);
    artifacts.add(rp.check);
    const meta: CheckMeta = {
      scenes: Object.fromEntries(
        allIds
          .filter((id) => valid.stills.some((s) => s.sceneId === id))
          .map((id) => [id, hashes[id] as string]),
      ),
    };
    await storage.writeJson(dp.checkMeta, meta);

    // Результат check — у журнал версій (для вибору кращої версії в qa) + копії стілів версії.
    const checkedAt = now().toISOString();
    for (const id of new Set([...targets, ...renderTargets, ...reusedScenes, ...compileFailed])) {
      const ver = currentVersion(ledger, id);
      if (!ver) continue;
      const data = sceneData(valid, id);
      ver.check = { ...data, checkedAt };
      for (const s of data.stills) {
        const copy = dp.versionStill(id, ver.v, s.format, s.variant);
        await storage.copy(s.path, copy);
      }
    }
    if (Object.keys(ledger.scenes).length) artifacts.add(await writeLedger(storage, projectId, rev, ledger));

    const failed = new Set(
      [...valid.compileErrors, ...valid.runtimeErrors]
        .map((e) => e.sceneId)
        .filter((id) => !templates.has(id)),
    );
    const issueScenes = [...new Set(valid.autoIssues.map((i) => i.sceneId))].filter((id) => !failed.has(id));
    return {
      artifacts: [...artifacts],
      outputs: {
        failedScenes: allIds.filter((id) => failed.has(id)),
        issueScenes: allIds.filter((id) => issueScenes.includes(id)),
      },
      ...(targets.length > 0 && targets.every((id) => reusedScenes.has(id)) ? { reused: true } : {}),
      inputsHash: inputsHash(hashes),
    };
  };
}
