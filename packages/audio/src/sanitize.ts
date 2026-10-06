import type { BrandKit } from "@adc/shared";

/**
 * Програмна очистка промпта музики від назв брендів і артистів.
 * ElevenLabs відхиляє промпти з іменами артистів/брендів; модель у промпті попереджена,
 * а тут — страховка кодом.
 */

/** Артисти й гурти, яких моделі найчастіше згадують у музичних промптах. */
const KNOWN_ARTISTS = [
  "Hans Zimmer",
  "John Williams",
  "Ennio Morricone",
  "Ludovico Einaudi",
  "Max Richter",
  "Ólafur Arnalds",
  "Olafur Arnalds",
  "Nils Frahm",
  "Daft Punk",
  "Kygo",
  "Avicii",
  "Calvin Harris",
  "David Guetta",
  "Martin Garrix",
  "Skrillex",
  "Deadmau5",
  "Moby",
  "Bonobo",
  "Tycho",
  "Odesza",
  "Nujabes",
  "J Dilla",
  "Lofi Girl",
  "Chillhop",
  "Coldplay",
  "Imagine Dragons",
  "Taylor Swift",
  "Beyonce",
  "Beyoncé",
  "Billie Eilish",
  "Ed Sheeran",
  "The Weeknd",
  "Dua Lipa",
  "Drake",
  "Kanye West",
  "Eminem",
  "Queen",
  "The Beatles",
  "Beatles",
  "Pink Floyd",
  "Radiohead",
  "Metallica",
  "AC/DC",
  "Nirvana",
  "Michael Jackson",
  "Madonna",
  "Adele",
  "Rihanna",
  "Bruno Mars",
  "Pharrell",
  "Mozart",
  "Beethoven",
  "Bach",
  "Vivaldi",
  "Chopin",
  "Tchaikovsky",
  "Okean Elzy",
  "Океан Ельзи",
  "Go_A",
  "Kalush",
  "DakhaBrakha",
  "Jamala",
  "Джамала",
  "Netflix",
  "Disney",
  "Pixar",
  "Marvel",
  "Apple",
  "Nike",
  "Spotify",
] as const;

/** «in the style of X», «inspired by X», «à la X» — прибираємо весь хвіст до коми. */
const STYLE_OF =
  /\b(?:in\s+the\s+(?:style|vein|spirit)\s+of|(?:musical\s+)?style\s+of|inspired\s+by|influenced\s+by|reminiscent\s+of|similar\s+to|sounds?\s+like|à\s+la|a\s+la)\s+[^,;.\n]*/giu;
/** «like Daft Punk» — лише якщо далі слово з великої літери (не чіпаємо «like a heartbeat»). */
const LIKE_PROPER = /\blike\s+(?:the\s+)?(?:\p{Lu}[\p{L}\p{N}'’&.-]*\s*)+/gu;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

function termRegex(term: string): RegExp {
  // \b у JS не працює з кирилицею — межі слова через юнікодні класи.
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(term)}(?![\\p{L}\\p{N}])`, "giu");
}

/** Терміни бренду з бренд-кіта: назва, текстовий фолбек лого, мітка домену сайту. */
export function brandTerms(brand: Pick<BrandKit, "identity" | "logo" | "contacts"> | null): string[] {
  if (!brand) return [];
  const terms = new Set<string>();
  const add = (s: string | null | undefined) => {
    const v = s?.trim();
    if (v && v.length >= 2) terms.add(v);
  };
  add(brand.identity.name);
  add(brand.logo.textFallback);
  const site = brand.contacts.website;
  if (site) {
    try {
      const host = new URL(site.includes("://") ? site : `https://${site}`).hostname.replace(/^www\./, "");
      add(host);
      const label = host.split(".")[0];
      if (label && label.length >= 3) add(label);
    } catch {
      // некоректний URL — пропускаємо
    }
  }
  return [...terms];
}

export interface Sanitizer {
  /** Чистить один рядок (стиль, промпт). Порожній результат — стиль треба викинути. */
  text(input: string): string;
  /** Чистить список стилів: викидає порожні й дублікати (без урахування регістру). */
  styles(input: readonly string[]): string[];
}

export function createSanitizer(extraTerms: readonly string[] = []): Sanitizer {
  const terms = [...extraTerms, ...KNOWN_ARTISTS]
    .filter((t) => t.trim().length > 0)
    // Довші першими, щоб «Океан Ельзи» прибирався цілком.
    .sort((a, b) => b.length - a.length)
    .map(termRegex);

  const text = (input: string): string => {
    let out = input.replace(STYLE_OF, " ").replace(LIKE_PROPER, " ");
    for (const re of terms) out = out.replace(re, " ");
    return out
      .replace(/\(\s*\)/g, " ")
      .replace(/\s+([,;.])/g, "$1")
      .replace(/([,;])\s*(?=[,;])/g, "")
      .replace(/\s{2,}/g, " ")
      .replace(/^[\s,;:.-]+|[\s,;:-]+$/g, "")
      .trim();
  };

  const styles = (input: readonly string[]): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of input) {
      const s = text(raw);
      const key = s.toLowerCase();
      if (!s || seen.has(key)) continue;
      seen.add(key);
      out.push(s);
    }
    return out;
  };

  return { text, styles };
}
