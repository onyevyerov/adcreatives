import {
  type Asset,
  type BrandKit,
  type BrandKitFile,
  computeTimeline,
  type Format,
  inputsHash,
  type ProjectState,
  revPaths,
  SceneId,
  SceneText,
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
export const STORYBOARD_COPYFIX_PROMPT = "storyboard-copyfix";

/** Відповідь `storyboard-copyfix`: нові тексти лише проблемних сцен (поля — як `Scene.text`). */
export const StoryboardCopyfix = z.object({
  scenes: z.array(SceneText.extend({ id: SceneId })),
});
export type StoryboardCopyfix = z.infer<typeof StoryboardCopyfix>;

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

/** Змінні `storyboard-copyfix`: проблемні сцени з помилками й лімітами + усі headline підряд. */
export function copyfixVars(
  sb: Storyboard,
  issues: readonly TextIssue[],
  brand: BrandKit,
  opts: { language: string; formats: readonly Format[] },
) {
  const byScene = new Map<string, TextIssue[]>();
  for (const i of issues) byScene.set(i.sceneId, [...(byScene.get(i.sceneId) ?? []), i]);
  // Ліміти найвужчого з обраних форматів — ті самі, що перевіряє `checkCopy`.
  const perLine = Math.min(...opts.formats.map((f) => sb.copyRules.maxCharsPerLine[f]));
  const limits = {
    headline: perLine * sb.copyRules.maxLines.headline,
    sub: perLine * sb.copyRules.maxLines.sub,
    word: perLine,
  };
  return {
    language: opts.language,
    formats: opts.formats.join(", "),
    brand: {
      name: brand.identity.name,
      voice: brand.voice,
      location: brand.location,
      contacts: brand.contacts,
    },
    facts: brand.facts,
    copyRules: sb.copyRules,
    headlines: sb.scenes.map((s) => `${s.id}: ${s.text.headline}`).join("\n"),
    scenes: sb.scenes.flatMap((s) => {
      const own = byScene.get(s.id);
      if (!own) return [];
      return [
        {
          id: s.id,
          purpose: s.purpose,
          headline: s.text.headline,
          sub: s.text.sub,
          emphasis: s.text.emphasis,
          factIds: s.factIds,
          limits,
          issues: own.map(({ field, format, kind, actual, limit }) => ({
            field,
            format,
            kind,
            actual,
            limit,
          })),
        },
      ];
    }),
  };
}

/** Нові тексти лише для `sceneIds`; решта сцен і полів розкадровки — ті самі об'єкти. */
export function mergeCopyfix(
  sb: Storyboard,
  fix: StoryboardCopyfix,
  sceneIds: ReadonlySet<string>,
): Storyboard {
  const byId = new Map(fix.scenes.filter((s) => sceneIds.has(s.id)).map((s) => [s.id, s]));
  return {
    ...sb,
    scenes: sb.scenes.map((scene) => {
      const f = byId.get(scene.id);
      return f ? { ...scene, text: { headline: f.headline, sub: f.sub, emphasis: f.emphasis } } : scene;
    }),
  };
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

    const call = async () => {
      try {
        const res = await ctx.llm.structured(
          STORYBOARD_PROMPT,
          vars,
          Storyboard,
          ctx.signal ? { signal: ctx.signal } : {},
        );
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

    /**
     * Точковий ретрай: нові headline/sub/emphasis лише для сцен з `textIssues`, решта розкадровки
     * (concept, motionIntent, таймінги, інші сцени) лишається як є. Збій → null (лишається чернетка).
     */
    const copyfix = async (current: NormalizeResult): Promise<NormalizeResult | null> => {
      const ids = new Set(current.textIssues.map((i) => i.sceneId));
      try {
        const res = await ctx.llm.structured(
          STORYBOARD_COPYFIX_PROMPT,
          copyfixVars(current.storyboard, current.textIssues, brandFile, { language, formats }),
          StoryboardCopyfix,
          ctx.signal ? { signal: ctx.signal } : {},
        );
        return normalize(mergeCopyfix(current.storyboard, res.data, ids));
      } catch (err) {
        if (ctx.signal?.aborted) throw err;
        ctx.logger.warn("точковий ретрай текстів розкадровки не вдався — лишаю чернетку", {
          err: String(err),
          scenes: [...ids],
        });
        return null;
      }
    };

    const draft = await call();
    let result = normalize(draft);
    let retried = false;
    if (result.textIssues.length > 0) {
      // Обмеження довжини текстів structured output не гарантує — одна точкова спроба з помилками.
      retried = true;
      const second = await copyfix(result);
      if (second && second.textIssues.length <= result.textIssues.length) {
        result = { ...second, changes: [...result.changes, ...second.changes] };
      }
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
