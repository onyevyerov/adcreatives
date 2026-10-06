import {
  type Asset,
  type BrandKit,
  type Format,
  inputsHash,
  RevisionPlan,
  revPaths,
  type Scene,
  type Stage,
  type StageContext,
  StageError,
  type Storage,
  type Storyboard,
  t,
} from "@adc/shared";
import { z } from "zod";
import { type CodegenContext, contextVars, loadCodegenContext } from "../context.ts";
import { parseFileBlocks } from "../files.ts";
import { formatViolations, guardScene } from "../guard.ts";
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
  readStoryboard,
} from "../io.ts";
import { writeScenesIndex } from "../job.ts";
import {
  addVersion,
  carryScene,
  currentVersion,
  readCurrentCode,
  readLedger,
  rejectedScenes,
  writeLedger,
} from "../ledger.ts";
import { assetsForPrompt } from "./storyboard.ts";

export const CODEGEN_PROMPT = "codegen";

export const CodegenReport = z.object({
  mode: z.enum(["all", "subset", "reused"]),
  sceneIds: z.array(z.string()),
  guardRejected: z.array(z.string()),
  /** Сцени, перенесені з ревізії-основи без генерації. */
  carried: z.array(z.string()),
  violations: z.record(z.string(), z.array(z.string())),
  inputsHashes: z.record(z.string(), z.string()),
  missing: z.array(z.string()),
});
export type CodegenReport = z.infer<typeof CodegenReport>;

/** Дані бренду для коду сцен (тема і лого вже є в ThemeProvider — тут для розуміння стилю). */
export function brandForCode(brand: BrandKit) {
  return {
    name: brand.identity.name,
    category: brand.identity.category,
    language: brand.identity.language,
    palette: brand.palette,
    typography: { heading: brand.typography.heading.family, body: brand.typography.body.family },
    logo: { assetId: brand.logo.assetId, type: brand.logo.type, needsBackground: brand.logo.needsBackground },
    cta: brand.cta,
    visualStyle: brand.visualStyle,
  };
}

function sceneAssets(scene: Scene, manifest: readonly Asset[]) {
  const byId = new Map(manifest.map((a) => [a.id, a]));
  return scene.assetIds.map((id) => {
    const a = byId.get(id);
    return a ? [id, a.width, a.height] : [id];
  });
}

/** Хеш входів codegen однієї сцени: що змінилось — те генеруємо заново. */
export function sceneCodegenHash(args: {
  scene: Scene;
  storyboard: Storyboard;
  brand: BrandKit;
  manifest: readonly Asset[];
  formats: readonly Format[];
  promptHash: string;
  contextHash: string;
  instruction: string | null;
}): string {
  const { scene, storyboard } = args;
  return inputsHash({
    scene,
    concept: storyboard.concept,
    copyRules: storyboard.copyRules,
    fps: storyboard.fps,
    brand: brandForCode(args.brand),
    assets: sceneAssets(scene, args.manifest),
    formats: args.formats,
    prompt: args.promptHash,
    context: args.contextHash,
    instruction: args.instruction,
  });
}

function fileBlock(name: string, code: string): string {
  return `<file name="${name}">\n${code.trim()}\n</file>`;
}

export interface CodegenStageDeps {
  /** Контекст промпта (дефолт — vendor + motion-kit з диска). */
  context?: () => CodegenContext;
  now?: () => Date;
}

/**
 * Інструкції правок по сценах: пер-сценні інструкції з `director/revision.json` (RevisionPlan стадії
 * revise) мають пріоритет над params (оркестратор передає туди повний текст правки клієнта).
 */
async function instructionsFor(
  storage: Storage,
  projectId: string,
  rev: number,
  params: StageContext<"codegen">["params"],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const record = await readOptional(storage, directorPaths(projectId, rev).revision, (v) =>
    z.object({ scenesToRegenerate: RevisionPlan.shape.scenesToRegenerate }).parse(v),
  );
  for (const s of params.instructions) map.set(s.sceneId, s.instruction);
  for (const s of record?.scenesToRegenerate ?? []) map.set(s.sceneId, s.instruction);
  return map;
}

/**
 * Стадія `codegen`: розкадровка → `video/scenes/<sceneId>.tsx` + `video/scenes/index.ts`.
 *
 * - `params.sceneIds = null` — усі сцени одним викликом (перша генерація). Якщо є ревізія-основа,
 *   сцени з тим самим хешем входів переносяться без генерації, а решта генерується в режимі правки.
 * - `params.sceneIds = [...]` — лише ці сцени; решта подається як контекст «тільки для читання»
 *   (і переноситься з ревізії-основи, якщо в поточній ревізії її коду ще немає).
 * Код кожної сцени проходить AST-guard; відхилені сцени не пишуться у `video/scenes/`
 * (їхній код — у журналі версій) і повертаються в `guardRejected`.
 */
export function createCodegenStage(deps: CodegenStageDeps = {}): Stage<"codegen"> {
  const now = deps.now ?? (() => new Date());
  const getContext = deps.context ?? (() => loadCodegenContext());
  return async (ctx) => {
    const { storage, projectId, rev, params, logger } = ctx;
    const rp = revPaths(projectId, rev);
    const dp = directorPaths(projectId, rev);
    const project = await readProject(storage, projectId);
    const brandFile = await readCurrentBrandKit(storage, projectId, project);
    const storyboard = await readStoryboard(storage, projectId, rev);
    const manifest = await readAssets(storage, projectId);
    const formats = formatsOf(project);
    const context = getContext();
    const instructions = await instructionsFor(storage, projectId, rev, params);
    const ledger = await readLedger(storage, projectId, rev);
    const base = baseRevOf(project, rev);
    const baseLedger = base !== null ? await readLedger(storage, projectId, base) : { scenes: {} };
    const allIds = storyboard.scenes.map((s) => s.id);
    const artifacts = new Set<string>();

    const vars = (mode: "all" | "subset", targets: string[], readonly: string) => ({
      ...contextVars(context),
      mode,
      targets: targets.join(", "),
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
      readonlyScenes: readonly || "(немає)",
    });
    const promptHash = ctx.prompts.load(CODEGEN_PROMPT, vars("all", allIds, "")).hash;
    const hashes: Record<string, string> = {};
    for (const scene of storyboard.scenes) {
      hashes[scene.id] = sceneCodegenHash({
        scene,
        storyboard,
        brand: brandFile,
        manifest,
        formats,
        promptHash,
        contextHash: context.hash,
        instruction: instructions.get(scene.id) ?? null,
      });
    }

    // ---------- які сцени генерувати ----------
    const carried: string[] = [];
    let targets: string[];
    if (params.sceneIds !== null) {
      targets = params.sceneIds.filter((id) => allIds.includes(id));
      const unknown = params.sceneIds.filter((id) => !allIds.includes(id));
      if (unknown.length) logger.warn("codegen: невідомі сцени пропущено", { unknown });
    } else if (base !== null) {
      targets = [];
      for (const id of allIds) {
        const baseVer = currentVersion(baseLedger, id);
        const hasCode =
          (await storage.exists(revPaths(projectId, base).scene(id))) && baseVer?.guardOk !== false;
        if (hasCode && baseVer?.inputsHash === hashes[id] && !instructions.has(id)) {
          for (const k of await carryScene(
            storage,
            projectId,
            rev,
            base,
            ledger,
            baseLedger,
            id,
            now(),
            hashes[id] ?? null,
          ))
            artifacts.add(k);
          carried.push(id);
        } else {
          targets.push(id);
        }
      }
    } else {
      targets = [...allIds];
    }

    // Сцени поза генерацією без коду в поточній ревізії — переносимо з основи.
    if (base !== null) {
      for (const id of allIds) {
        if (targets.includes(id) || carried.includes(id)) continue;
        if (await storage.exists(rp.scene(id))) continue;
        const written = await carryScene(storage, projectId, rev, base, ledger, baseLedger, id, now(), null);
        if (written.length) {
          carried.push(id);
          for (const k of written) artifacts.add(k);
        }
      }
    }

    if (targets.length === 0) {
      const index = await writeScenesIndex(storage, projectId, rev, storyboard, rejectedScenes(ledger));
      artifacts.add(index.key);
      artifacts.add(await writeLedger(storage, projectId, rev, ledger));
      const report: CodegenReport = {
        mode: "reused",
        sceneIds: [],
        guardRejected: [],
        carried,
        violations: {},
        inputsHashes: hashes,
        missing: [],
      };
      await storage.writeJson(dp.codegen, report);
      return {
        artifacts: [...artifacts, dp.codegen],
        outputs: { sceneIds: [], guardRejected: [] },
        reused: true,
        inputsHash: inputsHash(hashes),
      };
    }

    const mode: "all" | "subset" = targets.length === allIds.length ? "all" : "subset";
    let readonly = "";
    if (mode === "subset") {
      const blocks: string[] = [];
      for (const id of allIds) {
        if (targets.includes(id)) continue;
        const code = await readCurrentCode(storage, projectId, rev, ledger, id);
        if (code) blocks.push(fileBlock(`${id}.tsx`, code));
      }
      readonly = blocks.join("\n\n");
    }

    // ---------- виклик моделі (стрім) ----------
    await progress(
      ctx,
      "codegen",
      t("directingProgress", { done: 0, total: targets.length }),
      0,
      targets.length,
    );
    let streamed = "";
    let reported = 0;
    const onText = (delta: string) => {
      streamed += delta;
      const done = Math.min(targets.length, (streamed.match(/<\/file>/g) ?? []).length);
      if (done > reported) {
        reported = done;
        void progress(
          ctx,
          "codegen",
          t("directingProgress", { done, total: targets.length }),
          done,
          targets.length,
        );
      }
    };
    let text: string;
    try {
      const res = await ctx.llm.stream(CODEGEN_PROMPT, vars(mode, targets, readonly), {
        onText,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      text = res.text;
    } catch (err) {
      return llmStageError(err, "генерація сцен");
    }
    const rawKey = dp.raw(`codegen-r${rev}-a${ctx.attempt}`);
    await storage.write(rawKey, text);

    // ---------- розбір і AST-guard ----------
    const files = parseFileBlocks(text);
    const byScene = new Map(files.filter((f) => f.sceneId).map((f) => [f.sceneId as string, f.code]));
    const extra = files.filter((f) => !f.sceneId || !targets.includes(f.sceneId)).map((f) => f.name);
    if (extra.length) logger.warn("codegen: зайві файли у відповіді проігноровано", { extra });
    if (byScene.size === 0) {
      throw new StageError(
        "codegen: у відповіді моделі немає жодного <file>",
        "codegen_no_files",
        "Модель не повернула код сцен — спробуйте ще раз.",
        true,
      );
    }

    const guardRejected: string[] = [];
    const missing: string[] = [];
    const violations: Record<string, string[]> = {};
    for (const id of targets) {
      const code = byScene.get(id) ?? null;
      if (code === null) {
        missing.push(id);
        guardRejected.push(id);
        violations[id] = ["модель не повернула файл сцени"];
        await addVersion(storage, projectId, rev, ledger, id, {
          origin: "codegen",
          code: null,
          guardOk: false,
          violations: violations[id],
          inputsHash: hashes[id] ?? null,
          now: now(),
        });
        continue;
      }
      const guard = guardScene(code, `${id}.tsx`);
      if (!guard.ok) {
        guardRejected.push(id);
        violations[id] = formatViolations(guard.violations).split("\n");
      }
      const { written } = await addVersion(storage, projectId, rev, ledger, id, {
        origin: "codegen",
        code,
        guardOk: guard.ok,
        violations: violations[id] ?? [],
        inputsHash: hashes[id] ?? null,
        now: now(),
      });
      for (const k of written) artifacts.add(k);
    }
    if (guardRejected.length) logger.warn("codegen: сцени не пройшли AST-guard", { violations });

    const index = await writeScenesIndex(storage, projectId, rev, storyboard, rejectedScenes(ledger));
    artifacts.add(index.key);
    artifacts.add(await writeLedger(storage, projectId, rev, ledger));
    const report: CodegenReport = {
      mode,
      sceneIds: targets,
      guardRejected,
      carried,
      violations,
      inputsHashes: hashes,
      missing,
    };
    await storage.writeJson(dp.codegen, report);
    artifacts.add(dp.codegen);
    artifacts.add(rawKey);

    return {
      artifacts: [...artifacts],
      outputs: { sceneIds: targets, guardRejected },
      inputsHash: inputsHash(hashes),
    };
  };
}

export const codegenStage: Stage<"codegen"> = createCodegenStage();
