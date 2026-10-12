import {
  type Asset,
  AssetManifest,
  BrandKit,
  BrandKitFile,
  BrandKitPatch,
  inputsHash,
  LlmError,
  NotFoundInStorageError,
  projectPaths,
  SiteData,
  type Stage,
  type StageContext,
  StageError,
  type Storage,
  t,
} from "@adc/shared";
import { addClientFacts } from "./facts.ts";
import { finalizeBrandKit } from "./finalize.ts";
import { buildBrandkitInput } from "./input.ts";
import { applyPatch } from "./jsonPatch.ts";
import { applyLogoChoice, buildPatchVars, reconcilePatchedFacts } from "./patch.ts";
import { contactSheetKey, latestBrandkitVersion, readBrandkit } from "./versions.ts";

export interface BrandkitStageOptions {
  /** Бюджет токенів для тексту сайту (дефолт 12 000). */
  textBudgetTokens?: number;
  /** Скільки скриншотів передати моделі (дефолт 6). */
  maxScreenshots?: number;
  now?: () => Date;
}

async function readSite(storage: Storage, projectId: string): Promise<SiteData | null> {
  try {
    return await storage.readJson(projectPaths(projectId).site, (v) => SiteData.parse(v));
  } catch (err) {
    if (err instanceof NotFoundInStorageError) return null;
    throw err;
  }
}

async function readAssets(storage: Storage, projectId: string): Promise<Asset[]> {
  const key = projectPaths(projectId).assets;
  if (!(await storage.exists(key))) return [];
  return (await storage.readJson(key, (v) => AssetManifest.parse(v))).assets;
}

function llmToStageError(err: unknown, what: string): never {
  if (err instanceof LlmError) {
    const userMessage =
      err.code === "refusal"
        ? `Модель відмовилась обробити ${what}. Спробуйте ще раз або опишіть бізнес текстом.`
        : `Не вдалося ${what === "сайт" ? "зібрати бренд-кіт" : "застосувати правку"} — спробуйте ще раз.`;
    throw new StageError(err.message, `llm_${err.code}`, userMessage, err.code !== "refusal", { cause: err });
  }
  throw err;
}

/** Стадія `brandkit`: site.json + assets.json → brandkit/v<k>.json (перша — v1) і brandkit/site-text.txt. */
export function createBrandkitStage(opts: BrandkitStageOptions = {}): Stage<"brandkit"> {
  const now = opts.now ?? (() => new Date());
  return async (ctx: StageContext<"brandkit">) => {
    const { storage, projectId } = ctx;
    const paths = projectPaths(projectId);
    await ctx.emit.progress("brandkit", t("brandkitProgress"));

    const site = await readSite(storage, projectId);
    if (!site) {
      throw new StageError(
        `немає ${paths.site}`,
        "no_site_data",
        "Немає даних сайту — спершу потрібно його просканувати.",
        false,
      );
    }
    const assets = await readAssets(storage, projectId);

    const input = await buildBrandkitInput(storage, site, assets, {
      textBudgetTokens: opts.textBudgetTokens,
      maxScreenshots: opts.maxScreenshots,
    });
    ctx.logger.info("brandkit: вхід зібрано", {
      screenshots: input.screenshotKeys.length,
      assets: input.sheet?.cells.length ?? 0,
      textTokens: input.textTokens,
      textTruncated: input.textTruncated,
    });

    const artifacts: string[] = [];
    if (input.sheet) {
      const sheetKey = contactSheetKey(projectId);
      await storage.write(sheetKey, input.sheet.png);
      artifacts.push(sheetKey);
    }

    let data: BrandKit;
    let promptHash: string;
    try {
      const res = await ctx.llm.structured("brandkit", input.vars, BrandKit, {
        images: input.images,
        signal: ctx.signal,
      });
      data = res.data;
      promptHash = res.prompt.hash;
    } catch (err) {
      llmToStageError(err, "сайт");
    }

    const fin = finalizeBrandKit(data, { site, assets, initial: true }, input.sheetNumbers);
    const version = (await latestBrandkitVersion(storage, projectId)) + 1;
    const file = BrandKitFile.parse({
      ...fin.brandkit,
      version,
      createdAt: now().toISOString(),
      origin: "llm",
      fixes: fin.fixes,
    });
    const key = paths.brandkit(version);
    await storage.writeJson(key, file);
    // Той самий текст сайту, що бачив бренд-кіт, — для сценариста (storyboard) і перевірки тверджень.
    await storage.write(paths.siteText, input.siteText);
    artifacts.unshift(key, paths.siteText);
    if (fin.fixes.length) ctx.logger.info("brandkit: програмні виправлення", { fixes: fin.fixes });

    return {
      artifacts,
      outputs: { version },
      inputsHash: inputsHash({ site, assets, prompt: promptHash }),
    };
  };
}

export const brandkitStage: Stage<"brandkit"> = createBrandkitStage();

/**
 * Стадія `brandkit-patch`: поточна версія → v<k+1>.
 * Лого з кандидатів і факти клієнта — без LLM; текстова правка — JSON-патч від Sonnet.
 * Після будь-якої зміни — та сама програмна перевірка, що й для першої версії.
 */
export function createBrandkitPatchStage(
  opts: Pick<BrandkitStageOptions, "now"> = {},
): Stage<"brandkit-patch"> {
  const now = opts.now ?? (() => new Date());
  return async (ctx: StageContext<"brandkit-patch">) => {
    const { storage, projectId, params } = ctx;
    const instruction = params.instruction?.trim() || null;
    const facts = params.facts.filter((f) => f.text.trim());
    if (!instruction && params.logoAssetId === null && facts.length === 0) {
      throw new StageError(
        "brandkit-patch без змін",
        "empty_patch",
        "Немає що змінювати в бренд-кіті.",
        false,
      );
    }

    const current = await latestBrandkitVersion(storage, projectId);
    if (current === 0) {
      throw new StageError("немає brandkit/v*.json", "no_brandkit", "Бренд-кіт ще не зібрано.", false);
    }
    const prev = await readBrandkit(storage, projectId, current);
    const { version: _v, createdAt: _c, origin: _o, fixes: _f, ...prevKit } = prev;
    let kit: BrandKit = BrandKit.parse(prevKit);
    const site = await readSite(storage, projectId);
    const assets = await readAssets(storage, projectId);
    const summary: string[] = [];
    const fixes: string[] = [];

    if (params.logoAssetId !== null) {
      const asset = assets.find((a) => a.id === params.logoAssetId);
      if (!asset) {
        throw new StageError(
          `невідомий assetId ${params.logoAssetId}`,
          "unknown_asset",
          "Такого зображення немає серед завантажених.",
          false,
        );
      }
      kit = applyLogoChoice(kit, asset);
      summary.push("лого змінено");
    }

    if (facts.length) {
      const res = addClientFacts(kit.facts, facts);
      kit = { ...kit, facts: res.facts };
      fixes.push(...res.fixes);
      if (res.added.length) summary.push(`додано фактів від вас: ${res.added.length}`);
    }

    if (instruction) {
      let patch: BrandKitPatch;
      try {
        const res = await ctx.llm.structured(
          "brandkit-patch",
          buildPatchVars(kit, assets, instruction),
          BrandKitPatch,
          {
            signal: ctx.signal,
          },
        );
        patch = res.data;
      } catch (err) {
        llmToStageError(err, "правку");
      }
      const outcome = applyPatch(kit, patch.ops, (doc) => {
        const parsed = BrandKit.safeParse(doc);
        return parsed.success
          ? null
          : parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      });
      for (const s of outcome.skipped) {
        ctx.logger.warn("brandkit-patch: операцію пропущено", { op: s.op, reason: s.reason });
      }
      if (outcome.applied.length === 0 && patch.ops.length > 0) {
        throw new StageError(
          "жодна операція патча не застосувалась",
          "patch_rejected",
          "Не вдалося застосувати правку до бренд-кіта — сформулюйте її інакше.",
          false,
        );
      }
      const reconciled = reconcilePatchedFacts(kit.facts, outcome.doc.facts);
      kit = { ...outcome.doc, facts: reconciled.facts };
      fixes.push(...reconciled.fixes);
      if (patch.summary.trim()) summary.push(patch.summary.trim());
      // Якщо модель змінила лого — перерахувати тип і підкладку детерміновано.
      const logoAsset = assets.find((a) => a.id === kit.logo.assetId);
      if (logoAsset && kit.logo.assetId !== prevKit.logo.assetId) kit = applyLogoChoice(kit, logoAsset);
    }

    const fin = finalizeBrandKit(kit, {
      site,
      assets,
      keepFactIds: new Set(prevKit.facts.map((f) => f.id)),
    });
    const version = current + 1;
    const origin = instruction ? "patch" : params.logoAssetId !== null ? "logo" : "facts";
    const file = BrandKitFile.parse({
      ...fin.brandkit,
      version,
      createdAt: now().toISOString(),
      origin,
      fixes: [...fixes, ...fin.fixes],
    });
    const key = projectPaths(projectId).brandkit(version);
    await storage.writeJson(key, file);
    return {
      artifacts: [key],
      outputs: { version, summary: summary.join("; ") || "бренд-кіт оновлено" },
    };
  };
}

export const brandkitPatchStage: Stage<"brandkit-patch"> = createBrandkitPatchStage();
