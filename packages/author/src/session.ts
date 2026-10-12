import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  directorPaths,
  type PreparedJob,
  prepareJob,
  type SceneLedger,
  scenePreviewProps,
} from "@adc/director";
import type {
  Asset,
  BrandKitFile,
  BrowserLog,
  Format,
  ProjectState,
  RenderEngine,
  Scene,
  StageContext,
  Storyboard,
} from "@adc/shared";

/**
 * Стан одного запуску стадії `author`, спільний для інструментів: прочитані артефакти ревізії,
 * журнал версій, стан коду сцен у цьому запуску, бандл і рушій рендеру (створюються ліниво, бандл
 * перезбирається після кожного `write_scene`), лічильник рендерів і `finish`.
 */

/** Рушій рендеру або фабрика (створюється при першому рендері й закривається наприкінці стадії). */
export type EngineSource = RenderEngine | (() => RenderEngine | Promise<RenderEngine>);

export interface SceneRunState {
  /** Версія в журналі, записана цим запуском. */
  v: number;
  guardOk: boolean;
  /** Помилки типів останньої версії (порожньо — компілюється). */
  typeErrors: string[];
}

export interface AuthorSession {
  ctx: StageContext<"author">;
  project: ProjectState | null;
  brandFile: BrandKitFile;
  storyboard: Storyboard;
  manifest: Asset[];
  formats: Format[];
  /** Сцени на TemplateScene (pipeline.json): коду не мають, рендеряться шаблоном. */
  templates: Set<string>;
  allIds: string[];
  /** Сцени, які агент може писати в цьому запуску; решта — тільки для читання. */
  targets: string[];
  ledger: SceneLedger;
  /** Код сцен, записаний у цьому запуску. */
  written: Map<string, SceneRunState>;
  /** Помилки типів коду, що вже був у ревізії на старті (перенесений з основи або з попередньої спроби). */
  existingTypeErrors: Map<string, string[]>;
  /** Записані ключі сховища. */
  artifacts: Set<string>;
  /** Скільки кадрів відрендерено (облік `remotion.perRender`). */
  renders: number;
  finished: { summary: string } | null;
  now: () => Date;
  /** Підготовлена тека ревізії й `serveUrl` бандла; null — треба (пере)зібрати. */
  bundle: { job: PreparedJob; serveUrl: string } | null;
  engineSource: EngineSource;
  engine: RenderEngine | null;
}

export function sceneOf(session: AuthorSession, sceneId: string): Scene | null {
  return session.storyboard.scenes.find((s) => s.id === sceneId) ?? null;
}

/** Сцени, код яких не можна класти в бандл: не пройшли guard або не компілюються в цьому запуску. */
export function brokenScenes(session: AuthorSession): string[] {
  const out = new Set<string>();
  for (const [id, errors] of session.existingTypeErrors) if (errors.length > 0) out.add(id);
  for (const [id, s] of session.written) {
    if (!s.guardOk || s.typeErrors.length > 0) out.add(id);
    else out.delete(id);
  }
  return [...out];
}

/** Код сцени змінився — бандл застарів. */
export function invalidateBundle(session: AuthorSession): void {
  session.bundle = null;
}

async function engineOf(session: AuthorSession): Promise<RenderEngine> {
  if (session.engine) return session.engine;
  const src = session.engineSource;
  session.engine = typeof src === "function" ? await src() : src;
  return session.engine;
}

/** Закриває рушій, якщо стадія створила його з фабрики. */
export async function closeEngine(session: AuthorSession): Promise<void> {
  if (!session.engine || typeof session.engineSource !== "function") return;
  try {
    await session.engine.close();
  } catch (err) {
    session.ctx.logger.warn("author: не вдалося закрити RenderEngine", { err: String(err) });
  }
  session.engine = null;
}

/** Бандл поточного коду (зібраний, якщо застарів). Помилка збирання летить далі — інструмент поверне її моделі. */
export async function ensureBundle(session: AuthorSession): Promise<{ job: PreparedJob; serveUrl: string }> {
  if (session.bundle) return session.bundle;
  const { ctx } = session;
  const job = await prepareJob({
    storage: ctx.storage,
    projectId: ctx.projectId,
    rev: ctx.rev,
    project: session.project,
    brandFile: session.brandFile,
    storyboard: session.storyboard,
    excludeFromIndex: [...session.templates, ...brokenScenes(session)],
  });
  for (const k of job.written) session.artifacts.add(k);
  const engine = await engineOf(session);
  const { serveUrl } = await engine.bundleJob({
    jobDir: job.jobDir,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
  session.bundle = { job, serveUrl };
  return session.bundle;
}

/** Чи можна рендерити сцену: шаблонна або є в реєстрі бандла. Повертає причину, якщо ні. */
export function unrenderableReason(session: AuthorSession, job: PreparedJob, sceneId: string): string | null {
  if (!sceneOf(session, sceneId)) return `unknown scene ${sceneId}; scenes: ${session.allIds.join(", ")}`;
  if (session.templates.has(sceneId) || job.indexedScenes.includes(sceneId)) return null;
  const state = session.written.get(sceneId);
  if (state && !state.guardOk)
    return `${sceneId}: its current code fails the guard; fix it with write_scene first`;
  if (state?.typeErrors.length || (!state && session.existingTypeErrors.get(sceneId)?.length)) {
    return `${sceneId}: its current code does not compile; fix it with write_scene first`;
  }
  return `${sceneId}: the scene has no code yet; write it with write_scene first`;
}

/** Шлях кадру, відрендереного агентом (поза `strips/` і `stills/` стадії check). */
export function authorFrameKey(
  session: AuthorSession,
  format: Format,
  sceneId: string,
  frame: number,
): string {
  const root = directorPaths(session.ctx.projectId, session.ctx.rev).root;
  return `${root}/author/frames/${format}/${sceneId}-${frame}.png`;
}

/** Рендер одного кадру ScenePreview у PNG. Повертає логи браузера. */
export async function renderFrame(
  session: AuthorSession,
  bundle: { job: PreparedJob; serveUrl: string },
  sceneId: string,
  format: Format,
  frame: number,
  key: string,
): Promise<BrowserLog[]> {
  const { ctx } = session;
  const out = ctx.storage.absPath(key);
  await mkdir(path.dirname(out), { recursive: true });
  const engine = await engineOf(session);
  const res = await engine.renderStill({
    serveUrl: bundle.serveUrl,
    composition: "ScenePreview",
    inputProps: scenePreviewProps(bundle.job, sceneId, format, session.templates.has(sceneId)),
    frame,
    format,
    out,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
  session.renders += 1;
  return res.logs;
}

/** Облік рендерів інструмента в `costs.jsonl` (`remotion.perRender`); збій запису не валить інструмент. */
export async function recordRenders(session: AuthorSession, renders: number, detail: string): Promise<void> {
  if (renders <= 0) return;
  try {
    await session.ctx.cost.record({ provider: "remotion", renders, detail });
  } catch (err) {
    session.ctx.logger.warn("author: не вдалося записати витрати рендеру", { err: String(err) });
  }
}

/** Виконує `fn` для кожного елемента, не більше `limit` одночасно. */
export async function inPool<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++] as T);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 2000);
}
