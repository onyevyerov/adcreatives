import { brandCheckpointPayload } from "@adc/brandkit";
import {
  type Asset,
  AssetManifest,
  AudioManifest,
  BrandKitFile,
  type ChatEventInput,
  ClaimsReport,
  type CostStage,
  computeTimeline,
  FilmReview,
  type Format,
  framesToMs,
  groupUsd,
  type Logger,
  noopLogger,
  type ProjectState,
  primaryFormat,
  projectPaths,
  QaReport,
  type ReviewIssue,
  type ReviewRoute,
  readCosts,
  routeOf,
  type SceneTiming,
  type Storage,
  Storyboard,
  sumUsd,
  TimelineError,
  t,
} from "@adc/shared";

/**
 * Збирання карток чекпоінтів і видачі з артефактів сховища.
 * Схеми подій — `packages/shared/src/schemas/events.ts`.
 */

export async function readOptional<T>(
  storage: Storage,
  key: string,
  parse: (v: unknown) => T,
): Promise<T | null> {
  if (!(await storage.exists(key))) return null;
  return storage.readJson(key, parse);
}

export async function readAssets(storage: Storage, projectId: string): Promise<Asset[]> {
  const m = await readOptional(storage, projectPaths(projectId).assets, (v) => AssetManifest.parse(v));
  return m?.assets ?? [];
}

/** Найновіша версія brandkit/v<k>.json (0 — немає). */
export async function latestBrandkitVersion(storage: Storage, projectId: string): Promise<number> {
  const keys = await storage.list(projectPaths(projectId).brandkitDir);
  let max = 0;
  for (const k of keys) {
    const m = /\/v(\d+)\.json$/.exec(k);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

export async function readBrandkit(storage: Storage, project: ProjectState): Promise<BrandKitFile | null> {
  const v = project.brandkitVersion ?? (await latestBrandkitVersion(storage, project.id));
  if (!v) return null;
  return readOptional(storage, projectPaths(project.id).brandkit(v), (x) => BrandKitFile.parse(x));
}

export async function readStoryboard(storage: Storage, project: ProjectState): Promise<Storyboard | null> {
  return readOptional(storage, projectPaths(project.id).rev(project.rev).storyboard, (v) =>
    Storyboard.parse(v),
  );
}

export async function readClaims(storage: Storage, project: ProjectState): Promise<ClaimsReport | null> {
  return readOptional(storage, projectPaths(project.id).rev(project.rev).claims, (v) =>
    ClaimsReport.parse(v),
  );
}

const round = (usd: number) => Math.round(usd * 10_000) / 10_000;
const money = (usd: number) => usd.toFixed(2);

// ─────────────────────────── чекпоінт 1: бренд ───────────────────────────

export async function buildBrandCheckpoint(
  storage: Storage,
  project: ProjectState,
  rev: number,
): Promise<ChatEventInput[]> {
  const kit = await readBrandkit(storage, project);
  if (!kit) throw new Error(`немає бренд-кіта для чекпоінта 1 (${project.id})`);
  const assets = await readAssets(storage, project.id);
  const payload = brandCheckpointPayload(kit, assets, {
    publicUrl: (k: string) => storage.publicUrl(k),
    formats: project.formats,
  });
  // Бренд-кіт, формати й мова — лише в панелі праворуч; у чаті — відсилка до неї.
  return [
    { type: "message", role: "assistant", text: t("brandCheckpointShort"), buttons: ["approve", "edit"] },
    { type: "checkpoint", rev, checkpoint: "brand", payload },
  ];
}

// ─────────────────────────── чекпоінт 2: тексти ───────────────────────────

export async function buildScriptCheckpoint(
  storage: Storage,
  project: ProjectState,
  rev: number,
  now: string,
): Promise<ChatEventInput[]> {
  const rp = projectPaths(project.id).rev(rev);
  const storyboard = await readOptional(storage, rp.storyboard, (v) => Storyboard.parse(v));
  if (!storyboard) throw new Error(`немає ${rp.storyboard} для чекпоінта 2`);
  const claims: ClaimsReport = (await readOptional(storage, rp.claims, (v) => ClaimsReport.parse(v))) ?? {
    checkedAt: now,
    brandkitVersion: project.brandkitVersion ?? 1,
    verified: [],
    unverified: [],
  };
  const assets = await readAssets(storage, project.id);
  const byId = new Map(assets.map((a) => [a.id, a]));
  const thumbIds = [...new Set(storyboard.scenes.flatMap((s) => s.assetIds))];
  const thumbnails = thumbIds
    .map((id) => byId.get(id))
    .filter((a): a is Asset => a !== undefined)
    .map((a) => ({ assetId: a.id, url: storage.publicUrl(a.path) }));

  const timeline = computeTimeline(storyboard);
  const seconds = (Math.round((timeline.totalFrames / storyboard.fps) * 10) / 10)
    .toString()
    .replace(".", ",");
  // Витяжка без текстів сцен: концепт, сцени, музику й непідтверджені твердження малює панель (cp-script).
  // Жанр musicBrief — англійською; musicNote — українською, коли розкадровка його має.
  const lines = [
    t("scriptCheckpointSummary", {
      scenes: storyboard.scenes.length,
      seconds,
      music: storyboard.musicNote ?? storyboard.musicBrief.genre,
    }),
  ];
  if (claims.unverified.length > 0) {
    lines.push(t("scriptUnverifiedShort", { count: claims.unverified.length }));
  }

  return [
    { type: "message", role: "assistant", text: lines.join("\n"), buttons: ["approve", "edit"] },
    {
      type: "checkpoint",
      rev,
      checkpoint: "script",
      payload: {
        checkpoint: "script",
        storyboard,
        claims,
        thumbnails,
        musicBrief: storyboard.musicBrief,
        durationSeconds: timeline.durationSeconds,
      },
    },
  ];
}

// ─────────────────────────── чекпоінт 3: розкадровка ───────────────────────────

export type ReviewWarning = ReviewIssue & { route: ReviewRoute };

/**
 * Зауваження рецензента для чекпоінта 3: major/critical, без template-сцен (там уже нічого не правиться),
 * з маршрутом коду. Музичні показуються лише тут — перегенерації музики немає.
 */
export function reviewWarnings(
  review: Pick<FilmReview, "issues">,
  templateScenes: readonly string[],
): ReviewWarning[] {
  const templates = new Set(templateScenes);
  return review.issues
    .filter((i) => i.severity !== "minor" && (i.sceneId === null || !templates.has(i.sceneId)))
    .map((i) => ({ ...i, route: routeOf(i.kind) }));
}

/** `review.json` ревізії; зіпсований файл не ламає чекпоінт — тоді рецензії ніби не було. */
async function readReview(storage: Storage, key: string): Promise<FilmReview | null> {
  try {
    return await readOptional(storage, key, (v) => FilmReview.parse(v));
  } catch {
    return null;
  }
}

/**
 * Таймінг усіх сцен фільму для плеєра превʼю (переходи перекривають сусідні сцени).
 * Розкадровка, з якої таймінг не рахується, не ламає чекпоінт — тоді [] і попередження в лог.
 */
function sceneTimeline(storyboard: Storyboard, logger: Logger, projectId: string): SceneTiming[] {
  try {
    const { fps, scenes } = computeTimeline(storyboard);
    return scenes.map((s) => ({
      sceneId: s.id,
      fromMs: framesToMs(s.from, fps),
      durationMs: framesToMs(s.durationInFrames, fps),
    }));
  } catch (err) {
    if (!(err instanceof TimelineError)) throw err;
    logger.warn("таймінг сцен для чекпоінта 3 не пораховано", { projectId, err: String(err) });
    return [];
  }
}

export async function buildStoryboardCheckpoint(
  storage: Storage,
  project: ProjectState,
  rev: number,
  opts: {
    templateScenes: string[];
    changedScenes: string[] | null;
    /** Формат відео-превʼю, що рендериться (основний); null — превʼю вимкнене. */
    preview: Format | null;
    logger?: Logger;
  },
): Promise<ChatEventInput[]> {
  const rp = projectPaths(project.id).rev(rev);
  const storyboard = await readOptional(storage, rp.storyboard, (v) => Storyboard.parse(v));
  if (!storyboard) throw new Error(`немає ${rp.storyboard} для чекпоінта 3`);
  const primary = primaryFormat(project.formats);
  const changed = opts.changedScenes && opts.changedScenes.length > 0 ? new Set(opts.changedScenes) : null;

  // Шляхи стілів детерміновані (paths.ts), тож беремо ті, що реально є у сховищі.
  const stills: Array<{ url: string; sceneId: string; variant: "a" | "b" }> = [];
  for (const scene of storyboard.scenes) {
    if (changed && !changed.has(scene.id)) continue;
    for (const variant of ["a", "b"] as const) {
      const key = rp.still(primary, scene.id, variant);
      if (await storage.exists(key)) stills.push({ url: storage.publicUrl(key), sceneId: scene.id, variant });
    }
  }
  const sheets: Array<{ url: string; format: Format }> = [];
  for (const format of project.formats) {
    if (format === primary) continue;
    const key = rp.sheet(format);
    if (await storage.exists(key)) sheets.push({ url: storage.publicUrl(key), format });
  }
  const qa = await readOptional(storage, rp.qa, (v) => QaReport.parse(v));
  const templates = new Set(opts.templateScenes);
  const warnings = (qa?.issues ?? []).filter(
    (i) => !templates.has(i.sceneId) && project.formats.includes(i.format),
  );

  let music: { url: string } | null = null;
  const audio = await readOptional(storage, rp.audio, (v) => AudioManifest.parse(v));
  if (audio?.music) {
    const key = rp.publicFile(audio.music.src);
    if (await storage.exists(key)) music = { url: storage.publicUrl(key) };
  }

  const review = await readReview(storage, rp.review);
  const notes = review ? reviewWarnings(review, opts.templateScenes) : [];
  // Витяжка: самі зауваження, резюме рецензента й кадри — у панелі (payload нижче).
  const shown = changed
    ? storyboard.scenes.filter((s) => changed.has(s.id)).length
    : storyboard.scenes.length;
  const lines = [t("storyboardCheckpointSummary", { scenes: shown })];
  if (warnings.length + notes.length > 0) {
    lines.push(
      t("storyboardIssuesShort", {
        count: warnings.length + notes.length,
        qa: warnings.length,
        review: notes.length,
      }),
    );
  }
  if (review) lines.push(t("storyboardScoreShort", { score: review.score }));
  if (templates.size > 0) lines.push(t("templateScenesNote", { scenes: [...templates].join(", ") }));

  return [
    { type: "message", role: "assistant", text: lines.join("\n"), buttons: ["approve", "edit"] },
    {
      type: "checkpoint",
      rev,
      checkpoint: "storyboard",
      payload: {
        checkpoint: "storyboard",
        primaryFormat: primary,
        stills,
        sheets,
        warnings,
        templateScenes: [...templates],
        music,
        changedScenes: changed ? [...changed] : null,
        review: review ? { score: review.score, summary: review.summary, issues: notes } : null,
        timeline: sceneTimeline(storyboard, opts.logger ?? noopLogger, project.id),
        preview: opts.preview ? { format: opts.preview } : null,
      },
    },
  ];
}

/**
 * Подія `preview` ЧП3: `ready` з URL, якщо спекулятивний рендер вдався і mp4 лежить у сховищі,
 * інакше `failed` (UI лишає стіли, затвердити можна й без превʼю).
 */
export async function buildPreviewEvent(
  storage: Storage,
  project: ProjectState,
  rev: number,
  format: Format,
  ok: boolean,
): Promise<ChatEventInput> {
  const key = projectPaths(project.id).rev(rev).render(format);
  const ready = ok && (await storage.exists(key));
  return ready
    ? { type: "preview", rev, format, state: "ready", url: storage.publicUrl(key) }
    : { type: "preview", rev, format, state: "failed", url: null };
}

// ─────────────────────────────── витрати ───────────────────────────────

/**
 * Подія `cost` після стадії: усього по проєкту (costs.jsonl) і за щойно завершений запуск стадії.
 * Стадія може запускатись у ревізії кілька разів (check, fix, render), тому записи (stage, rev)
 * рахуються від курсора `seen` — скільки їх уже віднесено до попередніх запусків.
 * Повертає подію і новий курсор.
 */
export async function buildStageCostEvent(
  storage: Storage,
  projectId: string,
  stage: CostStage,
  rev: number,
  seen: number,
): Promise<{ event: ChatEventInput; seen: number }> {
  const costs = await readCosts(storage, projectId);
  const mine = costs.filter((e) => e.stage === stage && e.rev === rev);
  const stageUsd = sumUsd(mine.slice(seen));
  return {
    event: { type: "cost", totalUsd: round(sumUsd(costs)), stage, stageUsd: round(stageUsd) },
    seen: mine.length,
  };
}

/** Подія `cost` для виклику з відомою вартістю (chat-intent, chat-reply). */
export async function buildCostEvent(
  storage: Storage,
  projectId: string,
  stage: CostStage,
  stageUsd: number,
): Promise<ChatEventInput> {
  const costs = await readCosts(storage, projectId);
  return { type: "cost", totalUsd: round(sumUsd(costs)), stage, stageUsd: round(stageUsd) };
}

// ─────────────────────────────── видача ───────────────────────────────

export async function buildDelivery(
  storage: Storage,
  project: ProjectState,
  rev: number,
  formats: Format[],
): Promise<ChatEventInput[]> {
  const rp = projectPaths(project.id).rev(rev);
  const events: ChatEventInput[] = [];
  for (const format of formats) {
    const key = rp.render(format);
    if (await storage.exists(key)) {
      events.push({
        type: "artifact",
        rev,
        kind: "video",
        url: storage.publicUrl(key),
        format,
        sceneId: null,
      });
    }
  }
  if (await storage.exists(rp.poster)) {
    events.push({
      type: "artifact",
      rev,
      kind: "poster",
      url: storage.publicUrl(rp.poster),
      format: primaryFormat(formats),
      sceneId: null,
    });
  }
  const costs = await readCosts(storage, project.id);
  const total = round(sumUsd(costs));
  const breakdown = groupUsd(costs, (e) => e.stage).map((g) => ({ stage: g.key, usd: round(g.usd) }));
  const lines = [t("delivered"), "", t("costLine", { usd: money(total) }), t("costBreakdown")];
  for (const b of breakdown) lines.push(`- ${b.stage}: ${money(b.usd)} $`);
  lines.push("", t("deliveredHint"));
  events.push({ type: "message", role: "assistant", text: lines.join("\n") });
  events.push({ type: "cost", totalUsd: total, stage: null, stageUsd: 0, breakdown });
  return events;
}
