import { readFileSync } from "node:fs";
import type { Page } from "playwright";

/**
 * Обгортки над кодом у сторінці (`inpage/inpage.js`). Код передається рядком, а не
 * функцією: так його не зачіпає транспіляція (tsx/esbuild додає `__name`, якого в
 * браузері немає). `page.evaluate` працює через CDP і не залежить від CSP сайту.
 */

let inpageSource: string | null = null;

function inpage(): string {
  inpageSource ??= readFileSync(new URL("./inpage/inpage.js", import.meta.url), "utf8");
  return inpageSource;
}

function call(fn: string, args: unknown = null): string {
  return `(async () => {
    if (!globalThis.__adc) { ${inpage()}\n }
    const args = ${JSON.stringify(args)};
    return await globalThis.__adc.${fn}(args);
  })()`;
}

export interface RawImage {
  url: string;
  kind: "photo" | "logo" | "background" | "icon" | "og";
  alt: string | null;
  context: string | null;
  width: number;
  height: number;
  naturalWidth: number;
  naturalHeight: number;
  /** Позиція на сторінці (px від верху документа). */
  top: number;
  /** Розмітка вбудованого SVG (для `inline-svg:*`). */
  svg: string | null;
}

export interface RawDesign {
  cssVars: Record<string, string>;
  colors: Array<{ role: string; value: string; count: number }>;
  fonts: Array<{ role: string; family: string; weight: number }>;
  radii: Record<string, number>;
}

export interface RawPage {
  url: string;
  title: string;
  description: string | null;
  lang: string | null;
  og: Record<string, string>;
  jsonLd: unknown[];
  headings: Array<{ level: number; text: string }>;
  buttons: string[];
  nav: Array<{ text: string; url: string }>;
  links: Array<{ url: string; text: string; inNav: boolean }>;
  hreflang: Array<{ hreflang: string; href: string }>;
  text: string;
  contacts: {
    phones: string[];
    emails: string[];
    socials: Array<{ network: string; url: string }>;
    addresses: string[];
    bodyText: string;
  };
  design: RawDesign | null;
  images: RawImage[];
  docHeight: number;
}

export interface ExpandResult {
  /** Скільки `<details>` відкрито. */
  details: number;
  /** Скільки кліків по `[aria-expanded="false"]`. */
  clicked: number;
  /** Скільки вкладок `[role="tab"]` активовано. */
  tabs: number;
}

export interface ExpandOptions {
  /** Максимум кліків по розкривачках (дефолт 40). */
  maxClicks?: number;
  /** Максимум вкладок (дефолт 40). */
  maxTabs?: number;
  /** Пауза після кожного кліку перед знімком регіону, мс (дефолт 80; для вкладок — удвічі більша). */
  step?: number;
  /** Пауза після всіх кліків, мс (дефолт 400). */
  settle?: number;
}

export const dismissConsent = (page: Page): Promise<number> => page.evaluate(call("dismissConsent"));
export const hideOverlays = (page: Page): Promise<number> => page.evaluate(call("hideOverlays"));
export const autoScroll = (
  page: Page,
  opts: { maxSteps?: number; delay?: number; maxHeight?: number } = {},
): Promise<number> => page.evaluate(call("autoScroll", opts));
export const waitForFonts = (page: Page, timeoutMs = 3000): Promise<boolean> =>
  page.evaluate(call("waitForFonts", timeoutMs));
/** Розкриває згорнутий зміст (FAQ-акордеони, `<details>`, вкладки) перед `extractPage`. */
export const expandCollapsed = (page: Page, opts: ExpandOptions = {}): Promise<ExpandResult> =>
  page.evaluate(call("expand", opts));
export const extractPage = (page: Page, opts: { withDesign?: boolean } = {}): Promise<RawPage> =>
  page.evaluate(call("extract", { withDesign: opts.withDesign ?? true }));
