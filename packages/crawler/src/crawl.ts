import {
  type Asset,
  type Logger,
  noopLogger,
  normalizeInputUrl,
  type PageData,
  projectPaths,
  type Resolver,
  SiteData,
  type Storage,
  UnsafeUrlError,
} from "@adc/shared";
import { type Browser, chromium, type LaunchOptions, type Page } from "playwright";
import { type AssetCandidate, buildSiteAssets, type DownloadedCandidate, MAX_SITE_ASSETS } from "./assets.ts";
import { mergeContacts } from "./contacts.ts";
import { mergeDesign } from "./design.ts";
import { detectLanguageVersions, type LinkCandidate, parseSitemap, selectPages } from "./discovery.ts";
import { safeFetch } from "./fetch.ts";
import { type HostMap, UrlGuard } from "./guard.ts";
import {
  autoScroll,
  dismissConsent,
  expandCollapsed,
  extractPage,
  hideOverlays,
  type RawImage,
  type RawPage,
  waitForFonts,
} from "./inpage.ts";
import { startGuardProxy } from "./proxy.ts";
import { isSameSite, normalizeLang, pageKey, parseUrl } from "./url.ts";
import { mapPool, sleep, withTimeout } from "./util.ts";

/** Ліміти краулера зі специфікації. */
export const CRAWL_LIMITS = {
  maxPages: 25,
  timeBudgetMs: 120_000,
  concurrency: 4,
  maxAssets: MAX_SITE_ASSETS,
  viewport: { width: 1440, height: 900 },
  /** Скільки екранів нижче першого знімаємо на головній. */
  homeScreensBelow: 2,
} as const;

const NAV_TIMEOUT_MS = 30_000;
/** Скільки кандидатів у картинки завантажувати (після дедупу лишиться ≤ 40). */
const MAX_IMAGE_CANDIDATES = 70;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

export interface CrawlProgress {
  phase: "pages" | "assets";
  done: number;
  total: number;
}

export interface CrawlOptions {
  storage: Storage;
  projectId: string;
  maxPages?: number;
  timeBudgetMs?: number;
  concurrency?: number;
  maxAssets?: number;
  /** DNS для перевірки безпеки адрес (тести підставляють свій). */
  resolve?: Resolver;
  /** Лише для тестів: реальні IP для з'єднання з тестовими хостами. */
  hostMap?: HostMap;
  /** Додаткові параметри запуску Chromium (напр. `executablePath`). */
  launch?: Omit<LaunchOptions, "proxy">;
  onProgress?: (p: CrawlProgress) => void | Promise<void>;
  signal?: AbortSignal;
  logger?: Logger;
  now?: () => Date;
}

export interface CrawlResult {
  site: SiteData;
  /** Асети сайту (файли вже записані в `crawl/assets/`). */
  assets: Asset[];
  /** Заблоковані запити до приватних адрес (журнал і тести). */
  blocked: string[];
}

export type CrawlFailReason = "unsafe_url" | "unreachable" | "not_html" | "aborted";

/** Не вдалося завантажити жодної сторінки (головна недоступна або небезпечна). */
export class CrawlFailedError extends Error {
  override name = "CrawlFailedError";
  constructor(
    public readonly reason: CrawlFailReason,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

class PageError extends Error {
  override name = "PageError";
}

interface Visit {
  index: number;
  raw: RawPage;
  screenshots: SiteData["screenshots"];
}

/** Блоки JSON-LD, які не описують бізнес. */
const JSONLD_NOISE = new Set([
  "WebSite",
  "WebPage",
  "BreadcrumbList",
  "SearchAction",
  "ImageObject",
  "SiteNavigationElement",
  "ReadAction",
  "CollectionPage",
  "ListItem",
  "EntryPoint",
  "WPHeader",
  "WPFooter",
  "WPSideBar",
]);

function typesOf(node: unknown): string[] {
  if (!node || typeof node !== "object") return [];
  const t = (node as Record<string, unknown>)["@type"];
  if (typeof t === "string") return [t];
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === "string");
  return [];
}

/** Лишає блоки JSON-LD про бізнес (LocalBusiness, Organization, Product, FAQ…), розгортає @graph. */
export function filterJsonLd(blocks: unknown[]): unknown[] {
  const flat: unknown[] = [];
  for (const b of blocks) {
    const list = Array.isArray(b) ? b : [b];
    for (const item of list) {
      const graph =
        item && typeof item === "object" ? (item as Record<string, unknown>)["@graph"] : undefined;
      if (Array.isArray(graph)) flat.push(...graph);
      else flat.push(item);
    }
  }
  return flat
    .filter((n) => {
      const types = typesOf(n);
      return types.length > 0 && !types.every((t) => JSONLD_NOISE.has(t));
    })
    .filter((n) => JSON.stringify(n).length <= 30_000)
    .slice(0, 20);
}

/**
 * Краулить сайт: головна → sitemap + лінки → до 25 сторінок у 4 вкладки за 120 с.
 * Скриншоти й асети пише у сховище проєкту; `site.json`/`assets.json` записує стадія.
 */
export async function crawlSite(inputUrl: string, opts: CrawlOptions): Promise<CrawlResult> {
  const now = opts.now ?? (() => new Date());
  const logger = opts.logger ?? noopLogger;
  const started = Date.now();
  const maxPages = opts.maxPages ?? CRAWL_LIMITS.maxPages;
  const budget = opts.timeBudgetMs ?? CRAWL_LIMITS.timeBudgetMs;
  const concurrency = opts.concurrency ?? CRAWL_LIMITS.concurrency;
  const deadline = started + budget;
  // Запас часу на завантаження картинок після сторінок.
  const pagesDeadline = deadline - Math.min(20_000, budget * 0.2);
  const remaining = (until = deadline) => until - Date.now();
  const paths = projectPaths(opts.projectId);
  const progress = async (p: CrawlProgress) => {
    try {
      await opts.onProgress?.(p);
    } catch (err) {
      logger.warn("прогрес не надіслано", { error: (err as Error).message });
    }
  };
  const checkAbort = () => {
    if (opts.signal?.aborted) throw new CrawlFailedError("aborted", "краулінг скасовано");
  };

  const guard = new UrlGuard({ resolve: opts.resolve, hostMap: opts.hostMap });
  let startUrl: URL;
  try {
    startUrl = await guard.assert(normalizeInputUrl(inputUrl));
  } catch (err) {
    // Хост, якого немає в DNS, — просто недоступний сайт, а не небезпечна адреса.
    const reason = err instanceof UnsafeUrlError && err.reason === "dns" ? "unreachable" : "unsafe_url";
    throw new CrawlFailedError(reason, (err as Error).message, { cause: err });
  }

  const proxy = await startGuardProxy(guard);
  let browser: Browser | null = null;
  let stopped = false;
  try {
    browser = await chromium.launch({
      headless: true,
      ...opts.launch,
      // Увесь трафік — через фільтрувальний проксі, навіть loopback.
      proxy: { server: proxy.server, bypass: "<-loopback>" },
      args: [
        ...(opts.launch?.args ?? []),
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
        "--disable-quic",
      ],
    });
    const context = await browser.newContext({
      viewport: { ...CRAWL_LIMITS.viewport },
      deviceScaleFactor: 1,
      reducedMotion: "reduce",
      serviceWorkers: "block",
      acceptDownloads: false,
      bypassCSP: true,
      locale: "uk-UA",
    });
    context.setDefaultTimeout(15_000);
    await guard.install(context, { blockMedia: true });

    const visit = async (page: Page, url: string, index: number, until: number): Promise<Visit> => {
      const response = await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: Math.max(1_000, Math.min(NAV_TIMEOUT_MS, until - Date.now())),
      });
      const finalUrl = page.url();
      if (!(await guard.isAllowed(finalUrl))) {
        throw new UnsafeUrlError("private_address", `редирект на заборонену адресу: ${finalUrl}`);
      }
      if (!response) throw new PageError(`немає відповіді: ${url}`);
      if (response.status() >= 400) throw new PageError(`HTTP ${response.status()}: ${url}`);
      const type = (await response.headerValue("content-type")) ?? "";
      if (type && !/html|xml/i.test(type)) throw new PageError(`не HTML (${type}): ${url}`);

      const step = (ms: number) => Math.max(200, Math.min(ms, until - Date.now()));
      await page.waitForLoadState("load", { timeout: step(8_000) }).catch(() => {});
      await withTimeout(dismissConsent(page), step(3_000)).catch(() => 0);
      await sleep(250);
      await withTimeout(hideOverlays(page), step(3_000)).catch(() => 0);
      await withTimeout(autoScroll(page), step(10_000)).catch(() => 0);
      await page.waitForLoadState("networkidle", { timeout: step(2_500) }).catch(() => {});
      await withTimeout(waitForFonts(page, 3_000), step(4_000)).catch(() => false);
      // Банери, що з'явились із затримкою або після прокрутки.
      await withTimeout(dismissConsent(page), step(3_000)).catch(() => 0);
      await withTimeout(hideOverlays(page), step(3_000)).catch(() => 0);
      await expandContent(page, url, step);

      const raw = await withTimeout(extractPage(page), step(20_000), "витягування даних");
      if (stopped) throw new PageError("краулінг зупинено");

      const screenshots: SiteData["screenshots"] = [];
      const shoot = async (viewport: "first" | "below-1" | "below-2", y: number) => {
        await page.evaluate(`window.scrollTo(0, ${y})`);
        await sleep(viewport === "first" ? 150 : 350);
        const buf = await page.screenshot({ type: "png", timeout: step(10_000) });
        if (stopped) return;
        const key = paths.screenshot(viewport === "first" ? `${index}.png` : `${index}-${viewport}.png`);
        await opts.storage.write(key, buf);
        screenshots.push({ pageUrl: raw.url, path: key, viewport, ...CRAWL_LIMITS.viewport });
      };
      await shoot("first", 0);
      if (index === 0) {
        const h = CRAWL_LIMITS.viewport.height;
        for (let k = 1; k <= CRAWL_LIMITS.homeScreensBelow; k++) {
          if (raw.docHeight < k * h + h / 3) break;
          await shoot(k === 1 ? "below-1" : "below-2", k * h);
        }
      }
      return { index, raw, screenshots };
    };

    // 1. Головна.
    checkAbort();
    const homeTab = await context.newPage();
    let home: Visit;
    try {
      home = await visit(homeTab, startUrl.href, 0, pagesDeadline);
    } catch (err) {
      if (err instanceof UnsafeUrlError) {
        throw new CrawlFailedError("unsafe_url", err.message, { cause: err });
      }
      // Навігацію обірвав проксі (напр. HTTPS-редирект на приватну адресу).
      const blockedHop = guard.blocked[0];
      if (blockedHop) {
        throw new CrawlFailedError("unsafe_url", `редирект на заборонену адресу: ${blockedHop}`, {
          cause: err,
        });
      }
      throw new CrawlFailedError("unreachable", `головна не завантажилась: ${(err as Error).message}`, {
        cause: err,
      });
    }
    const homeUrl = home.raw.url;

    // 2. Мовні версії і вибір сторінок.
    const lv = detectLanguageVersions({
      home: homeUrl,
      htmlLang: home.raw.lang,
      hreflang: home.raw.hreflang,
      links: home.raw.links.map((l) => l.url),
    });
    const sitemapPages = await loadSitemap(
      guard,
      homeUrl,
      Math.min(10_000, remaining(pagesDeadline) / 3),
      logger,
    );
    const candidates: LinkCandidate[] = [
      ...home.raw.links.map((l) => ({ url: l.url, text: l.text, inNav: l.inNav, source: "home" as const })),
      ...sitemapPages.map((url) => ({ url, text: "", inNav: false, source: "sitemap" as const })),
    ];
    const selected = selectPages({
      home: homeUrl,
      candidates,
      limit: maxPages - 1,
      lang: lv.language,
      otherVersions: lv.versions.filter((v) => v.lang !== lv.language).map((v) => v.url),
    });
    const total = selected.length + 1;
    let done = 1;
    await progress({ phase: "pages", done, total });

    // 3. Решта сторінок у кілька вкладок.
    const visits: Visit[] = [home];
    const seenKeys = new Set<string>([pageKeyOf(homeUrl)]);
    let failed = 0;
    let timedOut = false;
    let next = 0;
    const homeParsed = parseUrl(homeUrl) as URL;
    const worker = async (page: Page) => {
      while (next < selected.length && !stopped) {
        if (opts.signal?.aborted) return;
        if (remaining(pagesDeadline) < 3_000) {
          timedOut = true;
          return;
        }
        const i = next++;
        const url = selected[i] as string;
        try {
          const v = await visit(page, url, i + 1, pagesDeadline);
          const final = parseUrl(v.raw.url);
          const key = pageKeyOf(v.raw.url);
          // Редирект на інший сайт або на вже відвідану сторінку — не рахуємо.
          if (final && isSameSite(final, homeParsed) && !seenKeys.has(key)) {
            seenKeys.add(key);
            visits.push(v);
          }
        } catch (err) {
          if (!stopped) {
            failed++;
            logger.warn("сторінка не завантажилась", { url, error: (err as Error).message });
          }
        }
        done++;
        if (!stopped) await progress({ phase: "pages", done, total });
      }
    };
    const extraTabs = await Promise.all(
      Array.from({ length: Math.max(0, Math.min(concurrency, selected.length) - 1) }, () =>
        context.newPage(),
      ),
    );
    const workers = Promise.all([homeTab, ...extraTabs].map((tab) => worker(tab)));
    try {
      // Вкладки, що зависли довше за ліміт, не чекаємо — браузер закриється у finally.
      await withTimeout(workers, Math.max(0, remaining(pagesDeadline) + 5_000), "краулінг сторінок");
    } catch {
      timedOut = true;
    }
    stopped = true;
    if (next < selected.length) timedOut = true;
    checkAbort();
    for (const tab of [homeTab, ...extraTabs]) await tab.close().catch(() => {});

    // 4. Асети.
    visits.sort((a, b) => a.index - b.index);
    const assetCandidates = collectAssetCandidates(visits);
    const downloaded = await downloadCandidates(guard, assetCandidates, deadline, progress, logger);
    const assets = await buildSiteAssets(downloaded, {
      storage: opts.storage,
      projectId: opts.projectId,
      maxAssets: opts.maxAssets ?? CRAWL_LIMITS.maxAssets,
    });

    // 5. site.json.
    const pages: PageData[] = visits.map((v) => ({
      url: v.raw.url,
      title: v.raw.title,
      description: v.raw.description,
      lang: normalizeLang(v.raw.lang) ?? v.raw.lang,
      headings: v.raw.headings,
      text: v.raw.text,
      buttons: v.raw.buttons,
      jsonLd: filterJsonLd(v.raw.jsonLd),
      og: v.raw.og,
      screenshot: v.screenshots.find((s) => s.viewport === "first")?.path ?? null,
    }));
    const navSeen = new Set<string>();
    const navigation = home.raw.nav
      .filter((n) => {
        const u = parseUrl(n.url);
        if (!u || !isSameSite(u, homeParsed) || navSeen.has(pageKeyOf(n.url))) return false;
        navSeen.add(pageKeyOf(n.url));
        return true;
      })
      .slice(0, 30);
    const site = SiteData.parse({
      source: "site",
      url: startUrl.href,
      finalUrl: homeUrl,
      crawledAt: now().toISOString(),
      partial: timedOut || failed > 0,
      language: lv.language,
      languageVersions: lv.versions,
      pages,
      navigation,
      contacts: mergeContacts(
        visits.map((v) => v.raw.contacts),
        pages.flatMap((p) => p.jsonLd),
      ),
      design: mergeDesign(visits.map((v) => v.raw.design)),
      screenshots: visits.flatMap((v) => v.screenshots),
      manualText: null,
      stats: { pagesVisited: visits.length, pagesFailed: failed, durationMs: Date.now() - started },
    });
    return { site, assets, blocked: [...guard.blocked] };
  } finally {
    stopped = true;
    await browser?.close().catch(() => {});
    await proxy.close().catch(() => {});
  }
}

/**
 * Розкриває згорнутий зміст (FAQ-акордеони, `<details>`, вкладки), щоб відповіді потрапили в текст.
 * Якщо клік усе ж відвів зі сторінки (скрипт змінив адресу), повертаємось на неї без розкриття.
 */
async function expandContent(page: Page, url: string, step: (ms: number) => number): Promise<void> {
  const before = page.url();
  await withTimeout(expandCollapsed(page), step(8_000)).catch(() => null);
  if (withoutHash(page.url()) === withoutHash(before)) return;
  await page
    .goto(before || url, { waitUntil: "domcontentloaded", timeout: step(NAV_TIMEOUT_MS) })
    .catch(() => null);
  await page.waitForLoadState("load", { timeout: step(8_000) }).catch(() => {});
  await withTimeout(dismissConsent(page), step(3_000)).catch(() => 0);
  await withTimeout(hideOverlays(page), step(3_000)).catch(() => 0);
}

const withoutHash = (url: string) => url.replace(/#.*$/, "");

function pageKeyOf(url: string): string {
  const u = parseUrl(url);
  return u ? pageKey(u) : url;
}

/** Sitemap: адреси з robots.txt або /sitemap.xml, вкладені карти — до трьох. */
async function loadSitemap(
  guard: UrlGuard,
  homeUrl: string,
  timeBudgetMs: number,
  logger: Logger,
): Promise<string[]> {
  const home = new URL(homeUrl);
  const until = Date.now() + Math.max(0, timeBudgetMs);
  const get = async (url: string): Promise<string | null> => {
    const left = until - Date.now();
    if (left < 300) return null;
    try {
      const res = await safeFetch(guard, url, { timeoutMs: left, maxBytes: 5 * 1024 * 1024 });
      if (res.status !== 200) return null;
      const target = parseUrl(res.url);
      if (!target || !isSameSite(target, home)) return null;
      return res.body.toString("utf8");
    } catch (err) {
      logger.debug("sitemap недоступний", { url, error: (err as Error).message });
      return null;
    }
  };

  const roots: string[] = [];
  const robots = await get(new URL("/robots.txt", home).href);
  if (robots) {
    for (const m of robots.matchAll(/^\s*sitemap:\s*(\S+)/gim)) {
      const u = parseUrl(m[1] ?? "", home);
      if (u && isSameSite(u, home) && !/\.gz$/i.test(u.pathname)) roots.push(u.href);
    }
  }
  if (roots.length === 0) roots.push(new URL("/sitemap.xml", home).href);

  const pages: string[] = [];
  const queue = roots.slice(0, 2);
  let fetched = 0;
  while (queue.length > 0 && fetched < 4 && pages.length < 500) {
    const url = queue.shift() as string;
    fetched++;
    const xml = await get(url);
    if (!xml) continue;
    const parsed = parseSitemap(xml);
    pages.push(...parsed.pages);
    // Карти сторінок важливіші за карти товарів і записів блогу.
    const nested = parsed.sitemaps
      .filter((s) => !/\.gz$/i.test(s))
      .sort((a, b) => nestedRank(a) - nestedRank(b));
    queue.push(...nested.slice(0, 3));
  }
  return pages.slice(0, 500);
}

function nestedRank(url: string): number {
  if (/page|static|main|general/i.test(url)) return 0;
  if (/categor|service|product_cat/i.test(url)) return 1;
  if (/product/i.test(url)) return 2;
  if (/post|blog|news|article/i.test(url)) return 3;
  return 1;
}

const KIND_ORDER: Record<RawImage["kind"], number> = { logo: 0, icon: 1, og: 2, photo: 3, background: 3 };

/** Кандидати в асети з усіх сторінок: дедуп за адресою, лого першими, далі за сторінкою й позицією. */
export function collectAssetCandidates(visits: Array<{ index: number; raw: RawPage }>): AssetCandidate[] {
  const byUrl = new Map<string, AssetCandidate>();
  for (const v of visits) {
    for (const img of v.raw.images) {
      const key = img.svg ? `${v.index}:${img.url}` : img.url;
      if (byUrl.has(key)) {
        const existing = byUrl.get(key) as AssetCandidate;
        if (KIND_ORDER[img.kind] < KIND_ORDER[existing.kind]) existing.kind = img.kind;
        continue;
      }
      byUrl.set(key, {
        url: img.svg ? `inline-svg:${v.index}-${img.url.split(":")[1] ?? "0"}` : img.url,
        kind: img.kind,
        alt: img.alt,
        context: img.context,
        pageUrl: v.raw.url,
        pageIndex: v.index,
        top: img.top,
        renderedWidth: img.width,
        renderedHeight: img.height,
        svg: img.svg,
      });
    }
  }
  return [...byUrl.values()]
    .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.pageIndex - b.pageIndex || a.top - b.top)
    .slice(0, MAX_IMAGE_CANDIDATES);
}

async function downloadCandidates(
  guard: UrlGuard,
  candidates: AssetCandidate[],
  deadline: number,
  progress: (p: CrawlProgress) => Promise<void>,
  logger: Logger,
): Promise<DownloadedCandidate[]> {
  let done = 0;
  const total = candidates.length;
  if (total > 0) await progress({ phase: "assets", done, total });
  const results = await mapPool(candidates, 6, async (candidate) => {
    let out: DownloadedCandidate | null = null;
    if (candidate.svg) {
      out = { candidate, data: Buffer.from(candidate.svg, "utf8") };
    } else if (deadline - Date.now() > 500) {
      try {
        const res = await safeFetch(guard, candidate.url, {
          timeoutMs: Math.min(15_000, deadline - Date.now()),
          maxBytes: MAX_IMAGE_BYTES,
          headers: { referer: candidate.pageUrl, accept: "image/avif,image/webp,image/*,*/*;q=0.8" },
        });
        if (res.status === 200 && res.body.length > 0)
          out = { candidate: { ...candidate, url: res.url }, data: res.body };
      } catch (err) {
        logger.debug("картинка не завантажилась", { url: candidate.url, error: (err as Error).message });
      }
    }
    done++;
    if (done % 5 === 0 || done === total) await progress({ phase: "assets", done, total });
    return out;
  });
  return results.filter((r): r is DownloadedCandidate => r !== null);
}
