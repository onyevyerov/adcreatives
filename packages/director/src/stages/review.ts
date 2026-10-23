import {
  applySfxPlan,
  CheckReport,
  computeTimeline,
  effectiveVerdict,
  FilmReview,
  FilmReviewDraft,
  type Format,
  formatSoundSheet,
  GRID_SOUND_CUES,
  type ImageInput,
  inputsHash,
  momentLegend,
  primaryFormat,
  QaReport,
  type ReviewIssue,
  revPaths,
  routeOf,
  SfxPlan,
  SoundCue,
  SoundSheet,
  STAGE_STEPS,
  type Stage,
  type StageContext,
  StageError,
  type Storage,
  type Storyboard,
  sha256,
} from "@adc/shared";
import {
  baseRevOf,
  formatsOf,
  llmStageError,
  progress,
  readCurrentBrandKit,
  readOptional,
  readProject,
  readStoryboard,
  readTemplateScenes,
} from "../io.ts";
import { qaSceneImages, qaStoryboard, toQaJpeg } from "./qa.ts";

export const REVIEW_PROMPT = "review";

export type ReviewStageDeps = Record<string, never>;

/** Текст замість відомості, коли зведення її не написало: звук не судити. */
export const NO_SOUND_SHEET = "(no sound sheet: do not judge sound)";

interface ReviewImage {
  sceneId: string | null;
  format: Format;
  kind: "strip" | "stills" | "moments" | "sheet";
  image: ImageInput;
  hash: string;
  legend: string;
}

/**
 * Зображення рецензента в порядку ролика: для кожної сцени в головному форматі — стрічка (або запасні
 * кадри) і аркуш моментів, якщо він є; далі по одному загальному аркушу на кожен інший обраний формат.
 */
async function reviewImages(
  storage: Storage,
  check: CheckReport,
  sb: Storyboard,
  formats: readonly Format[],
  format: Format,
  templates: ReadonlySet<string>,
  rp: ReturnType<typeof revPaths>,
): Promise<ReviewImage[]> {
  const ids = sb.scenes.map((s) => s.id);
  const strips = await qaSceneImages(storage, check, ids, [format], sb, rp);
  const out: ReviewImage[] = [];
  for (const [index, scene] of sb.scenes.entries()) {
    const mark = templates.has(scene.id) ? " (template scene: context only, do not judge)" : "";
    const strip = strips.find((s) => s.sceneId === scene.id);
    if (strip) out.push({ ...strip, legend: `${strip.legend}${mark}` });
    const sheet = check.moments.find((m) => m.sceneId === scene.id && m.format === format);
    if (scene.events.length === 0 || !sheet || !(await storage.exists(sheet.path))) continue;
    const data = await storage.read(sheet.path);
    out.push({
      sceneId: scene.id,
      format,
      kind: "moments",
      image: await toQaJpeg(data),
      hash: sha256(data),
      legend: `${momentLegend(scene, format, sb.fps, index < sb.scenes.length - 1)}${mark}`,
    });
  }
  for (const other of formats.filter((f) => f !== format)) {
    const sheet = check.sheets.find((s) => s.format === other);
    if (!sheet || !(await storage.exists(sheet.path))) continue;
    const data = await storage.read(sheet.path);
    out.push({
      sceneId: null,
      format: other,
      kind: "sheet",
      image: await toQaJpeg(data),
      hash: sha256(data),
      legend:
        `contact sheet of the whole film, format ${other}: every scene at 25%, 50% and 90% of its length, ` +
        "in storyboard order; only to see whether the composition holds in this format",
    });
  }
  return out;
}

function imagesLegend(images: readonly ReviewImage[], sb: Storyboard, format: Format): string {
  const lines = images.map((img, i) => `Image ${i + 1}: ${img.legend.replaceAll("\n", "\n  ")}`);
  for (const scene of sb.scenes) {
    if (!images.some((img) => img.sceneId === scene.id)) {
      lines.push(
        `Scene ${scene.id}: no frames in ${format} (render failed), judge it from the storyboard only.`,
      );
    } else if (
      scene.events.length > 0 &&
      !images.some((img) => img.sceneId === scene.id && img.kind === "moments")
    ) {
      lines.push(`Scene ${scene.id}: no moment sheet, judge its moments from the strip.`);
    }
  }
  return lines.join("\n") || "(no images)";
}

/** Підпис кроку `review` чекліста (`STAGE_STEPS.directing`). */
const REVIEW_STEP_LABEL = STAGE_STEPS.directing.find((s) => s.id === "review")?.label ?? "review";

const round = (x: number, digits: number) => Math.round(x * 10 ** digits) / 10 ** digits;

/**
 * Розкадровка для рецензента: як у QA (задум, тексти, моменти зі звуком — уже за планом звукорежисера,
 * шаблонність) + де сцена стоїть у ролику і як у ній звучить музика.
 */
export function reviewStoryboard(sb: Storyboard, templates: ReadonlySet<string>) {
  const base = qaStoryboard(sb, templates);
  const timeline = computeTimeline(sb);
  const mixOf = (id: string) => sb.musicBrief.structure.find((p) => p.sceneIds.includes(id))?.mix ?? null;
  return {
    ...base,
    totalSec: round(timeline.durationSeconds, 2),
    scenes: base.scenes.map((s, i) => {
      const from = timeline.scenes[i]?.from ?? 0;
      return { ...s, startFrame: from, startSec: round(from / sb.fps, 2), musicMix: mixOf(s.id) };
    }),
  };
}

/** Що арт-директор лишив відкритим у `qa.json` (що вже правили — не повторювати). */
function qaText(qa: QaReport | null): string {
  if (!qa) return "(no art director's check)";
  const lines = qa.issues.map(
    (i) => `- [${i.severity}, ${i.format}, ${i.kind}] ${i.sceneId}: ${i.description}`,
  );
  return [`Summary: ${qa.summary}`, "Remarks still open:", ...(lines.length ? lines : ["(none)"])].join("\n");
}

/** Зауваження попереднього кола цієї ревізії: що просили виправити. */
function previousText(previous: FilmReview | null, roundNo: number): string {
  if (roundNo === 0 || !previous || previous.round >= roundNo) return "(none)";
  if (previous.issues.length === 0) return "(none)";
  return previous.issues
    .map((i) => `- [${i.kind}, ${i.severity}] ${placeOf(i)}: ${i.description} → ${i.fix}`)
    .join("\n");
}

function placeOf(i: ReviewIssue): string {
  const where =
    i.scope === "film"
      ? "film"
      : i.scope === "join"
        ? `join ${i.sceneId ?? "?"} → ${i.nextSceneId ?? "?"}`
        : (i.sceneId ?? "?");
  return [where, i.eventId ? `event ${i.eventId}` : null, i.frame !== null ? `frame ${i.frame}` : null]
    .filter(Boolean)
    .join(", ");
}

/** Відкинуте зауваження моделі і чому. */
export interface DroppedIssue {
  issue: ReviewIssue;
  why: "unknown_scene" | "template_scene" | "no_sound_sheet";
}

/**
 * Дисципліна кодом після відповіді моделі: невідомі сцени й template-сцени відкидаються; без
 * відомості звуку `sfx_*`/`music_*` відкидаються; `nextSceneId` для `join` — наступна сцена розкадровки
 * (що б не сказала модель); кадр поза сценою → null. Вхід не мутується.
 */
export function sanitizeIssues(
  sb: Storyboard,
  issues: readonly ReviewIssue[],
  templates: ReadonlySet<string>,
  hasSoundSheet: boolean,
): { kept: ReviewIssue[]; dropped: DroppedIssue[] } {
  const ids = sb.scenes.map((s) => s.id);
  const kept: ReviewIssue[] = [];
  const dropped: DroppedIssue[] = [];
  for (const raw of issues) {
    const issue: ReviewIssue = { ...raw };
    if (!hasSoundSheet && routeOf(issue.kind) !== "fix") {
      dropped.push({ issue: raw, why: "no_sound_sheet" });
      continue;
    }
    if (issue.scope === "film") {
      kept.push({ ...issue, sceneId: null, nextSceneId: null, frame: null });
      continue;
    }
    const index = issue.sceneId === null ? -1 : ids.indexOf(issue.sceneId);
    if (index < 0) {
      dropped.push({ issue: raw, why: "unknown_scene" });
      continue;
    }
    // Склейка — завжди з наступною сценою розкадровки (у останньої сцени склейки немає).
    issue.nextSceneId = issue.scope === "join" ? (ids[index + 1] ?? null) : null;
    const sides = [issue.sceneId, issue.nextSceneId].filter((s): s is string => s !== null);
    if (sides.every((s) => templates.has(s))) {
      dropped.push({ issue: raw, why: "template_scene" });
      continue;
    }
    const duration = sb.scenes[index]?.durationFrames ?? 0;
    if (issue.frame !== null && (issue.frame < 0 || issue.frame >= duration)) issue.frame = null;
    kept.push(issue);
  }
  return { kept, dropped };
}

/**
 * Маршрути за типом зауваження (`routeOf`): `fix`/`sfx` — сцени з major/critical зауваженнями (як у
 * `effectiveVerdict`: minor не тягне сцену на коло) в порядку розкадровки, для `join` — обидві сторони
 * склейки, без template-сцен; `music` — кількість усіх музичних зауважень. Зауваження на весь фільм
 * (`scope: film`) сцени не додають.
 */
export function routesOf(
  sb: Pick<Storyboard, "scenes">,
  issues: readonly ReviewIssue[],
  templates: ReadonlySet<string>,
): FilmReview["routes"] {
  const scenesOf = (route: "fix" | "sfx") => {
    const set = new Set<string>();
    for (const i of issues) {
      if (i.severity === "minor" || routeOf(i.kind) !== route) continue;
      if (i.sceneId !== null) set.add(i.sceneId);
      if (i.scope === "join" && i.nextSceneId !== null) set.add(i.nextSceneId);
    }
    return sb.scenes.map((s) => s.id).filter((id) => set.has(id) && !templates.has(id));
  };
  return {
    fix: scenesOf("fix"),
    sfx: scenesOf("sfx"),
    music: issues.filter((i) => routeOf(i.kind) === "music").length,
  };
}

/**
 * Стадія `review` (рецензент фільму): стрічки й аркуші моментів усіх сцен у головному форматі, загальні
 * аркуші інших форматів, звукова відомість (`sound-sheet.json`, необов'язкова), нотатки звукорежисера,
 * відкриті зауваження QA, розкадровка з ефективним звуком → `rev/<n>/review.json`.
 * Вердикт і маршрути ставить код (`effectiveVerdict`, `routesOf`); вердикт моделі — дорадчий. Пропуск за
 * хешем входів (зображення, відомість, розкадровка, коло, нотатки, QA, промпт) — у цій ревізії або в основі.
 */
export function createReviewStage(_deps: ReviewStageDeps = {}): Stage<"review"> {
  return async (ctx: StageContext<"review">) => {
    const { storage, projectId, rev, logger } = ctx;
    const roundNo = ctx.params.round;
    const rp = revPaths(projectId, rev);
    const project = await readProject(storage, projectId);
    const brandFile = await readCurrentBrandKit(storage, projectId, project);
    const draftStoryboard = await readStoryboard(storage, projectId, rev);
    const formats = formatsOf(project);
    const format = primaryFormat(formats);
    const templates = new Set(await readTemplateScenes(storage, projectId, rev));
    const check = await readOptional(storage, rp.check, (v) => CheckReport.parse(v), logger);
    if (!check) {
      throw new StageError(
        `review: немає ${rp.check}`,
        "check_missing",
        "Спершу потрібна перевірка кадрів.",
        false,
      );
    }
    const sfxPlan = await readOptional(storage, rp.sfxPlan, (v) => SfxPlan.parse(v), logger);
    const soundSheet = await readOptional(storage, rp.soundSheet, (v) => SoundSheet.parse(v), logger);
    const qa = await readOptional(storage, rp.qa, (v) => QaReport.parse(v), logger);
    const parseReview = (v: unknown) => FilmReview.parse(v);
    const ownReview = await readOptional(storage, rp.review, parseReview, logger);
    // Звук, який реально звучить: план звукорежисера поверх чернетки розкадровки.
    const storyboard = applySfxPlan(draftStoryboard, sfxPlan).storyboard;
    if (!soundSheet)
      logger.warn("review: немає звукової відомості — звук не оцінюється", { key: rp.soundSheet });

    await progress(ctx, "review", REVIEW_STEP_LABEL, null, null, "review");
    const images = await reviewImages(storage, check, storyboard, formats, format, templates, rp);
    if (images.length === 0) {
      throw new StageError(
        "review: немає кадрів сцен",
        "sheets_missing",
        "Немає кадрів для рецензента.",
        false,
      );
    }

    const vars = {
      language: project?.language ?? brandFile.identity.language,
      format,
      formats: formats.join(", "),
      round: roundNo,
      sheetsLegend: imagesLegend(images, storyboard, format),
      storyboard: reviewStoryboard(storyboard, templates),
      musicBrief: storyboard.musicBrief,
      soundSheet: soundSheet ? formatSoundSheet(soundSheet, storyboard) : NO_SOUND_SHEET,
      sfxNotes: sfxPlan?.notes || "(none)",
      qa: qaText(qa),
      previousReview: previousText(ownReview, roundNo),
      templateScenes: [...templates].join(", ") || "(none)",
      gridCues: SoundCue.options.filter((c) => GRID_SOUND_CUES.has(c)).join(", "),
    };
    const promptHash = ctx.prompts.load(REVIEW_PROMPT, vars).hash;
    const hash = inputsHash({
      images: images.map((img) => [img.sceneId, img.format, img.kind, img.hash]),
      soundSheet,
      storyboard,
      round: roundNo,
      // previousReview — похідне від попереднього кола (його review.json перезаписується цим колом),
      // тож у хеш не входить: інакше повтор того самого кола не був би `reused`.
      vars: { ...vars, storyboard: null, soundSheet: null, sheetsLegend: null, previousReview: null },
      prompt: promptHash,
    });

    // Пропуск за хешем: рецензія цієї ревізії або ревізії-основи з тими самими входами.
    const base = baseRevOf(project, rev);
    const baseReview =
      base !== null
        ? await readOptional(storage, revPaths(projectId, base).review, parseReview, logger)
        : null;
    for (const prev of [ownReview, baseReview]) {
      if (prev?.inputsHash !== hash) continue;
      if (prev !== ownReview) await storage.writeJson(rp.review, prev);
      return {
        artifacts: [rp.review],
        outputs: { verdict: prev.verdict, score: prev.score, routes: prev.routes },
        reused: true,
        inputsHash: hash,
      };
    }

    let draft: FilmReviewDraft;
    try {
      draft = (
        await ctx.llm.structured(REVIEW_PROMPT, vars, FilmReviewDraft, {
          images: images.map((img) => img.image),
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        })
      ).data;
    } catch (err) {
      return llmStageError(err, "рецензія ролика");
    }

    const { kept, dropped } = sanitizeIssues(storyboard, draft.issues, templates, soundSheet !== null);
    if (dropped.length > 0) {
      logger.warn("review: відкинуто зауваження рецензента", {
        dropped: dropped.map((d) => `${d.why}: ${d.issue.kind} ${placeOf(d.issue)}`),
      });
    }
    const verdict = effectiveVerdict(kept);
    if (verdict !== draft.verdict) {
      logger.info("review: вердикт коду відрізняється від вердикту моделі", {
        model: draft.verdict,
        code: verdict,
      });
    }
    const review = FilmReview.parse({
      version: 1,
      round: roundNo,
      inputsHash: hash,
      verdict,
      score: draft.score,
      issues: kept,
      summary: draft.summary,
      routes: routesOf(storyboard, kept, templates),
    });
    await storage.writeJson(rp.review, review);
    return {
      artifacts: [rp.review],
      outputs: { verdict: review.verdict, score: review.score, routes: review.routes },
      inputsHash: hash,
    };
  };
}

export const reviewStage: Stage<"review"> = createReviewStage();
