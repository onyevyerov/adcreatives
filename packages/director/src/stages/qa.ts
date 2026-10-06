import {
  CheckReport,
  countSerious,
  type Format,
  type ImageInput,
  inputsHash,
  type QaIssue,
  QaReport,
  revPaths,
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
import { rebuildSheets, replaceSceneData } from "./check.ts";

export const QA_PROMPT = "qa";

export const QaMeta = z.object({ inputsHash: z.string() });

/** Аркуш для image block: JPEG, довша сторона ≤ 2400 px. */
async function sheetImage(png: Buffer): Promise<ImageInput> {
  const data = await sharp(png)
    .resize(2400, 2400, { fit: "inside", withoutEnlargement: true })
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .jpeg({ quality: 85 })
    .toBuffer();
  return { mediaType: "image/jpeg", data };
}

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

/** Стадія `qa`: зведені аркуші всіх обраних форматів + autoIssues → `qa.json`. */
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
    const sheets: Array<{ format: Format; png: Buffer }> = [];
    for (const format of formats) {
      const ref = check.sheets.find((s) => s.format === format);
      if (ref && (await storage.exists(ref.path))) sheets.push({ format, png: await storage.read(ref.path) });
    }
    if (sheets.length === 0) {
      throw new StageError(
        "qa: немає зведених аркушів",
        "sheets_missing",
        "Немає кадрів для перевірки.",
        true,
      );
    }
    const autoIssues = check.autoIssues.filter((i) => scope.includes(i.sceneId));
    const vars = {
      language: project?.language ?? brandFile.identity.language,
      formats: sheets.map((s) => s.format).join(", "),
      scope: scope.join(", ") || "(немає)",
      sheetsLegend: sheets
        .map(
          (s, i) =>
            `Image ${i + 1}: format "${s.format}". One column per scene in storyboard order (${allIds.join(", ")}); ` +
            "top cell = still at 50% of the scene, bottom cell = still at 90%. A grey crossed cell = no still (error).",
        )
        .join("\n"),
      storyboard: storyboard.scenes.map((s) => ({
        id: s.id,
        purpose: s.purpose,
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
      sheets: sheets.map((s) => sha256(s.png)),
      autoIssues,
      scope,
      vars: { ...vars, autoIssues: null },
      prompt: promptHash,
    });

    // Пропуск за хешем входів: ті самі аркуші в ревізії-основі.
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
          images: await Promise.all(sheets.map((s) => sheetImage(s.png))),
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
