import {
  type Asset,
  allowedScreenTexts,
  type BrandKit,
  type Format,
  inputsHash,
  type LlmCallOptions,
  LlmError,
  RevisionPlan,
  readTuning,
  revPaths,
  type Scene,
  type Stage,
  type StageContext,
  StageError,
  type Storage,
  type Storyboard,
  type Tuning,
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
 * Режим одного виклику codegen (рядок `Mode:` у промпті): `film` — уся перша генерація одним
 * викликом, один автор пише всі сцени; `anchor` — перша сцена першої генерації, що задає мову ролику;
 * `continue` — наступна сцена першої генерації (послідовний режим або догенерація після обрізаного
 * `film`), поруч код уже готових; `parallel` — сцена першої генерації у `fanout`, поруч лише код
 * anchor, решту сцен одночасно пишуть інші виклики; `subset` — правка вказаних сцен.
 */
export type CodegenPromptMode = "film" | "anchor" | "continue" | "parallel" | "subset";

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
    tagline: brand.identity.tagline,
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
    // Стан наскрізного об'єкта в цій сцені і в сусідніх (стики): зміна об'єкта перегенеровує сцену.
    throughline: throughlineFor(storyboard, scene.id),
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

/** Наскрізний об'єкт для хешу сцени: назва і стани цієї сцени та її сусідів; null — об'єкта немає. */
function throughlineFor(storyboard: Storyboard, sceneId: string): unknown {
  const t = storyboard.throughline;
  if (!t) return null;
  const order = storyboard.scenes.map((s) => s.id);
  const i = order.indexOf(sceneId);
  const near = new Set([order[i - 1], sceneId, order[i + 1]]);
  return { object: t.object, states: t.states.filter((s) => near.has(s.sceneId)) };
}

function fileBlock(name: string, code: string): string {
  return `<file name="${name}">\n${code.trim()}\n</file>`;
}

export interface CodegenStageDeps {
  /** Контекст промпта (дефолт — vendor + motion-kit з диска). */
  context?: () => CodegenContext;
  now?: () => Date;
  /** Перемикачі генерації; дефолт — `readTuning()` з env на кожен запуск стадії. */
  tuning?: () => Tuning;
}

/** Виконує `fn` для кожного елемента, не більше `limit` одночасно, у порядку списку. */
async function inPool<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<unknown>,
): Promise<void> {
  let next = 0;
  const errors: unknown[] = [];
  const worker = async () => {
    // Після першої помилки нових не беремо, але чекаємо вже запущені.
    while (errors.length === 0 && next < items.length) {
      const item = items[next++] as T;
      try {
        await fn(item);
      } catch (err) {
        errors.push(err);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (errors.length) throw errors[0];
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
 * Кожна готова сцена одразу записується в журнал, повторна спроба після збою продовжує з
 * незгенерованих. Режим — `Tuning.codegenMode`:
 * - `film` (дефолт): перша генерація — один stream-виклик на всі сцени (prompt mode `film`, effort
 *   `codegenAnchorEffort`, task budget `codegenTaskBudget`). Salvage: якщо відповідь обрізана
 *   (`max_tokens`) або в ній бракує сцен, повні `<file>` зберігаються, а відсутні догенеровуються по
 *   одній у режимі `continue` (тим самим effort) з кодом усіх уже написаних сцен у `readonlyScenes`.
 *   Правка (subset) — як у `fanout`.
 * - `fanout`: перша генерація — спершу anchor (перша сцена) сам, потім `llm.warm()` і решта
 *   паралельно (не більше `codegenConcurrency`) з кодом anchor як контекстом; правка — усі цільові
 *   сцени паралельно з поточним кодом нецільових. Спільна частина user-повідомлення однакова в усіх
 *   паралельних викликах і читається з кешу.
 * - `sequential`: по черзі в порядку розкадровки, кожен виклик бачить код уже готових сцен.
 * `fanout` і `sequential` — відкат через env (`ADC_CODEGEN_MODE`).
 * Effort / модель / ліміти — з `Tuning` (anchor — `codegenAnchorEffort`, решта — `codegenRestEffort` /
 * `codegenRestModel`). Збій виклику однієї сцени не валить стадію: сцена йде в `missing` (далі check →
 * fix напише її з нуля); стадія падає, лише якщо коду немає в жодної цільової сцени. Якщо anchor не
 * вдався, anchor стає наступна сцена.
 * Код кожної сцени проходить AST-guard (і перевірку текстів у кадрі за `allowedScreenTexts`);
 * відхилені сцени не пишуться у `video/scenes/` (їхній код — у журналі версій) і повертаються
 * в `guardRejected`: їх не догенеровують, а лагодить fix.
 */
export function createCodegenStage(deps: CodegenStageDeps = {}): Stage<"codegen"> {
  const now = deps.now ?? (() => new Date());
  const getContext = deps.context ?? (() => loadCodegenContext());
  const getTuning = deps.tuning ?? (() => readTuning());
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
    const tuning = getTuning();
    const instructions = await instructionsFor(storage, projectId, rev, params);
    const ledger = await readLedger(storage, projectId, rev);
    const base = baseRevOf(project, rev);
    const baseLedger = base !== null ? await readLedger(storage, projectId, base) : { scenes: {} };
    const allIds = storyboard.scenes.map((s) => s.id);
    const sceneById = new Map(storyboard.scenes.map((s) => [s.id, s]));
    const artifacts = new Set<string>();

    /**
     * Змінні промпта. Усе, крім `mode` і `targets`, іде до `=== cache ===`: для паралельних викликів
     * воно мусить бути байт-ідентичним (той самий `readonly`, ті самі `instructionIds`).
     */
    const vars = (
      mode: CodegenPromptMode,
      targets: string[],
      readonly: string,
      instructionIds: readonly string[] = targets,
    ) => ({
      ...contextVars(context, brandFile),
      mode,
      targets: targets.join(", "),
      language: project?.language ?? brandFile.identity.language,
      formats: formats.join(", "),
      brand: brandForCode(brandFile),
      storyboard,
      assets: assetsForPrompt(brandFile, manifest),
      instructions:
        instructionIds
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

    /** Код вказаних сцен (у порядку розкадровки) як контекст «тільки для читання»; відхилені guard'ом — ні. */
    const readonlyOf = async (ids: readonly string[]): Promise<string> => {
      const blocks: string[] = [];
      for (const id of allIds) {
        if (!ids.includes(id)) continue;
        if (currentVersion(ledger, id)?.guardOk === false) continue;
        const code = await readCurrentCode(storage, projectId, rev, ledger, id);
        if (code) blocks.push(fileBlock(`${id}.tsx`, code));
      }
      return blocks.join("\n\n");
    };

    /** Опції виклику сцени з `Tuning`: anchor — свій effort, решта — rest effort / model. */
    const callOpts = (id: string, role: "anchor" | "rest", cacheUserPrefix: boolean): LlmCallOptions => ({
      effort: role === "anchor" ? tuning.codegenAnchorEffort : tuning.codegenRestEffort,
      ...(role === "rest" && tuning.codegenRestModel !== null ? { model: tuning.codegenRestModel } : {}),
      ...(tuning.codegenMaxTokens !== null ? { maxTokens: tuning.codegenMaxTokens } : {}),
      ...(tuning.codegenTaskBudget !== null ? { taskBudget: tuning.codegenTaskBudget } : {}),
      costDetail: `scene:${id}`,
      cacheUserPrefix,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });

    // Записи після відповіді — по черзі: паралельні сцени не перетирають журнал застарілим знімком.
    let writes: Promise<unknown> = Promise.resolve();
    const serial = <T>(fn: () => Promise<T>): Promise<T> => {
      const run = writes.then(fn);
      writes = run.catch(() => {});
      return run;
    };

    const total = targets.length;
    let lastLlmError: LlmError | null = null;

    /**
     * Розбір, AST-guard і запис у журнал коду однієї сцени (`code = null` — сцени без коду, в
     * `missing`). Записи — по черзі. true — у сцени є код, що пройшов guard.
     */
    const recordScene = (id: string, code: string | null, failure: string | null): Promise<boolean> =>
      serial(async () => {
        let ok = false;
        if (code === null) {
          missing.push(id);
          guardRejected.push(id);
          violations[id] = [failure ?? "модель не повернула файл сцени"];
          await addVersion(storage, projectId, rev, ledger, id, {
            origin: "codegen",
            code: null,
            guardOk: false,
            violations: violations[id],
            inputsHash: hashes[id] ?? null,
            now: now(),
          });
        } else {
          const scene = sceneById.get(id);
          const guard = guardScene(code, {
            fileName: `${id}.tsx`,
            ...(scene ? { allowedTexts: allowedScreenTexts(scene, brandFile) } : {}),
          });
          ok = guard.ok;
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
        return ok;
      });

    /** Сира відповідь моделі — у `director/raw/` (для налагодження). */
    const writeRaw = (name: string, text: string) =>
      serial(async () => {
        const rawKey = dp.raw(`codegen-r${rev}-${name}-a${ctx.attempt}`);
        await storage.write(rawKey, text);
        artifacts.add(rawKey);
      });

    /**
     * Один виклик моделі на сцену + розбір, AST-guard і запис у журнал. Збій виклику (max_tokens,
     * відмова, API після повторів) — сцена без коду в `missing`; скасування стадії летить далі.
     * true — у сцени є код, що пройшов guard.
     */
    const generateScene = async (
      id: string,
      promptMode: CodegenPromptMode,
      readonly: string,
      opts: LlmCallOptions,
      instructionIds: readonly string[],
    ): Promise<boolean> => {
      let text: string | null = null;
      let failure: string | null = null;
      try {
        const res = await ctx.llm.stream(
          CODEGEN_PROMPT,
          vars(promptMode, [id], readonly, instructionIds),
          opts,
        );
        text = res.text;
      } catch (err) {
        if (ctx.signal?.aborted || !(err instanceof LlmError)) throw err;
        lastLlmError = err;
        failure = `модель не повернула сцену: ${err.message}`;
        logger.warn("codegen: збій генерації сцени", { scene: id, code: err.code, err: err.message });
      }
      let code: string | null = null;
      if (text !== null) {
        await writeRaw(id, text);
        const files = parseFileBlocks(text);
        code = files.find((f) => f.sceneId === id)?.code ?? null;
        const extra = files.filter((f) => f.sceneId !== id).map((f) => f.name);
        if (extra.length) logger.warn("codegen: зайві файли у відповіді проігноровано", { scene: id, extra });
      }
      return recordScene(id, code, failure);
    };

    /**
     * Догенерація сцен по одній у порядку розкадровки: кожна бачить код усіх уже написаних сцен
     * (`continue`; якщо коду ще немає ні в кого — `anchor`), effort і модель anchor.
     */
    const generateOneByOne = async (ids: readonly string[]) => {
      for (const id of ids) {
        const readonly = await readonlyOf(
          allIds.filter((x) => x !== id && (!targets.includes(x) || done.has(x))),
        );
        await generateScene(id, readonly ? "continue" : "anchor", readonly, callOpts(id, "anchor", false), [
          id,
        ]);
      }
    };

    /**
     * Режим `film`: один виклик на всі сцени. Текст стріму накопичується, щоб при обрізанні
     * (`max_tokens`) зберегти повні `<file>`-блоки; відсутні сцени — `generateOneByOne`.
     */
    const generateFilm = async (ids: string[]) => {
      let streamed = "";
      let text: string | null = null;
      try {
        const res = await ctx.llm.stream(CODEGEN_PROMPT, vars("film", ids, ""), {
          ...callOpts("film", "anchor", false),
          costDetail: "film",
          onText: (delta) => {
            streamed += delta;
          },
        });
        text = res.text;
      } catch (err) {
        if (ctx.signal?.aborted || !(err instanceof LlmError)) throw err;
        lastLlmError = err;
        logger.warn("codegen: виклик film не завершився — догенерую відсутні сцени", {
          code: err.code,
          err: err.message,
        });
        // Обрізана відповідь оплачена повністю: повні файли з неї беремо.
        if (err.code === "max_tokens" && streamed.trim()) text = streamed;
      }
      const written: string[] = [];
      if (text !== null) {
        await writeRaw("film", text);
        const files = parseFileBlocks(text);
        const extra = files.filter((f) => f.sceneId === null || !ids.includes(f.sceneId)).map((f) => f.name);
        if (extra.length) logger.warn("codegen: зайві файли у відповіді проігноровано", { extra });
        for (const id of ids) {
          const code = files.find((f) => f.sceneId === id)?.code ?? null;
          if (code === null) continue;
          await recordScene(id, code, null);
          written.push(id);
        }
      }
      const absent = ids.filter((id) => !written.includes(id));
      if (absent.length) {
        logger.warn("codegen: у відповіді film бракує сцен — догенерую по одній", {
          written,
          absent,
        });
        await generateOneByOne(absent);
      }
    };

    /**
     * Паралельні виклики зі спільною частиною (той самий `readonly`, інструкції всіх цілей). Від двох
     * викликів спершу прогріваємо кеш тими самими model / effort, щоб паралельні його читали, а не писали.
     */
    const generateParallel = async (ids: string[], promptMode: CodegenPromptMode, readonly: string) => {
      const shared = ids.length > 1;
      const [first] = ids;
      if (shared && first !== undefined) {
        try {
          await ctx.llm.warm(CODEGEN_PROMPT, vars(promptMode, [first], readonly, targets), {
            effort: tuning.codegenRestEffort,
            ...(tuning.codegenRestModel !== null ? { model: tuning.codegenRestModel } : {}),
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
        } catch (err) {
          if (ctx.signal?.aborted) throw err;
          logger.warn("codegen: прогрів кешу не вдався", { err: String(err) });
        }
      }
      await inPool(ids, tuning.codegenConcurrency, (id) =>
        generateScene(id, promptMode, readonly, callOpts(id, "rest", shared), targets),
      );
    };

    await progress(ctx, "codegen", t("directingProgress", { done: done.size, total }), done.size, total);
    const pending = () => targets.filter((id) => !done.has(id));

    if (tuning.codegenMode === "film" && mode === "all") {
      // ---------- один автор: увесь фільм одним викликом; після збою — лише відсутні ----------
      const rest = pending();
      if (done.size === 0) await generateFilm(rest);
      else await generateOneByOne(rest);
    } else if (tuning.codegenMode === "sequential") {
      // ---------- по черзі в порядку розкадровки: кожен виклик бачить код уже готових сцен ----------
      for (const id of pending()) {
        const readonly = await readonlyOf(
          allIds.filter((x) => x !== id && (!targets.includes(x) || done.has(x))),
        );
        const promptMode: CodegenPromptMode = mode === "subset" ? "subset" : readonly ? "continue" : "anchor";
        await generateScene(
          id,
          promptMode,
          readonly,
          callOpts(id, promptMode === "anchor" ? "anchor" : "rest", false),
          [id],
        );
      }
    } else if (mode === "subset") {
      // ---------- правка: усі цільові паралельно, поруч поточний код нецільових ----------
      const rest = pending();
      await generateParallel(rest, "subset", await readonlyOf(allIds.filter((x) => !rest.includes(x))));
    } else {
      // ---------- перша генерація: anchor сам, потім решта паралельно з кодом лише anchor ----------
      // Anchor — перша сцена з кодом (продовжена після збою або щойно згенерована); не вдався — наступна.
      let anchor = targets.find((id) => done.has(id)) ?? null;
      while (anchor === null) {
        const id = pending()[0];
        if (id === undefined) break;
        if (await generateScene(id, "anchor", "", callOpts(id, "anchor", false), targets)) anchor = id;
      }
      const rest = pending();
      if (anchor !== null && rest.length)
        await generateParallel(rest, "parallel", await readonlyOf([anchor]));
    }

    const byOrder = (a: string, b: string) => allIds.indexOf(a) - allIds.indexOf(b);
    missing.sort(byOrder);
    guardRejected.sort(byOrder);
    if (missing.length > 0 && missing.length === targets.length) {
      if (lastLlmError) llmStageError(lastLlmError, "генерація сцен");
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
