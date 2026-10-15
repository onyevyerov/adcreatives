import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseQaLog } from "@adc/motion-kit";
import {
  type AutoIssue,
  type BrowserLog,
  CheckReport,
  type Format,
  inputsHash,
  LEGACY_ARRIVE_EVENT_ID,
  primaryFormat,
  QaLogEntry,
  type RenderEngine,
  revPaths,
  type Scene,
  STILL_PLAN,
  type Stage,
  type StageContext,
  StageError,
  type StillRef,
  type Storage,
  sha256,
  stillFrames,
  stripFrames,
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
import { buildMomentSheet, type MomentPlan, momentSheetRows, planMoments } from "../moments.ts";
import { buildSheet, buildStripSheet, diffThumb, type SheetCell, type StripCell } from "../sheets.ts";
import { typecheckScenes } from "../typecheck.ts";

/**
 * Стадія `check` (CPU, без LLM): типи сцен → бандл → стіли ScenePreview за `STILL_PLAN` (25%, 50% і
 * 90% сцени) у всіх обраних форматах з QA-режимом → `autoIssues` з логів `ADC_QA` → зведені аркуші →
 * `check.json`. Кадр `e` (25%) — перехідні стани появи: його `autoIssues` у звіт не йдуть, лише сам стіл.
 *
 * Крім стілів — стрічка сцени: кадри `stripFrames(duration, STRIP_STEP)` у кожному обраному форматі
 * (`revPaths.strip`; кадр, що збігся зі стілом, копіюється) → аркуш стрічки `revPaths.stripSheet` для
 * арт-директора і fix. Зі стрічки — автодетектор `static_hold` (кадр стоїть ≥ 1.5 с); з коду —
 * `event_unused` (подія сцени не згадана в коді). Логи `ADC_QA` кадрів стрічки не беруться (там появи
 * в процесі), але runtime-помилка на кадрі стрічки — помилка сцени (фінальний рендер на ній упаде).
 * Шаблонні сцени стрічки не мають.
 *
 * Після стрічки — аркуш моментів сцени (`revPaths.momentSheet`, лише головний формат): кадри ±2
 * навколо кожної події і склейка з наступною сценою (`planMoments`, ≤ `MOMENT_MAX_FRAMES` кадрів;
 * перші кадри наступної рендеряться, навіть якщо вона поза scope). Кадр, що вже є в стілах чи стрічці,
 * не рендериться вдруге; PNG кадрів моментів не зберігаються, лише аркуш. Кадр, що не відрендерився, —
 * заглушка на аркуші, не помилка сцени. Сцена з runtime-помилкою аркуша не має. → `check.moments`.
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

/**
 * Версія логіки check у хеші входів: зміна детекторів, стрічки чи аркуша моментів — сцени знімаються
 * заново (інакше сцени, перенесені з основи до появи аркушів моментів, лишились би без них).
 */
const CHECK_LOGIC = "moments-v1";

/** Крок стрічки кадрів сцени (15 кадрів = 0.5 с при 30 fps). */
export const STRIP_STEP = 15;
/** Скільки кадрів стрічки однієї сцени й формату рендеряться одночасно (браузер спільний, сторінки окремі). */
export const STRIP_CONCURRENCY = 3;
/** Мінімальна довжина серії майже однакових кадрів, що вважається `static_hold` (1.5 с при 30 fps). */
export const STATIC_HOLD_MIN_FRAMES = 45;
/** Те саме для фінальної сцени `cta`: лого з кнопкою може стояти довше (2.5 с). */
export const STATIC_HOLD_MIN_FRAMES_FINAL_CTA = 75;
/** Піксель мініатюри «змінився», якщо хоч один канал різниться більше ніж на стільки (0–255). */
export const STATIC_PIXEL_DELTA = 12;
/** Кадри «майже однакові», якщо змінилося не більше цієї частки пікселів мініатюри. */
export const STATIC_CHANGED_RATIO = 0.002;

/** Чи майже однакові дві мініатюри (`diffThumb`, RGB): змінилось ≤ `STATIC_CHANGED_RATIO` пікселів. */
export function framesAlike(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  const limit = (a.length / 3) * STATIC_CHANGED_RATIO;
  let changed = 0;
  for (let i = 0; i + 2 < a.length; i += 3) {
    if (
      Math.abs((a[i] as number) - (b[i] as number)) > STATIC_PIXEL_DELTA ||
      Math.abs((a[i + 1] as number) - (b[i + 1] as number)) > STATIC_PIXEL_DELTA ||
      Math.abs((a[i + 2] as number) - (b[i + 2] as number)) > STATIC_PIXEL_DELTA
    ) {
      changed++;
      if (changed > limit) return false;
    }
  }
  return true;
}

export interface StaticHold {
  /** Перший і останній кадр серії (локальні кадри сцени). */
  from: number;
  to: number;
  /** `to − from`. */
  frames: number;
}

/**
 * Серії майже однакових кадрів стрічки довжиною ≥ `minFrames`. Кадр входить у серію, якщо він
 * майже однаковий і з попереднім, і з першим кадром серії (повільний дрейф не накопичується).
 */
export function findStaticHolds(
  frames: readonly number[],
  thumbs: readonly Uint8Array[],
  minFrames: number,
): StaticHold[] {
  const out: StaticHold[] = [];
  let start = 0;
  for (let i = 1; i <= frames.length; i++) {
    const cur = thumbs[i];
    const alike =
      i < frames.length &&
      cur !== undefined &&
      framesAlike(thumbs[i - 1] as Uint8Array, cur) &&
      framesAlike(thumbs[start] as Uint8Array, cur);
    if (alike) continue;
    const from = frames[start] as number;
    const to = frames[i - 1] as number;
    if (to - from >= minFrames) out.push({ from, to, frames: to - from });
    start = i;
  }
  return out;
}

/** Поріг `static_hold` сцени: фінальна сцена `cta` — `STATIC_HOLD_MIN_FRAMES_FINAL_CTA`, решта — 45 кадрів. */
export function staticHoldThreshold(scene: Pick<Scene, "purpose">, isLast: boolean): number {
  return isLast && scene.purpose === "cta" ? STATIC_HOLD_MIN_FRAMES_FINAL_CTA : STATIC_HOLD_MIN_FRAMES;
}

const sec = (frames: number, fps: number) => (frames / fps).toFixed(1);

/** AutoIssue `static_hold` з діапазоном кадрів серії. */
export function staticHoldIssues(
  holds: readonly StaticHold[],
  args: { sceneId: string; format: Format; fps: number; threshold: number },
): AutoIssue[] {
  return holds.map((h) => ({
    kind: "static_hold",
    component: "strip",
    detail:
      `frames ${h.from}–${h.to} (${sec(h.from, args.fps)}–${sec(h.to, args.fps)} s) barely change: ` +
      `${h.frames} frames in a row (threshold ${args.threshold})`,
    value: h.frames,
    frame: h.from,
    sceneId: args.sceneId,
    format: args.format,
  }));
}

/** Чи трапляється `value` у коді рядковим літералом ("…", '…' або `…`). */
function hasStringLiteral(code: string, value: string): boolean {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(["'\`])${escaped}\\1`).test(code);
}

/**
 * Події сцени, чий id не трапляється в коді рядковим літералом (момент не прив'язаний до
 * `eventFrame(props.scene, "id")`, а звук стоїть саме там). Legacy-подія "arrive" на кадрі 0
 * (з `sfxCue`) — початок сцени, її не вимагаємо.
 */
export function unusedEvents(scene: Pick<Scene, "events">, code: string): Scene["events"] {
  return scene.events.filter(
    (e) => !(e.id === LEGACY_ARRIVE_EVENT_ID && e.at === 0) && !hasStringLiteral(code, e.id),
  );
}

/** AutoIssue `event_unused` — по одній на подію (формат — перший обраний: код спільний для всіх). */
export function eventUnusedIssues(
  scene: Pick<Scene, "id" | "events">,
  code: string,
  format: Format,
): AutoIssue[] {
  return unusedEvents(scene, code).map((e) => ({
    kind: "event_unused",
    component: "Scene",
    detail:
      `event "${e.id}" (frame ${e.at}: ${e.what}) is not used in the scene code; ` +
      `drive its moment with eventFrame(props.scene, "${e.id}")`,
    frame: e.at,
    sceneId: scene.id,
    format,
  }));
}

/** Копія аркуша стрічки версії сцени в журналі версій (поряд зі стілами версії). */
export function versionStripSheet(
  projectId: string,
  rev: number,
  sceneId: string,
  v: number,
  format: Format,
): string {
  return `${directorPaths(projectId, rev).root}/versions/${sceneId}/v${v}/${format}-strip.jpg`;
}

/** Виконує `fn` для кожного елемента, не більше `limit` одночасно. */
async function inPool<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++] as T;
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

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

/** Чи має сцена стіли всіх варіантів `STILL_PLAN` у кожному з форматів (старі check.json — лише a/b). */
function hasAllStills(stills: readonly StillRef[], sceneId: string, formats: readonly Format[]): boolean {
  return formats.every((format) =>
    STILL_PLAN.every(({ variant }) =>
      stills.some((s) => s.sceneId === sceneId && s.format === format && s.variant === variant),
    ),
  );
}

function emptyReport(): CheckReport {
  return {
    compileErrors: [],
    bundleError: null,
    runtimeErrors: [],
    autoIssues: [],
    stills: [],
    sheets: [],
    moments: [],
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
      for (const { variant, fraction } of STILL_PLAN) {
        const still = report.stills.find(
          (s) => s.sceneId === sceneId && s.format === format && s.variant === variant,
        );
        let png: Buffer | null = null;
        if (still && (await storage.exists(still.path))) png = await storage.read(still.path);
        cells.push({
          sceneId,
          variant,
          png,
          label: `${sceneId} · ${variant} ${Math.round(fraction * 100)}%${still ? ` · кадр ${still.frame}` : ""}`,
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

/**
 * Хеш входів стілів і стрічки сцени: код, сцена, бренд, асети, формати, шаблонність, чи сцена
 * остання (поріг `static_hold`), версія motion-kit і логіки check.
 */
function sceneCheckHash(args: {
  code: string | null;
  sceneJson: unknown;
  job: Pick<PreparedJob, "brand" | "assets">;
  formats: readonly Format[];
  template: boolean;
  isLast: boolean;
  contextHash: string;
}): string {
  return inputsHash({
    code: args.code === null ? null : sha256(args.code),
    scene: args.sceneJson,
    brand: args.job.brand,
    assets: args.job.assets,
    formats: args.formats,
    template: args.template,
    last: args.isLast,
    motionKit: args.contextHash,
    logic: CHECK_LOGIC,
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
    const primary = primaryFormat(formats);
    report.moments = keep(report.moments).filter((m) => m.format === primary);
    /** Запис аркуша моментів сцени у звіті (null — аркуша немає). */
    const setMoment = (sceneId: string, key: string | null) => {
      report.moments = report.moments.filter((m) => m.sceneId !== sceneId);
      if (key !== null) report.moments.push({ sceneId, format: primary, path: key });
    };

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
    const lastId = allIds.at(-1);
    for (const scene of storyboard.scenes) {
      hashes[scene.id] = sceneCheckHash({
        code: code.get(scene.id) ?? null,
        sceneJson: scene,
        job,
        formats,
        template: templates.has(scene.id),
        isLast: scene.id === lastId,
        contextHash,
      });
    }
    /** Чи є в цій ревізії аркуші стрічки сцени в усіх форматах (шаблонним сценам стрічка не потрібна). */
    const hasStripSheets = async (id: string): Promise<boolean> => {
      if (templates.has(id)) return true;
      for (const format of formats) if (!(await storage.exists(rp.stripSheet(format, id)))) return false;
      return true;
    };

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
            (targets.includes(id) || !hasAllStills(report.stills, id, formats)),
        );
        for (const id of candidates) {
          const data = sceneData(baseReport, id);
          if (data.runtimeErrors.length || data.compileErrors.length) continue;
          const stills: StillRef[] = [];
          // Старий звіт основи (лише a/b або без стрічки) не підходить — сцену знімаємо заново.
          let ok =
            data.stills.length === formats.length * STILL_PLAN.length &&
            hasAllStills(data.stills, id, formats);
          const baseRp = revPaths(projectId, base);
          if (ok && !templates.has(id)) {
            for (const format of formats) {
              if (!(await storage.exists(baseRp.stripSheet(format, id)))) ok = false;
            }
          }
          if (!ok) continue;
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
          if (!templates.has(id)) {
            for (const format of formats) {
              const dest = rp.stripSheet(format, id);
              await storage.copy(baseRp.stripSheet(format, id), dest);
              artifacts.add(dest);
            }
          }
          // Аркуш моментів основи (якщо є; сцена без подій і без склейки його не має).
          const momentFrom = baseRp.momentSheet(primary, id);
          if (!templates.has(id) && (await storage.exists(momentFrom))) {
            const dest = rp.momentSheet(primary, id);
            await storage.copy(momentFrom, dest);
            artifacts.add(dest);
            setMoment(id, dest);
          } else {
            setMoment(id, null);
          }
          replaceSceneData(report, id, { ...data, compileErrors: [], stills }, false);
          reusedScenes.add(id);
        }
      }
    }

    // Знімаємо цільові сцени, а також нецільові без повного набору стілів чи стрічки в цій ревізії
    // (інакше аркуші, QA й чекпоінт 3 були б неповні — напр., сцена перенесена з основи, але її вхідні
    // дані змінились, або check.json записаний до появи кадру `e` чи стрічки).
    const stillsMissing: string[] = [];
    for (const id of allIds) {
      if (targets.includes(id) || reusedScenes.has(id)) continue;
      if (!hasAllStills(report.stills, id, formats) || !(await hasStripSheets(id))) stillsMissing.push(id);
    }
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

      // ---------- 3. стіли і стрічка ----------
      const toRender = renderTargets.filter((id) => !compileFailed.has(id));
      const stripOf = (id: string, durationFrames: number) =>
        templates.has(id) ? [] : stripFrames(durationFrames, STRIP_STEP);
      /** План аркуша моментів сцени (шаблонні сцени аркуша не мають). */
      const momentPlanOf = (scene: Scene): MomentPlan | null => {
        if (templates.has(scene.id)) return null;
        const next = storyboard.scenes[storyboard.scenes.indexOf(scene) + 1] ?? null;
        return planMoments(scene, next);
      };
      const momentCount = (plan: MomentPlan | null) => (plan ? plan.own.length + plan.next.length : 0);
      const total = toRender.reduce((sum, id) => {
        const scene = storyboard.scenes.find((s) => s.id === id);
        const strip = scene ? stripOf(id, scene.durationFrames).length : 0;
        const moments = scene ? momentCount(momentPlanOf(scene)) : 0;
        return sum + formats.length * (STILL_PLAN.length + strip) + moments;
      }, 0);
      let done = 0;
      const tick = async () => {
        done++;
        await progress(ctx, "check", `Знімаю кадри сцен… ${done}/${total}`, done, total);
      };
      const renderOne = async (id: string, format: Format, frame: number, out: string) =>
        engine.renderStill({
          serveUrl: serveUrl as string,
          composition: "ScenePreview",
          inputProps: scenePreviewProps(job, id, format, templates.has(id)),
          frame,
          format,
          out,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });

      /**
       * Стрічка сцени у форматі: кадри (збіг зі стілом — копія), аркуш, `static_hold`. Помилка кадру —
       * runtime-помилка сцени (перша за порядком кадрів), аркуш — із заглушками на місці таких кадрів.
       */
      const renderStrip = async (
        scene: Scene,
        format: Format,
        frames: readonly number[],
        stillKeys: ReadonlyMap<number, string>,
        data: Omit<SceneCheckData, "checkedAt">,
      ) => {
        const id = scene.id;
        const failures = new Map<number, string>();
        await inPool(frames, STRIP_CONCURRENCY, async (frame) => {
          const key = rp.strip(format, id, frame);
          const still = stillKeys.get(frame);
          try {
            if (still) {
              await storage.copy(still, key);
            } else {
              const out = storage.absPath(key);
              await mkdir(path.dirname(out), { recursive: true });
              await renderOne(id, format, frame, out);
            }
          } catch (err) {
            if (ctx.signal?.aborted) throw err;
            failures.set(frame, errorMessage(err));
          }
          await tick();
        });
        const cells: StripCell[] = [];
        const thumbs: Uint8Array[] = [];
        for (const frame of frames) {
          const failed = failures.has(frame);
          const png = failed ? null : await storage.read(rp.strip(format, id, frame));
          cells.push({
            frame,
            png,
            label: `${frame} · ${sec(frame, storyboard.fps)}s`,
            note: "render error",
          });
          if (png && failures.size === 0) thumbs.push(await diffThumb(png, format));
        }
        const sheetKey = rp.stripSheet(format, id);
        await storage.write(sheetKey, await buildStripSheet(format, cells));
        artifacts.add(sheetKey);
        const firstFailure = frames.find((f) => failures.has(f));
        if (firstFailure !== undefined) {
          data.runtimeErrors.push({
            sceneId: id,
            format,
            frame: firstFailure,
            message: failures.get(firstFailure) as string,
          });
          return;
        }
        const threshold = staticHoldThreshold(scene, id === lastId);
        data.autoIssues.push(
          ...staticHoldIssues(findStaticHolds(frames, thumbs, threshold), {
            sceneId: id,
            format,
            fps: storyboard.fps,
            threshold,
          }),
        );
      };

      /**
       * Аркуш моментів сцени в головному форматі за планом. Кадри сцени, що вже є серед стілів чи
       * стрічки, читаються звідти; решта (і кадри наступної сцени) рендеряться в тимчасову теку, яка
       * потім видаляється. Помилка кадру — заглушка на аркуші. Повертає ключ аркуша або null.
       */
      const renderMoments = async (
        scene: Scene,
        plan: MomentPlan,
        data: Omit<SceneCheckData, "checkedAt">,
      ): Promise<string | null> => {
        if (plan.skipped.length > 0) {
          logger.info("check: аркуш моментів — події понад ліміт кадрів пропущено", {
            sceneId: scene.id,
            skipped: plan.skipped,
          });
        }
        if (plan.rows.length === 0) return null;
        const ready = new Map<number, string>();
        for (const s of data.stills) if (s.format === primary) ready.set(s.frame, s.path);
        for (const f of stripOf(scene.id, scene.durationFrames)) ready.set(f, rp.strip(primary, scene.id, f));
        const nextId = plan.rows.find((r) => r.kind === "join")?.nextId ?? null;
        const own = new Map<number, Buffer>();
        const next = new Map<number, Buffer>();
        const jobs = [
          ...plan.own.map((frame) => ({ sceneId: scene.id, frame, into: own })),
          ...(nextId !== null && !compileFailed.has(nextId)
            ? plan.next.map((frame) => ({ sceneId: nextId, frame, into: next }))
            : []),
        ];
        done += momentCount(plan) - jobs.length;
        const dir = await mkdtemp(path.join(tmpdir(), "adc-moments-"));
        let failures = 0;
        try {
          await inPool(jobs, STRIP_CONCURRENCY, async ({ sceneId, frame, into }) => {
            try {
              const key = sceneId === scene.id ? ready.get(frame) : undefined;
              if (key !== undefined && (await storage.exists(key))) {
                into.set(frame, await storage.read(key));
              } else {
                const out = path.join(dir, `${sceneId}-${frame}.png`);
                await renderOne(sceneId, primary, frame, out);
                into.set(frame, await readFile(out));
              }
            } catch (err) {
              if (ctx.signal?.aborted) throw err;
              failures++;
            }
            await tick();
          });
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
        if (failures > 0) {
          logger.warn("check: аркуш моментів — частина кадрів не відрендерилась", {
            sceneId: scene.id,
            failures,
          });
        }
        const key = rp.momentSheet(primary, scene.id);
        await storage.write(
          key,
          await buildMomentSheet(primary, momentSheetRows(plan, storyboard.fps, own, next)),
        );
        artifacts.add(key);
        return key;
      };

      for (const id of toRender) {
        const scene = storyboard.scenes.find((s) => s.id === id);
        if (!scene || serveUrl === null) continue;
        const frames = stillFrames(
          scene.durationFrames,
          STILL_PLAN.map((p) => p.fraction),
        );
        const strip = stripOf(id, scene.durationFrames);
        const data: Omit<SceneCheckData, "checkedAt"> = {
          compileErrors: [],
          runtimeErrors: [],
          autoIssues: [],
          stills: [],
        };
        for (const format of formats) {
          const stillKeys = new Map<number, string>();
          let stillFailed = false;
          for (const [i, { variant }] of STILL_PLAN.entries()) {
            const frame = frames[i] as number;
            // Кадр `e` — появи ще тривають (текст «вміщується», елемент за краєм): autoIssues не беремо.
            const issuesOf = (logs: readonly BrowserLog[]) =>
              variant === "e" ? [] : collectAutoIssues(logs, id, format, frame);
            const key = rp.still(format, id, variant);
            const out = storage.absPath(key);
            await mkdir(path.dirname(out), { recursive: true });
            try {
              const res = await renderOne(id, format, frame, out);
              data.autoIssues.push(...issuesOf(res.logs));
              data.stills.push({ sceneId: id, format, variant, frame, path: key });
              stillKeys.set(frame, key);
              artifacts.add(key);
            } catch (err) {
              if (ctx.signal?.aborted) throw err;
              stillFailed = true;
              data.autoIssues.push(...issuesOf(errorLogs(err)));
              data.runtimeErrors.push({ sceneId: id, format, frame, message: errorMessage(err) });
            }
            await tick();
          }
          // Сцена вже падає на стілах цього формату — стрічка нічого не додасть.
          if (stillFailed) {
            done += strip.length;
            continue;
          }
          if (strip.length > 0) await renderStrip(scene, format, strip, stillKeys, data);
        }
        const sceneCode = code.get(id);
        if (!templates.has(id) && sceneCode) {
          data.autoIssues.push(...eventUnusedIssues(scene, sceneCode, formats[0] as Format));
        }
        data.autoIssues = dedupeIssues(data.autoIssues);
        replaceSceneData(report, id, data, false);
        // Аркуш моментів — після стілів і стрічки; сцена, що падає, його не має (її знімуть після fix).
        const plan = momentPlanOf(scene);
        if (plan && data.runtimeErrors.length === 0) {
          setMoment(id, await renderMoments(scene, plan, data));
        } else {
          done += momentCount(plan);
          setMoment(id, null);
        }
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
      setMoment(id, null);
    }
    report.moments.sort((a, b) => allIds.indexOf(a.sceneId) - allIds.indexOf(b.sceneId));

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
      // Аркуш стрічки версії — щоб qa, повертаючи кращу версію, повернув і її стрічку.
      for (const format of new Set(data.stills.map((s) => s.format))) {
        const sheet = rp.stripSheet(format, id);
        if (await storage.exists(sheet)) {
          await storage.copy(sheet, versionStripSheet(projectId, rev, id, ver.v, format));
        }
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
