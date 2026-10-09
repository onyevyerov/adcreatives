import {
  type Asset,
  type BrandKit,
  type Effort,
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

/**
 * Режим одного виклику codegen (рядок `Mode:` у промпті): `anchor` — перша сцена першої генерації,
 * що задає мову ролику; `continue` — наступна сцена першої генерації, поруч код уже готових;
 * `subset` — правка вказаних сцен.
 */
export type CodegenPromptMode = "anchor" | "continue" | "subset";

/**
 * Effort для сцени `anchor` (решта — з frontmatter промпта): її код — еталон мови для всіх наступних
 * сцен, а одна сцена вміщується в `max_tokens` навіть із глибшим thinking.
 */
export const ANCHOR_EFFORT: Effort = "xhigh";

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
 * - `params.sceneIds = null` — усі сцени (перша генерація). Якщо є ревізія-основа, сцени з тим самим
 *   хешем входів переносяться без генерації, а решта генерується в режимі правки.
 * - `params.sceneIds = [...]` — лише ці сцени; решта подається як контекст «тільки для читання»
 *   (і переноситься з ревізії-основи, якщо в поточній ревізії її коду ще немає).
 * Сцени генеруються по одній за виклик, у порядку розкадровки: кожен виклик бачить код уже готових
 * сцен, а кожна готова сцена одразу записується в журнал. Повторна спроба після збою продовжує з
 * першої незгенерованої сцени.
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

    const vars = (mode: CodegenPromptMode, targets: string[], readonly: string) => ({
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
    const promptHash = ctx.prompts.load(CODEGEN_PROMPT, vars("anchor", allIds, "")).hash;
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
    const guardRejected: string[] = [];
    const missing: string[] = [];
    const violations: Record<string, string[]> = {};
    /** Цілі, що вже мають свіжий код у цій ревізії (згенеровані в цьому запуску або продовжені). */
    const done = new Set<string>();

    // Продовження після збою: сцени, які попередня спроба цієї ревізії вже згенерувала з тими самими
    // входами, не генеруємо вдруге.
    const resumed: string[] = [];
    for (const id of targets) {
      const cur = currentVersion(ledger, id);
      if (
        cur?.origin === "codegen" &&
        cur.guardOk &&
        cur.inputsHash === hashes[id] &&
        (await storage.exists(rp.scene(id)))
      ) {
        resumed.push(id);
        done.add(id);
      }
    }
    if (resumed.length) logger.info("codegen: продовжую — сцени вже згенеровано", { resumed });

    /** Код інших сцен ролику як контекст «тільки для читання»: готові цілі й сцени поза генерацією. */
    const readonlyFor = async (target: string): Promise<string> => {
      const blocks: string[] = [];
      for (const id of allIds) {
        if (id === target) continue;
        if (targets.includes(id) && !done.has(id)) continue;
        if (currentVersion(ledger, id)?.guardOk === false) continue;
        const code = await readCurrentCode(storage, projectId, rev, ledger, id);
        if (code) blocks.push(fileBlock(`${id}.tsx`, code));
      }
      return blocks.join("\n\n");
    };

    // ---------- генерація: одна сцена за виклик, у порядку розкадровки ----------
    // Кожен виклик бачить код уже готових сцен, тож ролик лишається цілісним, а збій посеред
    // генерації не губить готові сцени: вони записані, повтор продовжить з наступної.
    const total = targets.length;
    await progress(ctx, "codegen", t("directingProgress", { done: done.size, total }), done.size, total);
    for (const [i, id] of targets.entries()) {
      if (done.has(id)) continue;
      const readonly = await readonlyFor(id);
      const promptMode: CodegenPromptMode = mode === "subset" ? "subset" : readonly ? "continue" : "anchor";

      let text: string;
      try {
        const res = await ctx.llm.stream(CODEGEN_PROMPT, vars(promptMode, [id], readonly), {
          ...(promptMode === "anchor" ? { effort: ANCHOR_EFFORT } : {}),
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        text = res.text;
      } catch (err) {
        return llmStageError(err, `генерація сцени ${i + 1} з ${total}`);
      }
      const rawKey = dp.raw(`codegen-r${rev}-${id}-a${ctx.attempt}`);
      await storage.write(rawKey, text);
      artifacts.add(rawKey);

      // ---------- розбір і AST-guard ----------
      const files = parseFileBlocks(text);
      const code = files.find((f) => f.sceneId === id)?.code ?? null;
      const extra = files.filter((f) => f.sceneId !== id).map((f) => f.name);
      if (extra.length) logger.warn("codegen: зайві файли у відповіді проігноровано", { scene: id, extra });

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
      } else {
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
      // Журнал — після кожної сцени: готове переживе збій наступного виклику.
      artifacts.add(await writeLedger(storage, projectId, rev, ledger));
      done.add(id);
      await progress(ctx, "codegen", t("directingProgress", { done: done.size, total }), done.size, total);
    }

    if (missing.length > 0 && missing.length === targets.length) {
      throw new StageError(
        "codegen: у відповідях моделі немає жодного <file>",
        "codegen_no_files",
        "Модель не повернула код сцен — спробуйте ще раз.",
        true,
      );
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

    return {
      artifacts: [...artifacts],
      outputs: { sceneIds: targets, guardRejected },
      inputsHash: inputsHash(hashes),
    };
  };
}

export const codegenStage: Stage<"codegen"> = createCodegenStage();
