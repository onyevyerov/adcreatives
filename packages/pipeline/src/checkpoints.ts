import { brandCheckpointPayload, formatBrandSummaryText, summarizeBrandKit } from "@adc/brandkit";
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
  groupUsd,
  type ProjectState,
  primaryFormat,
  projectPaths,
  QaReport,
  type ReviewIssue,
  type ReviewRoute,
  readCosts,
  routeOf,
  type Storage,
  Storyboard,
  sumUsd,
  t,
} from "@adc/shared";
import { FORMAT_LABEL, formatsLabel } from "./labels.ts";

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
  const opts = { publicUrl: (k: string) => storage.publicUrl(k), formats: project.formats };
  const payload = brandCheckpointPayload(kit, assets, opts);
  const summary = summarizeBrandKit(kit, assets, opts);

  const lines = [t("brandCheckpointIntro"), "", formatBrandSummaryText(summary), ""];
  lines.push(`${t("askFormats")} Зараз обрано: ${formatsLabel(project.formats)}.`);
  if (payload.languageOptions.length > 1 && project.language === null) lines.push(t("askLanguage"));
  return [
    { type: "message", role: "assistant", text: lines.join("\n"), buttons: ["approve", "edit"] },
    { type: "checkpoint", rev, checkpoint: "brand", payload },
  ];
}

// ─────────────────────────── чекпоінт 2: тексти ───────────────────────────

/**
 * Рядок текстів `items` сцени для чекпоінта 2: `· текст · текст ⚠`; ⚠ — у пункті є непідтверджене
 * твердження. null — сцена без items.
 */
export function formatSceneItems(
  scene: Pick<Storyboard["scenes"][number], "id" | "items">,
  unverified: ReadonlyArray<Pick<ClaimsReport["unverified"][number], "sceneId" | "field" | "itemId">>,
): string | null {
  if (scene.items.length === 0) return null;
  const flagged = new Set(
    unverified.filter((c) => c.sceneId === scene.id && c.field === "item").map((c) => c.itemId),
  );
  return scene.items.map((i) => `· ${i.text}${flagged.has(i.id) ? " ⚠" : ""}`).join(" ");
}

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
  const sec = (frames: number) =>
    (Math.round((frames / storyboard.fps) * 10) / 10).toString().replace(".", ",");
  // ⚠ у рядку сцени — непідтверджене в headline/sub; у пунктах — біля самого пункту.
  const flagged = new Set(claims.unverified.filter((c) => c.field !== "item").map((c) => c.sceneId));
  const lines = [t("scriptCheckpointIntro"), "", `**${storyboard.concept}**`];
  // Наскрізний об'єкт — під концептом: власник бачить, що несе фільм через склейки (старі розкадровки — без рядка).
  if (storyboard.throughline) lines.push(t("scriptThroughline", { object: storyboard.throughline.object }));
  lines.push("");
  lines.push(t("scriptScenesHeader", { seconds: sec(timeline.totalFrames) }));
  storyboard.scenes.forEach((scene, i) => {
    const tl = timeline.scenes[i];
    const span = tl ? `${sec(tl.from)}–${sec(tl.end)} с` : "";
    const sub = scene.text.sub ? ` / ${scene.text.sub}` : "";
    lines.push(`${i + 1}. ${span} — ${scene.text.headline}${sub}${flagged.has(scene.id) ? " ⚠" : ""}`);
    const items = formatSceneItems(scene, claims.unverified);
    if (items) lines.push(`   ${items}`);
  });
  const mb = storyboard.musicBrief;
  lines.push("", `**Музика:** ${mb.genre}, ${mb.mood.join(", ")}, ~${mb.bpm} BPM`);
  if (claims.unverified.length > 0) {
    lines.push("", t("unverifiedClaimsNote"));
    for (const c of claims.unverified) lines.push(`- ⚠ «${c.text}»`);
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

/** Скільки зауважень рецензента показати власнику (як і попереджень QA). */
export const REVIEW_WARNINGS_LIMIT = 10;

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

/** Рядок зауваження: `- s1 → s2 [fix]: опис` (join), `- s2 [sfx]: …` (сцена), `- [music]: …` (фільм). */
export function formatReviewWarning(w: ReviewWarning): string {
  const where =
    w.sceneId === null ? "" : w.nextSceneId ? `${w.sceneId} → ${w.nextSceneId} ` : `${w.sceneId} `;
  return `- ${where}[${w.route}]: ${w.description}`;
}

/** `review.json` ревізії; зіпсований файл не ламає чекпоінт — тоді рецензії ніби не було. */
async function readReview(storage: Storage, key: string): Promise<FilmReview | null> {
  try {
    return await readOptional(storage, key, (v) => FilmReview.parse(v));
  } catch {
    return null;
  }
}

export async function buildStoryboardCheckpoint(
  storage: Storage,
  project: ProjectState,
  rev: number,
  opts: { templateScenes: string[]; changedScenes: string[] | null },
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

  const lines = [t("storyboardCheckpointIntro")];
  if (warnings.length > 0) {
    lines.push("", t("qaWarnings", { count: warnings.length }));
    for (const w of warnings.slice(0, 10)) {
      lines.push(`- ${w.sceneId} (${FORMAT_LABEL[w.format]}): ${w.description}`);
    }
  }
  const review = await readReview(storage, rp.review);
  const notes = review ? reviewWarnings(review, opts.templateScenes) : [];
  if (notes.length > 0) {
    lines.push("", t("reviewWarnings", { count: notes.length }));
    for (const w of notes.slice(0, REVIEW_WARNINGS_LIMIT)) lines.push(formatReviewWarning(w));
  }
  if (review) lines.push("", t("reviewScore", { score: review.score, summary: review.summary }));
  if (templates.size > 0) lines.push("", t("templateScenesNote", { scenes: [...templates].join(", ") }));

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
      },
    },
  ];
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
