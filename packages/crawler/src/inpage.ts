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

/** Виклик уже вставленого коду без повторної вставки (часті кроки розкриття); null — сторінку змінено. */
function callInstalled(fn: string, args: unknown = null): string {
  return `(async () => globalThis.__adc ? await globalThis.__adc.${fn}(${JSON.stringify(args)}) : null)()`;
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
  /** Скільки кліків по розкривачках (`[aria-expanded="false"]`, акордеони/FAQ/згортання за класами). */
  clicked: number;
  /** Скільки вкладок (`[role="tab"]` і за класами) активовано, без повернення початкової. */
  tabs: number;
}

/** Ліміт кліків на сторінку: розкривачки, вкладки й повернення початкової вкладки разом. */
export const EXPAND_MAX_CLICKS = 40;

export interface ExpandOptions {
  /** Максимум кліків на сторінку (дефолт `EXPAND_MAX_CLICKS`). */
  maxClicks?: number;
  /** Пауза після кожного кліку перед знімком регіону, мс (дефолт 80; для вкладок — удвічі більша). */
  step?: number;
  /** Пауза після всіх кліків, мс (дефолт 400). */
  settle?: number;
  /** Час на всі кліки, мс (дефолт 8000): далі розкриття зупиняється, зібране лишається. */
  budgetMs?: number;
}

interface ExpandStep {
  id: string;
  kind: "toggle" | "tab" | "restore";
}

/** Скільки чекати, поки Playwright зможе клікнути тригер (видимий, стабільний, не перекритий). */
const CLICK_TIMEOUT_MS = 1_000;

const withoutHash = (url: string) => url.replace(/#.*$/, "");

/**
 * Розкриває згорнутий зміст (FAQ-акордеони, `<details>`, згортання, вкладки) перед `extractPage`.
 * План і знімки тексту — у сторінці, а кліки — справжні, через Playwright (миша, trusted-події):
 * частина сайтів ігнорує синтетичний `el.click()`. Якщо Playwright клікнути не може (тригер
 * перекритий), — запасний клік подіями в сторінці. Клік, що відвів зі сторінки, зупиняє розкриття.
 */
export async function expandCollapsed(page: Page, opts: ExpandOptions = {}): Promise<ExpandResult> {
  const deadline = Date.now() + (opts.budgetMs ?? 8_000);
  const step = opts.step ?? 80;
  const plan: { details: number; steps: ExpandStep[] } = await page.evaluate(
    call("expandPlan", { maxClicks: opts.maxClicks ?? EXPAND_MAX_CLICKS }),
  );
  const result: ExpandResult = { details: plan.details, clicked: 0, tabs: 0 };
  const origin = withoutHash(page.url());
  for (const s of plan.steps) {
    const left = deadline - Date.now();
    if (left < 300) break;
    if ((await page.evaluate(callInstalled("expandBefore", s.id))) !== true) continue;
    await clickTrigger(page, s.id, Math.min(CLICK_TIMEOUT_MS, left - 200));
    if (s.kind === "toggle") result.clicked++;
    else if (s.kind === "tab") result.tabs++;
    if (withoutHash(page.url()) !== origin) return result;
    if (s.kind !== "restore") {
      await page.evaluate(
        callInstalled("expandAfter", { id: s.id, wait: s.kind === "tab" ? step * 2 : step }),
      );
    }
  }
  // Курсор після кліків лишається над тригером — прибираємо hover зі скриншота.
  await page.mouse.move(0, 0).catch(() => {});
  const touched = result.details + result.clicked + result.tabs > 0;
  await page.evaluate(callInstalled("expandFinish", { settle: touched ? (opts.settle ?? 400) : 0 }));
  return result;
}

async function clickTrigger(page: Page, id: string, timeout: number): Promise<void> {
  try {
    await page.locator(`[data-adc-x="${id}"]`).click({ timeout: Math.max(100, timeout) });
  } catch {
    // Тригер перекритий, рухається чи прихований для Playwright — клік подіями в самій сторінці.
    await page.evaluate(callInstalled("expandPress", id)).catch(() => false);
  }
}

export const dismissConsent = (page: Page): Promise<number> => page.evaluate(call("dismissConsent"));
export const hideOverlays = (page: Page): Promise<number> => page.evaluate(call("hideOverlays"));
export const autoScroll = (
  page: Page,
  opts: { maxSteps?: number; delay?: number; maxHeight?: number } = {},
): Promise<number> => page.evaluate(call("autoScroll", opts));
export const waitForFonts = (page: Page, timeoutMs = 3000): Promise<boolean> =>
  page.evaluate(call("waitForFonts", timeoutMs));
export const extractPage = (page: Page, opts: { withDesign?: boolean } = {}): Promise<RawPage> =>
  page.evaluate(call("extract", { withDesign: opts.withDesign ?? true }));
