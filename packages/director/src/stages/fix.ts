import {
  allowedScreenTexts,
  CheckReport,
  FilmReview,
  type Format,
  type ImageInput,
  type LlmCallOptions,
  QaReport,
  readTuning,
  revPaths,
  type Stage,
  type StageContext,
  StageError,
  type Storage,
  type Storyboard,
  type Tuning,
  t,
} from "@adc/shared";
import { type CodegenContext, contextVars, loadCodegenContext } from "../context.ts";
import { parseSingleScene } from "../files.ts";
import { formatViolations, guardScene } from "../guard.ts";
import {
  directorPaths,
  formatsOf,
  progress,
  readAssets,
  readCurrentBrandKit,
  readOptional,
  readProject,
  readStoryboard,
  readTemplateScenes,
} from "../io.ts";
import { writeScenesIndex } from "../job.ts";
import {
  addVersion,
  currentVersion,
  readCurrentCode,
  readLedger,
  rejectedScenes,
  type SceneLedger,
  writeLedger,
} from "../ledger.ts";
import { type ReviewForFix, reviewProblemLines } from "../review-issues.ts";
import { brandForCode } from "./codegen.ts";
import { qaSceneImages } from "./qa.ts";
import { assetsForPrompt } from "./storyboard.ts";

export { reviewIssuesFor } from "../review-issues.ts";

export const FIX_PROMPT = "code-fix";

export interface FixStageDeps {
  context?: () => CodegenContext;
  now?: () => Date;
  /** Перемикачі генерації; дефолт — `readTuning()` з env на кожен запуск стадії. */
  tuning?: () => Tuning;
}

/** Кадри сцени для fix (`reason: "qa"` або `"review"`): зображення на формат і легенда до них. */
export interface FixSceneImages {
  images: ImageInput[];
  /** Рядок легенди на зображення, у порядку `images`. */
  legend: string[];
}

/**
 * Кадри сцени, які бачив QA: на кожен обраний формат, для якого в `check.json` є стіли, — аркуш
 * стрічки сцени (кадри кожні 0.5 с), а без нього — кадри 25/50/90% (той самий вибір, що в QA).
 * Формат без жодного стілу пропускається.
 */
export async function fixSceneImages(
  storage: Storage,
  check: CheckReport,
  sceneId: string,
  formats: readonly Format[],
  storyboard: Pick<Storyboard, "fps" | "scenes">,
  paths: Pick<ReturnType<typeof revPaths>, "stripSheet">,
): Promise<FixSceneImages> {
  const scene = await qaSceneImages(storage, check, [sceneId], formats, storyboard, paths);
  return {
    images: scene.map((img) => img.image),
    legend: scene.map((img, i) => `Image ${i + 1}: ${img.legend}`),
  };
}

/** Легенда зображень для `<problems>`: що на якому зображенні і як їх читати. */
export function imagesLegend(legend: readonly string[]): string {
  return [
    "Frames of the current code (images above): the strip shows the scene every 0.5 s, so you can see how it moves, where it stands still and when each text is readable.",
    ...legend.map((l) => `- ${l}`),
    "The frames show the actual state; the remarks below say what to change.",
  ].join("\n");
}

/** Як блок `<file>` у codegen: `<file name="sN.tsx">…</file>`. */
function fileBlock(sceneId: string, code: string): string {
  return `<file name="${sceneId}.tsx">\n${code.trim()}\n</file>`;
}

/** Код фільму для `<film>`: текст блоку і сцени, чий код у ньому є. */
export interface FilmScenes {
  text: string;
  sceneIds: ReadonlySet<string>;
}

/**
 * Код усіх сцен фільму (`<film>`) у порядку розкадровки, разом зі сценами, які правлять: сусіди для
 * match-cut, спільна мова фільму. Шаблонні сцени й версії, відхилені guard'ом, — без коду.
 * Рахується один раз на запуск стадії: текст однаковий у всіх викликах кола і стоїть у кешованому блоці.
 */
export async function filmScenesFor(args: {
  storage: Storage;
  projectId: string;
  rev: number;
  ledger: SceneLedger;
  storyboard: Pick<Storyboard, "scenes">;
  templates: ReadonlySet<string>;
}): Promise<FilmScenes> {
  const blocks: string[] = [];
  const sceneIds = new Set<string>();
  for (const { id } of args.storyboard.scenes) {
    if (args.templates.has(id)) continue;
    if (currentVersion(args.ledger, id)?.guardOk === false) continue;
    const code = await readCurrentCode(args.storage, args.projectId, args.rev, args.ledger, id);
    if (!code) continue;
    blocks.push(fileBlock(id, code));
    sceneIds.add(id);
  }
  return { text: blocks.join("\n\n") || "(немає)", sceneIds };
}

/** `<film>` для fix(check) у режимі `ADC_FIX_CHECK_CONTEXT=own` (B5): без коду фільму. */
export const FILM_OMITTED =
  "(omitted for this repair: fix only the TypeScript / AST-guard errors in `<problems>`, change nothing else)";

/** Опис проблем сцени для промпта: помилки check (guard, типи, runtime), зауваження QA або рецензента + autoIssues. */
export function describeProblems(args: {
  sceneId: string;
  reason: "check" | "qa" | "review";
  check: CheckReport | null;
  qa: QaReport | null;
  /** `review.json` ревізії (лише для `reason: "review"`). */
  review?: ReviewForFix | null;
  guardViolations: readonly string[];
}): string {
  const { sceneId, reason, check, qa } = args;
  const lines: string[] = [];
  if (args.guardViolations.length) {
    lines.push("AST-guard (code is rejected until these are gone):");
    for (const v of args.guardViolations) lines.push(`- ${v}`);
  }
  const compile =
    check?.compileErrors.filter((e) => e.sceneId === sceneId && !e.message.startsWith("AST-guard")) ?? [];
  if (compile.length) {
    lines.push("TypeScript / bundle errors:");
    for (const e of compile)
      lines.push(`- ${e.line !== null ? `line ${e.line}:${e.column ?? 0} ` : ""}${e.message}`);
  }
  const runtime = check?.runtimeErrors.filter((e) => e.sceneId === sceneId) ?? [];
  if (runtime.length) {
    lines.push("Runtime errors while rendering stills:");
    for (const e of runtime) lines.push(`- [${e.format}, frame ${e.frame}] ${e.message.slice(0, 1500)}`);
  }
  if (reason === "qa") {
    const issues = qa?.issues.filter((i) => i.sceneId === sceneId) ?? [];
    if (issues.length) {
      lines.push("Art director's remarks (from the frame strip):");
      for (const i of issues)
        lines.push(`- [${i.severity}, ${i.format}, ${i.kind}] ${i.description} → fix: ${i.fix}`);
    }
  }
  if (reason === "review") lines.push(...reviewProblemLines(args.review ?? null, sceneId));
  const auto = check?.autoIssues.filter((i) => i.sceneId === sceneId) ?? [];
  if (auto.length) {
    lines.push("Automatic checks (motion-kit QA logs, the frame strip, the scene code):");
    for (const i of auto) {
      lines.push(
        `- [${i.format}, frame ${i.frame ?? "?"}] ${i.kind} in ${i.component}: ${i.detail}${i.value != null ? ` (value ${i.value})` : ""}`,
      );
    }
  }
  return lines.length
    ? lines.join("\n")
    : "(no recorded problems — make the scene robust and fully compliant with the rules)";
}

/**
 * Стадія `fix`: окремий виклик моделі на кожну проблемну сцену (паралельно), на вході код сцени +
 * помилки або зауваження; новий код знову проходить AST-guard і стає новою версією сцени.
 * Ліміти кіл і заміну на TemplateScene вирішує оркестратор.
 * - Контекст фільму: код усіх сцен (і своєї) у `filmScenes` — над `=== cache ===`, один текст на все коло
 *   (сусіди для match-cut); змінюється лише своя. `ADC_FIX_CHECK_CONTEXT=own` (B5): для `check`, коли в
 *   жодної цілі немає runtime-помилок, `<film>` без коду, свій код — у `<code>`.
 * - Guard з `allowedTexts: allowedScreenTexts(scene, brand)` — тексти в кадрі лише з розкадровки.
 * - `reason: "qa"` — модель бачить і аркуш стрічки сцени в кожному обраному форматі, що є в `check.json`
 *   (запасний варіант — кадри 25/50/90%): зображення між кодом фільму і хвостом, легенда — в `<problems>`.
 *   `reason: "review"` — те саме, а зауваження — з `review.json` (маршрут fix, зокрема склейки, де сцена —
 *   будь-яка сторона). `reason: "check"` — без зображень.
 * - Від двох викликів спершу один `llm.warm()` тими самими model / effort, потім паралельно: виклики
 *   читають кеш (prefix, system і спільну частину user з кодом фільму — зображення йдуть після неї),
 *   а не пишуть його кожен.
 * - Effort: `check` — `Tuning.fixCheckEffort`, `qa` і `review` — `Tuning.fixEffort` (null → frontmatter).
 * `outputs.sceneIds` — сцени, що отримали нову версію (зокрема відхилену guard'ом: її помилки
 * покаже наступний `check` як compileErrors).
 */
export function createFixStage(deps: FixStageDeps = {}): Stage<"fix"> {
  const now = deps.now ?? (() => new Date());
  const getContext = deps.context ?? (() => loadCodegenContext());
  const getTuning = deps.tuning ?? (() => readTuning());
  return async (ctx: StageContext<"fix">) => {
    const { storage, projectId, rev, params, logger } = ctx;
    const rp = revPaths(projectId, rev);
    const dp = directorPaths(projectId, rev);
    const tuning = getTuning();
    const project = await readProject(storage, projectId);
    const brandFile = await readCurrentBrandKit(storage, projectId, project);
    const storyboard = await readStoryboard(storage, projectId, rev);
    const manifest = await readAssets(storage, projectId);
    const formats = formatsOf(project);
    const templates = new Set(await readTemplateScenes(storage, projectId, rev));
    const context = getContext();
    const ledger = await readLedger(storage, projectId, rev);
    const check = await readOptional(storage, rp.check, (v) => CheckReport.parse(v), logger);
    const qa =
      params.reason === "qa" ? await readOptional(storage, rp.qa, (v) => QaReport.parse(v), logger) : null;
    const review =
      params.reason === "review"
        ? await readOptional(storage, rp.review, (v) => FilmReview.parse(v), logger)
        : null;
    if (params.reason === "review" && !review)
      logger.warn("fix: немає review.json — фікс без зауважень рецензента");
    const targets = [...new Set(params.sceneIds)].filter((id) => storyboard.scenes.some((s) => s.id === id));
    if (targets.length === 0) return { artifacts: [], outputs: { sceneIds: [] } };

    await progress(ctx, "fix", t("directingProgress", { done: 0, total: targets.length }), 0, targets.length);
    let done = 0;

    // Ті самі model / effort у прогріві й паралельних викликах — інакше кеш не прочитається.
    const effort = params.reason === "check" ? tuning.fixCheckEffort : tuning.fixEffort;
    const modelOpts: Pick<LlmCallOptions, "effort"> = effort !== null ? { effort } : {};

    // Код фільму — один раз до prepare: байт-однаковий текст кешованого блоку в усіх викликах кола.
    // B5: fix(check) без коду фільму, лише якщо в жодної цілі немає runtime-помилок — інакше film для всіх.
    const ownContext =
      params.reason === "check" &&
      tuning.fixCheckContext === "own" &&
      !check?.runtimeErrors.some((e) => targets.includes(e.sceneId));
    const film: FilmScenes = ownContext
      ? { text: FILM_OMITTED, sceneIds: new Set() }
      : await filmScenesFor({ storage, projectId, rev, ledger, storyboard, templates });

    /** Вхід виклику сцени: змінні промпта і (для `qa`/`review`) кадри. */
    const prepare = async (sceneId: string) => {
      const scene = storyboard.scenes.find((s) => s.id === sceneId);
      const code = await readCurrentCode(storage, projectId, rev, ledger, sceneId);
      const ver = currentVersion(ledger, sceneId);
      const problems = describeProblems({
        sceneId,
        reason: params.reason,
        check,
        qa,
        review,
        guardViolations: ver && !ver.guardOk ? ver.violations : [],
      });
      let shots: FixSceneImages = { images: [], legend: [] };
      if (params.reason !== "check" && check) {
        try {
          shots = await fixSceneImages(storage, check, sceneId, formats, storyboard, rp);
        } catch (err) {
          if (ctx.signal?.aborted) throw err;
          logger.warn("fix: не вдалося підготувати кадри сцени, фікс лише за текстом", {
            sceneId,
            err: String(err),
          });
        }
      }
      const vars = {
        ...contextVars(context, brandFile),
        sceneId,
        reason: params.reason,
        language: project?.language ?? brandFile.identity.language,
        formats: formats.join(", "),
        brand: brandForCode(brandFile),
        scene: scene ?? null,
        filmScenes: film.text,
        concept: storyboard.concept,
        throughline: storyboard.throughline ?? null,
        assets: assetsForPrompt(brandFile, manifest),
        code: film.sceneIds.has(sceneId)
          ? `(the current code of this scene is the file ${sceneId}.tsx in <film>)`
          : (code ?? "(no code: the previous generation returned nothing — write the scene from scratch)"),
        problems: shots.legend.length ? `${imagesLegend(shots.legend)}\n\n${problems}` : problems,
      };
      return { sceneId, vars, images: shots.images };
    };
    type Prepared = Awaited<ReturnType<typeof prepare>>;

    const prepared = await Promise.allSettled(targets.map(prepare));
    const ready = prepared.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    const parallel = ready.length > 1;
    const [first] = ready;
    if (parallel && first) {
      try {
        await ctx.llm.warm(FIX_PROMPT, first.vars, {
          ...modelOpts,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
      } catch (err) {
        if (ctx.signal?.aborted) throw err;
        logger.warn("fix: прогрів кешу не вдався", { err: String(err) });
      }
    }

    const fixOne = async ({ sceneId, vars, images }: Prepared) => {
      const res = await ctx.llm.text(FIX_PROMPT, vars, {
        ...modelOpts,
        ...(images.length ? { images } : {}),
        costDetail: `scene:${sceneId}`,
        // Спільна частина user (бренд, асети, концепт, код фільму) — перед кадрами, тож її читають з
        // прогріву і виклики з зображеннями.
        imagesAfterCache: true,
        cacheUserPrefix: parallel,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      done++;
      void progress(
        ctx,
        "fix",
        t("directingProgress", { done, total: targets.length }),
        done,
        targets.length,
      );
      return { sceneId, text: res.text };
    };

    const settled = await Promise.allSettled(
      prepared.map((p) => (p.status === "fulfilled" ? fixOne(p.value) : Promise.reject(p.reason))),
    );
    const fixed: string[] = [];
    const artifacts = new Set<string>();
    const failures: string[] = [];
    for (const [i, r] of settled.entries()) {
      const sceneId = targets[i] as string;
      if (r.status === "rejected") {
        failures.push(`${sceneId}: ${String(r.reason)}`);
        continue;
      }
      const rawKey = dp.raw(`fix-${sceneId}-a${ctx.attempt}-${Date.now()}`);
      await storage.write(rawKey, r.value.text);
      const code = parseSingleScene(r.value.text, sceneId);
      const scene = storyboard.scenes.find((s) => s.id === sceneId);
      const guard =
        code === null
          ? null
          : guardScene(code, {
              fileName: `${sceneId}.tsx`,
              ...(scene ? { allowedTexts: allowedScreenTexts(scene, brandFile) } : {}),
            });
      const violations =
        code === null
          ? ["модель не повернула код сцени"]
          : formatViolations(guard?.violations ?? [])
              .split("\n")
              .filter(Boolean);
      const { written } = await addVersion(storage, projectId, rev, ledger, sceneId, {
        origin: "fix",
        code,
        guardOk: guard?.ok === true,
        violations: guard?.ok ? [] : violations,
        now: now(),
      });
      for (const k of written) artifacts.add(k);
      if (guard && !guard.ok) logger.warn("fix: сцена не пройшла AST-guard", { sceneId, violations });
      fixed.push(sceneId);
    }

    if (fixed.length === 0) {
      throw new StageError(
        `fix: жоден виклик не вдався: ${failures.join("; ").slice(0, 1000)}`,
        "fix_failed",
        "Не вдалося виправити сцени — спробуйте ще раз.",
        true,
      );
    }
    if (failures.length) logger.warn("fix: частина сцен не виправлена", { failures });

    artifacts.add((await writeScenesIndex(storage, projectId, rev, storyboard, rejectedScenes(ledger))).key);
    artifacts.add(await writeLedger(storage, projectId, rev, ledger));
    return { artifacts: [...artifacts], outputs: { sceneIds: fixed } };
  };
}

export const fixStage: Stage<"fix"> = createFixStage();
