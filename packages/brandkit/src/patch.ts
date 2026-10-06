import type { Asset, BrandKit, Fact } from "@adc/shared";
import { addClientFacts, normalizeForMatch } from "./facts.ts";
import { logoNeedsBackground } from "./finalize.ts";
import { googleFonts, hasCyrillic } from "./fonts.ts";
import { safeJson } from "./input.ts";
import { sanitizeForTags } from "./text.ts";

/** Допоміжне для стадії `brandkit-patch`. */

const MAX_LOGO_CANDIDATES = 4;

/** Вибір лого клієнтом (без LLM): лого + перше місце серед кандидатів. */
export function applyLogoChoice(kit: BrandKit, asset: Asset): BrandKit {
  const candidates = [asset.id, ...kit.logoCandidates.filter((id) => id !== asset.id)].slice(
    0,
    MAX_LOGO_CANDIDATES,
  );
  return {
    ...kit,
    logo: {
      ...kit.logo,
      assetId: asset.id,
      type: asset.mime.includes("svg") ? "svg" : "image",
      needsBackground: logoNeedsBackground(asset, kit.palette.background),
    },
    logoCandidates: candidates,
    gaps: kit.gaps.filter((g) => g.kind !== "no_logo"),
  };
}

/** Змінні промпта `brandkit-patch`. Репліка клієнта і бренд-кіт — дані в тегах. */
export function buildPatchVars(kit: BrandKit, assets: readonly Asset[], instruction: string) {
  return {
    brandkit: safeJson(kit),
    assets: safeJson(
      assets.map((a) => ({
        assetId: a.id,
        kind: a.kind,
        source: a.source,
        alt: a.alt,
        isLogoCandidate: a.isLogoCandidate,
      })),
    ),
    cyrillic_fonts: googleFonts()
      .filter(hasCyrillic)
      .map((f) => f.family)
      .join(", "),
    instruction: sanitizeForTags(instruction),
  };
}

const sameFact = (a: Fact, b: Fact) =>
  a.kind === b.kind && normalizeForMatch(a.text) === normalizeForMatch(b.text);

/**
 * Після патча від LLM: нові факти та змінені факти сайту стають фактами клієнта
 * (вони прийшли з його репліки), з новими id; суперечливі факти сайту прибираються.
 */
export function reconcilePatchedFacts(
  before: readonly Fact[],
  after: readonly Fact[],
): { facts: Fact[]; fixes: string[] } {
  const prevById = new Map(before.map((f) => [f.id, f]));
  const kept: Fact[] = [];
  const fromClient: Array<{ kind: Fact["kind"]; text: string }> = [];
  for (const f of after) {
    const prev = prevById.get(f.id);
    if (prev && sameFact(prev, f) && prev.source === f.source) {
      // Без змін по суті: зберігаємо походження з попередньої версії.
      kept.push({ ...prev });
      continue;
    }
    if (prev && prev.source === "client" && f.source === "client") {
      kept.push({ ...f, sourceUrl: null });
      continue;
    }
    fromClient.push({ kind: f.kind, text: f.text });
  }
  const res = addClientFacts(kept, fromClient);
  return { facts: res.facts, fixes: res.fixes };
}
