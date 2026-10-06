import { applyPatch } from "@adc/brandkit";
import {
  computeTimeline,
  type JsonPatchOp,
  RevisionPlan,
  revPaths,
  type Stage,
  type StageContext,
  StageError,
  Storyboard,
  stableStringify,
  t,
} from "@adc/shared";
import { verifyClaims } from "../claims.ts";
import {
  baseRevOf,
  directorPaths,
  formatsOf,
  llmStageError,
  progress,
  readAssets,
  readCurrentBrandKit,
  readOptional,
  readProject,
} from "../io.ts";
import { normalizeStoryboard } from "../normalize.ts";
import { assetsForPrompt, brandForScript, knownAssetIds } from "./storyboard.ts";

export const REVISE_PROMPT = "revise";

export interface RevisionRecord {
  plan: RevisionPlan;
  applied: JsonPatchOp[];
  skipped: Array<{ op: JsonPatchOp; reason: string }>;
  /** Сцени, які треба перегенерувати (план + нові сцени), з інструкціями — для codegen. */
  scenesToRegenerate: Array<{ sceneId: string; instruction: string }>;
  changes: string[];
  basedOnRev: number | null;
}

/**
 * Стадія `revise`: репліка клієнта → `RevisionPlan` (Opus, structured) → JSON Patch до розкадровки
 * ревізії-основи → `normalizeStoryboard` + `verifyClaims` → `rev/<n>/storyboard.json`, `claims.json`
 * і `director/revision.json` (план з інструкціями: codegen бере їх звідти, якщо їх немає в params).
 *
 * Розкадровка-джерело: ревізія-основа (`revisions[n].basedOn`, інакше n−1); якщо її немає —
 * поточна ревізія (правка на чекпоінті 2 у тій самій ревізії).
 */
export function createReviseStage(opts: { now?: () => Date } = {}): Stage<"revise"> {
  const now = opts.now ?? (() => new Date());
  return async (ctx: StageContext<"revise">) => {
    const { storage, projectId, rev, params, logger } = ctx;
    const rp = revPaths(projectId, rev);
    const dp = directorPaths(projectId, rev);
    await progress(ctx, "revise", t("revisionStarted"));

    const project = await readProject(storage, projectId);
    const brandFile = await readCurrentBrandKit(storage, projectId, project);
    const manifest = await readAssets(storage, projectId);
    const formats = formatsOf(project);
    const base = baseRevOf(project, rev);
    let sourceRev = rev;
    let current: Storyboard | null = null;
    if (base !== null) {
      current = await readOptional(storage, revPaths(projectId, base).storyboard, (v) => Storyboard.parse(v));
      if (current) sourceRev = base;
    }
    current ??= await readOptional(storage, rp.storyboard, (v) => Storyboard.parse(v));
    if (!current) {
      throw new StageError(
        `revise: немає розкадровки ревізії ${base ?? rev}`,
        "storyboard_missing",
        "Немає сценарію, до якого можна застосувати правку.",
        false,
      );
    }

    const vars = {
      at: params.at,
      language: project?.language ?? brandFile.identity.language,
      formats: formats.join(", "),
      durationSeconds: project?.durationSeconds ?? null,
      storyboard: current,
      brand: brandForScript(brandFile),
      facts: brandFile.facts,
      assets: assetsForPrompt(brandFile, manifest),
      message: params.text,
    };
    let plan: RevisionPlan;
    try {
      plan = (
        await ctx.llm.structured(REVISE_PROMPT, vars, RevisionPlan, ctx.signal ? { signal: ctx.signal } : {})
      ).data;
    } catch (err) {
      return llmStageError(err, "правка");
    }

    // Операція, що ламає схему, пропускається; таймінги потім доводить normalizeStoryboard.
    const patched = applyPatch(current, plan.storyboardPatch, (doc) => {
      const r = Storyboard.safeParse(doc);
      return r.success ? null : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    });
    if (patched.skipped.length)
      logger.warn("revise: частину операцій патча пропущено", { skipped: patched.skipped });

    const normalized = normalizeStoryboard(patched.doc, {
      assetIds: knownAssetIds(brandFile, manifest),
      factIds: brandFile.facts.map((f) => f.id),
      formats,
      durationSeconds: project?.durationSeconds ?? null,
    });
    const next = normalized.storyboard;
    const claims = verifyClaims(next, brandFile, { now: now() });

    // Що перегенерувати: план моделі (лише наявні сцени) + нові сцени, яких не було до правки.
    const oldIds = new Set(current.scenes.map((s) => s.id));
    const nextIds = new Set(next.scenes.map((s) => s.id));
    const regen = new Map<string, string>();
    for (const s of plan.scenesToRegenerate) if (nextIds.has(s.sceneId)) regen.set(s.sceneId, s.instruction);
    for (const s of next.scenes) {
      if (!oldIds.has(s.id) && !regen.has(s.id)) regen.set(s.id, "Нова сцена — згенеруй її за розкадровкою.");
    }
    const scenesToRegenerate = [...regen.entries()].map(([sceneId, instruction]) => ({
      sceneId,
      instruction,
    }));
    const musicChanged =
      plan.musicChanged || stableStringify(current.musicBrief) !== stableStringify(next.musicBrief);
    const durationChanged =
      plan.durationChanged || computeTimeline(current).totalFrames !== computeTimeline(next).totalFrames;

    await storage.writeJson(rp.storyboard, next);
    await storage.writeJson(rp.claims, claims);
    const record: RevisionRecord = {
      plan,
      applied: patched.applied,
      skipped: patched.skipped,
      scenesToRegenerate,
      changes: normalized.changes,
      basedOnRev: sourceRev === rev ? null : sourceRev,
    };
    await storage.writeJson(dp.revision, record);

    return {
      artifacts: [rp.storyboard, rp.claims, dp.revision],
      outputs: {
        scenesToRegenerate: scenesToRegenerate.map((s) => s.sceneId),
        musicChanged,
        durationChanged,
      },
    };
  };
}

export const reviseStage: Stage<"revise"> = createReviseStage();
