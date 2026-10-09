import {
  CheckReport,
  type Format,
  type ImageInput,
  type LlmCallOptions,
  QaReport,
  readTuning,
  revPaths,
  STILL_PLAN,
  type Stage,
  type StageContext,
  StageError,
  type Storage,
  type Tuning,
  t,
} from "@adc/shared";
import sharp from "sharp";
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
} from "../io.ts";
import { writeScenesIndex } from "../job.ts";
import {
  addVersion,
  currentVersion,
  readCurrentCode,
  readLedger,
  rejectedScenes,
  writeLedger,
} from "../ledger.ts";
import { QA_IMAGE_MAX_SIDE } from "../sheets.ts";
import { brandForCode } from "./codegen.ts";
import { qaSceneImages } from "./qa.ts";
import { assetsForPrompt } from "./storyboard.ts";

export const FIX_PROMPT = "code-fix";

export interface FixStageDeps {
  context?: () => CodegenContext;
  now?: () => Date;
  /** Перемикачі генерації; дефолт — `readTuning()` з env на кожен запуск стадії. */
  tuning?: () => Tuning;
}

const FRAMES_LEGEND = STILL_PLAN.map((p) => Math.round(p.fraction * 100)).join("/");

/** Кадри сцени для fix (`reason: "qa"`): зображення на формат і легенда до них. */
export interface FixSceneImages {
  images: ImageInput[];
  /** Рядок легенди на зображення, у порядку `images`. */
  legend: string[];
}

/** PNG → JPEG для image block, довша сторона ≤ `QA_IMAGE_MAX_SIDE` (як у QA). */
async function toJpeg(png: Buffer): Promise<ImageInput> {
  const data = await sharp(png)
    .resize(QA_IMAGE_MAX_SIDE, QA_IMAGE_MAX_SIDE, { fit: "inside", withoutEnlargement: true })
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .jpeg({ quality: 85 })
    .toBuffer();
  return { mediaType: "image/jpeg", data };
}

/**
 * Кадри сцени, які бачив QA: на кожен обраний формат, для якого в `check.json` є стіли, — одне
 * зображення з кадрами 25/50/90% (той самий макет, що в QA). Формат без жодного стілу пропускається.
 */
export async function fixSceneImages(
  storage: Storage,
  check: CheckReport,
  sceneId: string,
  formats: readonly Format[],
): Promise<FixSceneImages> {
  const scene = await qaSceneImages(storage, check, [sceneId], formats);
  return {
    images: await Promise.all(scene.map((img) => toJpeg(img.png))),
    legend: scene.map(
      (img, i) => `Image ${i + 1}: scene ${img.sceneId}, format ${img.format}, frames ${FRAMES_LEGEND}%`,
    ),
  };
}

/** Легенда зображень для `<problems>`: що на якому зображенні і як їх читати. */
export function imagesLegend(legend: readonly string[]): string {
  return [
    `Stills of the current code (images above; frames at ${FRAMES_LEGEND}% of the scene, left to right or top to bottom):`,
    ...legend.map((l) => `- ${l}`),
    "The stills show the actual state; the QA remarks below say what to change.",
  ].join("\n");
}

/** Опис проблем сцени для промпта: помилки check (guard, типи, runtime) або зауваження QA + autoIssues. */
export function describeProblems(args: {
  sceneId: string;
  reason: "check" | "qa";
  check: CheckReport | null;
  qa: QaReport | null;
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
      lines.push("Visual QA remarks (from the stills):");
      for (const i of issues)
        lines.push(`- [${i.severity}, ${i.format}, ${i.kind}] ${i.description} → fix: ${i.fix}`);
    }
  }
  const auto = check?.autoIssues.filter((i) => i.sceneId === sceneId) ?? [];
  if (auto.length) {
    lines.push("Automatic checks in QA mode (motion-kit ADC_QA logs):");
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
 * - `reason: "qa"` — модель бачить і кадри сцени (25/50/90% в обраних форматах, що є в `check.json`):
 *   зображення перед текстом, легенда — в `<problems>`. `reason: "check"` — без зображень.
 * - Від двох викликів спершу один `llm.warm()` тими самими model / effort, потім паралельно: виклики
 *   читають кеш (prefix, system, а без зображень — і спільну частину user), а не пишуть його кожен.
 * - Effort: `check` — `Tuning.fixCheckEffort` (null → frontmatter), `qa` — frontmatter.
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
    const context = getContext();
    const ledger = await readLedger(storage, projectId, rev);
    const check = await readOptional(storage, rp.check, (v) => CheckReport.parse(v), logger);
    const qa =
      params.reason === "qa" ? await readOptional(storage, rp.qa, (v) => QaReport.parse(v), logger) : null;
    const targets = [...new Set(params.sceneIds)].filter((id) => storyboard.scenes.some((s) => s.id === id));
    if (targets.length === 0) return { artifacts: [], outputs: { sceneIds: [] } };

    await progress(ctx, "fix", t("directingProgress", { done: 0, total: targets.length }), 0, targets.length);
    let done = 0;

    // Ті самі model / effort у прогріві й паралельних викликах — інакше кеш не прочитається.
    const effort = params.reason === "check" ? tuning.fixCheckEffort : null;
    const modelOpts: Pick<LlmCallOptions, "effort"> = effort !== null ? { effort } : {};

    /** Вхід виклику сцени: змінні промпта і (для `qa`) кадри. */
    const prepare = async (sceneId: string) => {
      const scene = storyboard.scenes.find((s) => s.id === sceneId);
      const code = await readCurrentCode(storage, projectId, rev, ledger, sceneId);
      const ver = currentVersion(ledger, sceneId);
      const problems = describeProblems({
        sceneId,
        reason: params.reason,
        check,
        qa,
        guardViolations: ver && !ver.guardOk ? ver.violations : [],
      });
      let shots: FixSceneImages = { images: [], legend: [] };
      if (params.reason === "qa" && check) {
        try {
          shots = await fixSceneImages(storage, check, sceneId, formats);
        } catch (err) {
          if (ctx.signal?.aborted) throw err;
          logger.warn("fix: не вдалося підготувати кадри сцени, фікс лише за текстом", {
            sceneId,
            err: String(err),
          });
        }
      }
      const vars = {
        ...contextVars(context),
        sceneId,
        reason: params.reason,
        language: project?.language ?? brandFile.identity.language,
        formats: formats.join(", "),
        brand: brandForCode(brandFile),
        scene: scene ?? null,
        concept: storyboard.concept,
        assets: assetsForPrompt(brandFile, manifest),
        code: code ?? "(no code: the previous generation returned nothing — write the scene from scratch)",
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
        // Спільна частина user (бренд, асети, концепт) читається з прогріву лише без зображень:
        // зображення йдуть перед нею, і префікс кожного виклику з кадрами унікальний.
        cacheUserPrefix: parallel && images.length === 0,
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
      const guard = code === null ? null : guardScene(code, `${sceneId}.tsx`);
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
