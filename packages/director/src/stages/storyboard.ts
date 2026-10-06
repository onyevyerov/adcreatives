import {
  type Asset,
  type BrandKit,
  type BrandKitFile,
  computeTimeline,
  inputsHash,
  type ProjectState,
  revPaths,
  type Stage,
  type StageContext,
  type Storage,
  Storyboard,
  t,
} from "@adc/shared";
import { z } from "zod";
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
import { type NormalizeResult, normalizeStoryboard, type TextIssue } from "../normalize.ts";

export const STORYBOARD_PROMPT = "storyboard";

export const StoryboardMeta = z.object({
  inputsHash: z.string(),
  brandkitVersion: z.number().int(),
  changes: z.array(z.string()),
  textIssues: z.array(z.unknown()),
  retried: z.boolean(),
});
export type StoryboardMeta = z.infer<typeof StoryboardMeta>;

/** Дані бренду для промптів сценарію/правок (без технічних полів). */
export function brandForScript(brand: BrandKit) {
  return {
    identity: brand.identity,
    voice: brand.voice,
    audience: brand.audience,
    offerings: brand.offerings,
    usps: brand.usps,
    socialProof: brand.socialProof,
    location: brand.location,
    contacts: brand.contacts,
    cta: brand.cta,
    visualStyle: brand.visualStyle,
    palette: brand.palette,
    logo: {
      available: brand.logo.assetId !== null,
      type: brand.logo.type,
      textFallback: brand.logo.textFallback,
    },
  };
}

/** Асети для промптів: ранжовані бренд-кітом + метадані з assets.json. */
export function assetsForPrompt(brand: BrandKit, manifest: readonly Asset[]) {
  const byId = new Map(manifest.map((a) => [a.id, a]));
  return brand.assets
    .filter((r) => byId.has(r.assetId) || manifest.length === 0)
    .map((r) => {
      const a = byId.get(r.assetId);
      return {
        assetId: r.assetId,
        role: r.role,
        quality: r.quality,
        description: r.description,
        hasBakedText: r.hasBakedText,
        orientation: a
          ? a.width > a.height * 1.15
            ? "landscape"
            : a.height > a.width * 1.15
              ? "portrait"
              : "square"
          : null,
        size: a ? `${a.width}x${a.height}` : null,
        source: a?.source ?? null,
      };
    });
}

/** Ідентифікатори асетів, на які може посилатися сценарій. */
export function knownAssetIds(brand: BrandKit, manifest: readonly Asset[]): string[] {
  const ids = new Set(brand.assets.map((a) => a.assetId));
  if (manifest.length > 0) {
    const inManifest = new Set(manifest.map((a) => a.id));
    for (const id of [...ids]) if (!inManifest.has(id)) ids.delete(id);
  }
  return [...ids];
}

function answersFor(brand: BrandKit, project: ProjectState | null) {
  const answers = project?.answers ?? {};
  return brand.questions.map((q) => ({
    question: q.text,
    topic: q.topic,
    answer: answers[q.id] ?? null,
    default: q.default,
  }));
}

function durationRule(seconds: number | null): string {
  return seconds === null
    ? "Тривалість обери сам у межах 15–30 с (450–900 кадрів при 30 fps); зазвичай найкраще 18–24 с."
    : `Клієнт попросив рівно ${seconds} с — разом ${seconds * 30} кадрів при 30 fps (після віднімання переходів).`;
}

function issuesFeedback(issues: readonly TextIssue[]): string {
  const lines = issues.map(
    (i) =>
      `- ${i.sceneId}.${i.field} (${i.format}): ${i.kind === "length" ? `${i.actual} символів, максимум ${i.limit}` : `слово з ${i.actual} символів, максимум ${i.limit} у рядку`} — «${i.text}»`,
  );
  return (
    "Попередня розкадровка порушила ліміти тексту (copyRules) для обраних форматів:\n" +
    `${lines.join("\n")}\n` +
    "Поверни повну виправлену розкадровку: скороти ці тексти (зберігаючи зміст і факти), решту лиши як є."
  );
}

async function storyboardInputs(storage: Storage, projectId: string, paramsDuration: number | null) {
  const project = await readProject(storage, projectId);
  const brandFile = await readCurrentBrandKit(storage, projectId, project);
  const manifest = await readAssets(storage, projectId);
  const formats = formatsOf(project);
  const language = project?.language ?? brandFile.identity.language;
  const durationSeconds = paramsDuration ?? project?.durationSeconds ?? null;
  return { project, brandFile, manifest, formats, language, durationSeconds };
}

function briefHash(input: Awaited<ReturnType<typeof storyboardInputs>>, promptHash: string): string {
  const { brandFile, manifest, formats, language, durationSeconds, project } = input;
  const { createdAt: _c, version: _v, origin: _o, fixes: _f, ...brand } = brandFile;
  return inputsHash({
    brand,
    assets: manifest.map((a) => [a.id, a.width, a.height, a.source]),
    answers: project?.answers ?? {},
    formats,
    language,
    durationSeconds,
    prompt: promptHash,
  });
}

/** Стадія `storyboard`: бренд-кіт + відповіді → `rev/<n>/storyboard.json` + `claims.json`. */
export function createStoryboardStage(opts: { now?: () => Date } = {}): Stage<"storyboard"> {
  const now = opts.now ?? (() => new Date());
  return async (ctx: StageContext<"storyboard">) => {
    const { storage, projectId, rev } = ctx;
    const rp = revPaths(projectId, rev);
    const dp = directorPaths(projectId, rev);
    await progress(ctx, "storyboard", t("scriptProgress"));

    const input = await storyboardInputs(storage, projectId, ctx.params.durationSeconds);
    const { brandFile, manifest, formats, language, durationSeconds: duration } = input;
    const assetIds = knownAssetIds(brandFile, manifest);

    const vars = {
      language,
      formats: formats.join(", "),
      durationRule: durationRule(duration),
      brand: brandForScript(brandFile),
      facts: brandFile.facts,
      assets: assetsForPrompt(brandFile, manifest),
      answers: answersFor(brandFile, input.project),
    };
    const promptHash = ctx.prompts.load(STORYBOARD_PROMPT, vars).hash;
    const hash = briefHash(input, promptHash);

    // Пропуск за хешем входів: та сама розкадровка в ревізії-основі.
    const base = baseRevOf(input.project, rev);
    if (base !== null) {
      const baseMeta = await readOptional(storage, directorPaths(projectId, base).storyboardMeta, (v) =>
        StoryboardMeta.parse(v),
      );
      const bp = revPaths(projectId, base);
      if (
        baseMeta?.inputsHash === hash &&
        (await storage.exists(bp.storyboard)) &&
        (await storage.exists(bp.claims))
      ) {
        await storage.copy(bp.storyboard, rp.storyboard);
        await storage.copy(bp.claims, rp.claims);
        await storage.copy(directorPaths(projectId, base).storyboardMeta, dp.storyboardMeta);
        const sb = await storage.readJson(rp.storyboard, (v) => Storyboard.parse(v));
        const claims = verifyClaims(sb, brandFile, { now: now() });
        ctx.logger.info("розкадровку взято з попередньої ревізії", { base });
        return {
          artifacts: [rp.storyboard, rp.claims],
          outputs: {
            unverifiedClaims: claims.unverified.length,
            totalFrames: computeTimeline(sb).totalFrames,
          },
          reused: true,
          inputsHash: hash,
        };
      }
    }

    const call = async (userText?: string) => {
      try {
        const res = await ctx.llm.structured(STORYBOARD_PROMPT, vars, Storyboard, {
          ...(userText ? { userText } : {}),
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        return res.data;
      } catch (err) {
        return llmStageError(err, "сценарій");
      }
    };
    const normalize = (sb: Storyboard): NormalizeResult =>
      normalizeStoryboard(sb, {
        assetIds,
        factIds: brandFile.facts.map((f) => f.id),
        formats,
        durationSeconds: duration,
      });

    const draft = await call();
    let result = normalize(draft);
    let retried = false;
    if (result.textIssues.length > 0) {
      // Обмеження довжини текстів structured output не гарантує — одна повторна спроба з помилками.
      retried = true;
      const second = normalize(
        await call(
          `${issuesFeedback(result.textIssues)}\n\n<previous_storyboard>\n${JSON.stringify(draft)}\n</previous_storyboard>`,
        ),
      );
      if (second.textIssues.length <= result.textIssues.length) result = second;
    }

    const claims = verifyClaims(result.storyboard, brandFile, { now: now() });
    await storage.writeJson(rp.storyboard, result.storyboard);
    await storage.writeJson(rp.claims, claims);
    const meta: StoryboardMeta = {
      inputsHash: hash,
      brandkitVersion: (brandFile as BrandKitFile).version,
      changes: result.changes,
      textIssues: result.textIssues,
      retried,
    };
    await storage.writeJson(dp.storyboardMeta, meta);
    if (result.changes.length) ctx.logger.info("розкадровку нормалізовано", { changes: result.changes });

    return {
      artifacts: [rp.storyboard, rp.claims],
      outputs: { unverifiedClaims: claims.unverified.length, totalFrames: result.totalFrames },
      inputsHash: hash,
    };
  };
}

export const storyboardStage: Stage<"storyboard"> = createStoryboardStage();
