/**
 * Робота з адресами сторінок: нормалізація, «той самий сайт», що пропускаємо,
 * мовні префікси шляху.
 */

/** Параметри відстеження, які не змінюють вміст сторінки. */
const TRACKING_PARAMS = /^(utm_[a-z]+|fbclid|gclid|yclid|msclkid|mc_cid|mc_eid|_ga|ref|igshid)$/i;

/** Безпечно розбирає адресу (відносну — від base). Лише http(s). */
export function parseUrl(input: string, base?: string | URL): URL | null {
  try {
    const url = new URL(input, base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url;
  } catch {
    return null;
  }
}

/** Хост без `www.` і без кінцевої крапки (порт зберігається). */
export function siteHost(url: URL): string {
  return url.host
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^www\./, "");
}

/** Той самий сайт: однаковий хост з урахуванням `www`; інші піддомени — ні. */
export function isSameSite(a: URL, b: URL): boolean {
  return siteHost(a) === siteHost(b);
}

/**
 * Канонічний ключ сторінки для дедупу: без фрагмента, без `www`, без параметрів
 * відстеження, без кінцевого слеша (крім кореня), з відсортованими параметрами.
 * Протокол не враховується — http і https однієї сторінки вважаються однією.
 */
export function pageKey(url: URL): string {
  const params = [...url.searchParams.entries()]
    .filter(([k]) => !TRACKING_PARAMS.test(k))
    .sort(([a], [b]) => a.localeCompare(b));
  const query = params.length ? `?${new URLSearchParams(params).toString()}` : "";
  let pathname = url.pathname.replace(/\/{2,}/g, "/");
  pathname = pathname.replace(/\/index\.(html?|php)$/i, "/");
  if (pathname.length > 1) pathname = pathname.replace(/\/+$/, "");
  return `${siteHost(url)}${(pathname || "/").toLowerCase()}${query}`;
}

/** Адреса для відвідування: без фрагмента і параметрів відстеження. */
export function cleanUrl(url: URL): string {
  const out = new URL(url.href);
  out.hash = "";
  for (const k of [...out.searchParams.keys()]) {
    if (TRACKING_PARAMS.test(k)) out.searchParams.delete(k);
  }
  return out.href;
}

const FILE_EXT =
  /\.(pdf|docx?|xlsx?|pptx?|odt|ods|csv|txt|rtf|zip|rar|7z|gz|tar|exe|dmg|apk|msi|jpe?g|png|gif|webp|avif|svg|ico|bmp|tiff?|heic|mp[34]|m4a|wav|ogg|webm|mov|avi|mkv|xml|json|rss|atom|css|js)$/i;

const SKIP_PATH = [
  // пагінація
  /\/page\/\d+/i,
  /\/p\/\d+\/?$/i,
  /\/(?:сторінка|страница)\/\d+/i,
  // календарі й архіви за датами
  /\/(calendar|календар|календарь)(\/|$)/i,
  /\/\d{4}\/\d{1,2}(\/\d{1,2})?(\/|$)/,
  /\/\d{4}-\d{2}-\d{2}(\/|$)/,
  // службові
  /\/(wp-admin|wp-login|wp-json|admin|login|logout|signin|signup|register|account|my-account|cart|checkout|basket|кошик|корзина|search|feed|rss|cdn-cgi|xmlrpc)(\/|\.|$)/i,
  /\/(tag|tags|author)\/[^/]+/i,
  /\/(print|share|compare|wishlist)(\/|$)/i,
];

const SKIP_PARAMS =
  /^(page|p|paged|pg|sort|sortby|sort_by|order|orderby|order_by|dir|filter|filters|f|color|colour|size|price|price_min|price_max|min_price|max_price|brand|view|limit|per_page|date|month|year|day|week|from|to|start|end|q|query|s|search|replytocom|add-to-cart|lang|currency|sessionid|sid)$/i;

/** Чи пропускати адресу: файли, пагінація, фільтри, календарі, службові сторінки. */
export function isSkippableUrl(url: URL): boolean {
  if (FILE_EXT.test(url.pathname)) return true;
  const decoded = decodeSafe(url.pathname);
  if (SKIP_PATH.some((re) => re.test(decoded))) return true;
  const keys = [...url.searchParams.keys()].filter((k) => !TRACKING_PARAMS.test(k));
  if (keys.some((k) => SKIP_PARAMS.test(k) || /^(filter|pa_|attr)/i.test(k))) return true;
  // Будь-який інший запит із багатьма параметрами — найімовірніше фільтр каталогу.
  return keys.length > 2;
}

function decodeSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Мовні префікси шляху, які розпізнаємо, і відповідний код мови. */
const LANG_PREFIXES: Record<string, string> = { uk: "uk", ua: "uk", en: "en", ru: "ru" };

/** Мова з першого сегмента шляху (`/en/…` → `en`, `/ua/…` → `uk`), інакше null. */
export function langPrefixOf(url: URL): string | null {
  const first = url.pathname.split("/")[1]?.toLowerCase() ?? "";
  const m = /^([a-z]{2})(?:[-_][a-z]{2})?$/.exec(first);
  if (!m?.[1]) return null;
  return LANG_PREFIXES[m[1]] ?? null;
}

/** Основний сабтег мови: `uk-UA` → `uk`, `ua` → `uk`. */
export function normalizeLang(lang: string | null | undefined): string | null {
  if (!lang) return null;
  const primary = lang.trim().toLowerCase().split(/[-_]/)[0] ?? "";
  if (!/^[a-z]{2,3}$/.test(primary)) return null;
  return primary === "ua" ? "uk" : primary;
}
