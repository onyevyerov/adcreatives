import {
  CheckReport,
  countSerious,
  type Format,
  type ImageInput,
  inputsHash,
  type QaIssue,
  QaReport,
  revPaths,
  STILL_PLAN,
  type Stage,
  type StageContext,
  StageError,
  type Storage,
  sha256,
} from "@adc/shared";
import sharp from "sharp";
import { z } from "zod";
import {
  baseRevOf,
  directorPaths,
  formatsOf,
  llmStageError,
  progress,
  readCurrentBrandKit,
  readOptional,
  readProject,
  readStoryboard,
  readTemplateScenes,
} from "../io.ts";
import { writeScenesIndex } from "../job.ts";
import { readLedger, rejectedScenes, type SceneLedger, type SceneVersion, writeLedger } from "../ledger.ts";
import { buildSceneImage, QA_IMAGE_MAX_SIDE, type SheetCell } from "../sheets.ts";
import { rebuildSheets, replaceSceneData } from "./check.ts";

export const QA_PROMPT = "qa";

export const QaMeta = z.object({ inputsHash: z.string() });

/** Зображення сцени для image block: JPEG, довша сторона ≤ `QA_IMAGE_MAX_SIDE`. */
async function sceneImage(png: Buffer): Promise<ImageInput> {
  const data = await sharp(png)
    .resize(QA_IMAGE_MAX_SIDE, QA_IMAGE_MAX_SIDE, { fit: "inside", withoutEnlargement: true })
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .jpeg({ quality: 85 })
    .toBuffer();
  return { mediaType: "image/jpeg", data };
}

/** Кадри e/a/b сцени в одному форматі для QA (порядок — `STILL_PLAN`). */
export interface QaSceneImage {
  sceneId: string;
  format: Format;
  /** PNG з `buildSceneImage`. */
  png: Buffer;
  /** Хеші стілів у порядку `STILL_PLAN` (null — кадру немає) — для хешу входів. */
  stills: Array<string | null>;
}

/**
 * Зображення для QA: на кожну сцену зі scope і кожен формат — одне зображення з кадрами e/a/b.
 * Сцена/формат без жодного стілу (помилка рендера) пропускається; відсутній окремий кадр (напр.,
 * check.json без `e`) — сіра перекреслена клітинка.
 */
export async function qaSceneImages(
  storage: Storage,
  check: CheckReport,
  scope: readonly string[],
  formats: readonly Format[],
): Promise<QaSceneImage[]> {
  const out: QaSceneImage[] = [];
  for (const sceneId of scope) {
    for (const format of formats) {
      const cells: SheetCell[] = [];
      const stills: Array<string | null> = [];
      for (const { variant, fraction } of STILL_PLAN) {
        const still = check.stills.find(
          (s) => s.sceneId === sceneId && s.format === format && s.variant === variant,
        );
        const png = still && (await storage.exists(still.path)) ? await storage.read(still.path) : null;
        stills.push(png ? sha256(png) : null);
        cells.push({
          sceneId,
          variant,
          png,
          label: `${sceneId} · ${Math.round(fraction * 100)}%${still ? ` · кадр ${still.frame}` : ""}`,
          note: "немає кадру",
        });
      }
      if (stills.every((h) => h === null)) continue;
      out.push({ sceneId, format, png: await buildSceneImage(format, cells), stills });
    }
  }
  return out;
}

const FRAMES_LEGEND = STILL_PLAN.map((p) => Math.round(p.fraction * 100)).join("/");

export interface RollbackResult {
  /** sceneId → номер версії, до якої повернулись. */
  restored: Record<string, number>;
  written: string[];
}

/**
 * Вибір кращої версії кожної сцени зі `scope`: серед версій, що пройшли guard і check без помилок і
 * мають оцінку qa, лишається та, що має найменше серйозних зауважень (за рівності — поточна).
 * Якщо краща — не поточна, відновлюються її код, стіли, записи check.json і зауваження qa.
 */
export async function keepBestVersions(args: {
  storage: Storage;
  projectId: string;
  rev: number;
  ledger: SceneLedger;
  scope: readonly string[];
  check: CheckReport;
  issues: QaIssue[];
}): Promise<RollbackResult & { issues: QaIssue[] }> {
  const { storage, projectId, rev, ledger, check } = args;
  const rp = revPaths(projectId, rev);
  const dp = directorPaths(projectId, rev);
  let issues = args.issues;
  const restored: Record<string, number> = {};
  const written: string[] = [];
  for (const id of args.scope) {
    const entry = ledger.scenes[id];
    if (!entry) continue;
    const current = entry.versions.find((v) => v.v === entry.current);
    if (!current?.qa) continue;
    const usable = (v: SceneVersion) =>
      v.guardOk &&
      v.qa !== null &&
      v.check !== null &&
      v.check.compileErrors.length === 0 &&
      v.check.runtimeErrors.length === 0;
    const candidates = entry.versions.filter(usable);
    if (candidates.length === 0) continue;
    const best = candidates.reduce((a, b) => {
      const sa = a.qa?.serious ?? Number.POSITIVE_INFINITY;
      const sb = b.qa?.serious ?? Number.POSITIVE_INFINITY;
      if (sa !== sb) return sa < sb ? a : b;
      if (a.v === entry.current) return a;
      if (b.v === entry.current) return b;
      return a.v > b.v ? a : b;
    });
    if (best.v === entry.current || !best.check || !best.qa) continue;
    if ((current.qa.serious ?? 0) <= best.qa.serious && usable(current)) continue;

    const codeKey = dp.version(id, best.v);
    if (!(await storage.exists(codeKey))) continue;
    await storage.copy(codeKey, rp.scene(id));
    written.push(rp.scene(id));
    for (const s of best.check.stills) {
      const copy = dp.versionStill(id, best.v, s.format, s.variant);
      if (await storage.exists(copy)) {
        await storage.copy(copy, s.path);
        written.push(s.path);
      }
    }
    replaceSceneData(check, id, best.check, true);
    issues = [...issues.filter((i) => i.sceneId !== id), ...best.qa.issues];
    entry.current = best.v;
    restored[id] = best.v;
  }
  return { restored, written, issues };
}

/**
 * Стадія `qa`: зображення сцен зі scope (кадри 25/50/90% у кожному обраному форматі) + autoIssues →
 * `qa.json`. Сцени поза scope моделі не показуються — повторний QA після fix дешевший.
 */
export function createQaStage(): Stage<"qa"> {
  return async (ctx: StageContext<"qa">) => {
    const { storage, projectId, rev, logger } = ctx;
    const rp = revPaths(projectId, rev);
    const dp = directorPaths(projectId, rev);
    const project = await readProject(storage, projectId);
    const brandFile = await readCurrentBrandKit(storage, projectId, project);
    const storyboard = await readStoryboard(storage, projectId, rev);
    const formats = formatsOf(project);
    const templates = new Set(await readTemplateScenes(storage, projectId, rev));
    const check = await readOptional(storage, rp.check, (v) => CheckReport.parse(v), logger);
    if (!check) {
      throw new StageError(
        `qa: немає ${rp.check}`,
        "check_missing",
        "Спершу потрібна перевірка кадрів.",
        false,
      );
    }
    const allIds = storyboard.scenes.map((s) => s.id);
    const scope = (ctx.params.sceneIds ?? allIds).filter((id) => allIds.includes(id) && !templates.has(id));
    // Зауваження сцен поза scope: з qa.json цієї ревізії, а в новій ревізії — з ревізії-основи.
    const baseForQa = baseRevOf(project, rev);
    const previous =
      (await readOptional(storage, rp.qa, (v) => QaReport.parse(v), logger)) ??
      (baseForQa !== null
        ? await readOptional(storage, revPaths(projectId, baseForQa).qa, (v) => QaReport.parse(v), logger)
        : null);

    await progress(ctx, "qa", "Перевіряю кадри…");
    const images = await qaSceneImages(storage, check, scope, formats);
    if (scope.length > 0 && images.length === 0) {
      throw new StageError(
        "qa: немає стілів сцен для перевірки",
        "sheets_missing",
        "Немає кадрів для перевірки.",
        true,
      );
    }
    const autoIssues = check.autoIssues.filter((i) => scope.includes(i.sceneId));
    const vars = {
      language: project?.language ?? brandFile.identity.language,
      formats: formats.filter((f) => images.some((img) => img.format === f)).join(", ") || "(немає)",
      scope: scope.join(", ") || "(немає)",
      sheetsLegend:
        images
          .map(
            (img, i) =>
              `Image ${i + 1}: scene ${img.sceneId}, format ${img.format}, frames ${FRAMES_LEGEND}%`,
          )
          .join("\n") || "(немає зображень)",
      storyboard: storyboard.scenes.map((s) => ({
        id: s.id,
        purpose: s.purpose,
        durationSec: Math.round((s.durationFrames / storyboard.fps) * 10) / 10,
        text: s.text,
        layoutIntent: s.layoutIntent,
        assetIds: s.assetIds,
        template: templates.has(s.id),
      })),
      palette: brandFile.palette,
      logo: { type: brandFile.logo.type, textFallback: brandFile.logo.textFallback },
      autoIssues,
      failedScenes: [...new Set([...check.compileErrors, ...check.runtimeErrors].map((e) => e.sceneId))],
    };
    const promptHash = ctx.prompts.load(QA_PROMPT, vars).hash;
    const hash = inputsHash({
      images: images.map((img) => [img.sceneId, img.format, img.stills]),
      autoIssues,
      scope,
      vars: { ...vars, autoIssues: null },
      prompt: promptHash,
    });

    // Пропуск за хешем входів: ті самі стіли в ревізії-основі.
    const base = baseRevOf(project, rev);
    if (base !== null) {
      const baseMeta = await readOptional(storage, directorPaths(projectId, base).qaMeta, (v) =>
        QaMeta.parse(v),
      );
      const baseQa = await readOptional(storage, revPaths(projectId, base).qa, (v) => QaReport.parse(v));
      if (baseMeta?.inputsHash === hash && baseQa) {
        await storage.writeJson(rp.qa, baseQa);
        await storage.writeJson(dp.qaMeta, { inputsHash: hash });
        return {
          artifacts: [rp.qa],
          outputs: { verdict: baseQa.verdict, seriousScenes: seriousScenes(baseQa.issues) },
          reused: true,
          inputsHash: hash,
        };
      }
    }

    let report: QaReport;
    if (scope.length === 0) {
      report = { verdict: "pass", issues: [], summary: "Немає сцен для перевірки (усі — шаблони)." };
    } else {
      try {
        const res = await ctx.llm.structured(QA_PROMPT, vars, QaReport, {
          images: await Promise.all(images.map((img) => sceneImage(img.png))),
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        report = res.data;
      } catch (err) {
        return llmStageError(err, "перевірка кадрів");
      }
    }

    // Лише сцени зі scope і обрані формати; зауваження інших сцен — з попереднього qa.json ревізії.
    const fresh = report.issues.filter((i) => scope.includes(i.sceneId) && formats.includes(i.format));
    const kept = (previous?.issues ?? []).filter(
      (i) => !scope.includes(i.sceneId) && allIds.includes(i.sceneId),
    );
    let issues = [...kept, ...fresh];

    // Журнал версій: оцінка поточної версії і вибір кращої.
    const ledger = await readLedger(storage, projectId, rev);
    for (const id of scope) {
      const entry = ledger.scenes[id];
      const ver = entry?.versions.find((v) => v.v === entry.current);
      if (ver) {
        const own = fresh.filter((i) => i.sceneId === id);
        ver.qa = { serious: countSerious(own), issues: own };
      }
    }
    const rollback = await keepBestVersions({ storage, projectId, rev, ledger, scope, check, issues });
    issues = rollback.issues;
    const artifacts = new Set<string>(rollback.written);
    if (Object.keys(rollback.restored).length > 0) {
      logger.info("qa: повернуто кращі версії сцен", { restored: rollback.restored });
      for (const k of await rebuildSheets(storage, projectId, rev, allIds, formats, check)) artifacts.add(k);
      await storage.writeJson(rp.check, CheckReport.parse(check));
      artifacts.add(rp.check);
      artifacts.add(
        (
          await writeScenesIndex(storage, projectId, rev, storyboard, [
            ...rejectedScenes(ledger),
            ...templates,
          ])
        ).key,
      );
    }
    if (Object.keys(ledger.scenes).length) artifacts.add(await writeLedger(storage, projectId, rev, ledger));

    // Вердикт детермінований: лишились серйозні зауваження (major/critical) → fix.
    const final: QaReport = QaReport.parse({
      verdict: countSerious(issues) > 0 ? "fix" : "pass",
      issues,
      summary: report.summary,
    });
    await storage.writeJson(rp.qa, final);
    await storage.writeJson(dp.qaMeta, { inputsHash: hash });
    artifacts.add(rp.qa);

    return {
      artifacts: [...artifacts],
      outputs: { verdict: final.verdict, seriousScenes: seriousScenes(final.issues) },
      inputsHash: hash,
    };
  };
}

function seriousScenes(issues: readonly QaIssue[]): string[] {
  return [...new Set(issues.filter((i) => i.severity !== "minor").map((i) => i.sceneId))];
}

export const qaStage: Stage<"qa"> = createQaStage();
