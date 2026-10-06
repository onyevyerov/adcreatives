import { isIP } from "node:net";
import {
  assertPublicHttpUrl,
  isBlockedHostname,
  isPublicIp,
  type Resolver,
  systemResolver,
  UnsafeUrlError,
} from "@adc/shared";
import type { BrowserContext, Route } from "playwright";

/**
 * Перенаправлення з'єднань для тестів: ім'я хоста (або `*.suffix`) → IP, на який
 * реально з'єднуватись. Перевірка безпеки для таких хостів однаково йде через
 * `resolve`; літеральні приватні адреси (http://127.0.0.1/…) блокуються завжди.
 */
export type HostMap = Record<string, string>;

export interface UrlGuardOptions {
  /** DNS для перевірки безпеки (за замовчуванням системний). */
  resolve?: Resolver;
  /** Лише для тестів: куди реально з'єднуватись для вказаних хостів. */
  hostMap?: HostMap;
}

/**
 * Захист від SSRF для всього мережевого трафіку краулера (браузер через фільтрувальний
 * проксі + `context.route`, завантаження sitemap і картинок через `safeFetch`).
 * Кожна адреса перевіряється, а з'єднання йде саме на ту IP, яку перевірили
 * (захист від DNS rebinding). Результат кешується за хостом на весь краулінг.
 */
export class UrlGuard {
  /** Адреси, запити на які заблоковано (для журналу й тестів). */
  readonly blocked: string[] = [];
  private readonly targets = new Map<string, Promise<string>>();
  private readonly resolve: Resolver;
  private readonly hostMap: HostMap;

  constructor(opts: UrlGuardOptions = {}) {
    this.resolve = opts.resolve ?? systemResolver;
    this.hostMap = Object.fromEntries(
      Object.entries(opts.hostMap ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    );
  }

  /** Перевірка адреси перед стартом/на редиректі. Кидає `UnsafeUrlError`. */
  assert(url: string | URL): Promise<URL> {
    return assertPublicHttpUrl(url, { resolve: this.resolve });
  }

  /** Запам'ятовує заблоковану адресу. */
  noteBlocked(url: string): void {
    if (this.blocked.length < 500) this.blocked.push(url);
  }

  /**
   * IP, на яку можна з'єднатись для цього хоста. Кидає `UnsafeUrlError`, якщо хост
   * заблокований або будь-яка з його адрес не публічна.
   */
  resolveTarget(hostname: string): Promise<string> {
    const host = hostname
      .toLowerCase()
      .replace(/^\[|\]$/g, "")
      .replace(/\.$/, "");
    let target = this.targets.get(host);
    if (!target) {
      target = this.lookupTarget(host);
      this.targets.set(host, target);
      // Невдалу перевірку теж кешуємо, але без unhandled rejection.
      target.catch(() => {});
    }
    return target;
  }

  private async lookupTarget(host: string): Promise<string> {
    if (!host) throw new UnsafeUrlError("invalid", "порожній хост");
    if (isIP(host)) {
      if (!isPublicIp(host)) throw new UnsafeUrlError("private_address", `приватна адреса: ${host}`);
      return host;
    }
    if (isBlockedHostname(host)) throw new UnsafeUrlError("blocked_host", `заборонений хост: ${host}`);
    let addresses: string[];
    try {
      addresses = await this.resolve(host);
    } catch (err) {
      throw new UnsafeUrlError("dns", `не вдалося знайти сайт ${host}: ${(err as Error).message}`);
    }
    if (addresses.length === 0) throw new UnsafeUrlError("dns", `сайт ${host} не має адрес`);
    const bad = addresses.find((a) => !isPublicIp(a));
    if (bad) throw new UnsafeUrlError("private_address", `${host} веде на приватну адресу ${bad}`);
    const mapped = this.mappedHost(host);
    return mapped ?? (addresses[0] as string);
  }

  private mappedHost(host: string): string | null {
    const exact = this.hostMap[host];
    if (exact) return exact;
    for (const [pattern, ip] of Object.entries(this.hostMap)) {
      if (pattern.startsWith("*.") && host.endsWith(pattern.slice(1))) return ip;
    }
    return null;
  }

  /** Чи можна браузеру виконати запит на цю адресу. */
  async isAllowed(raw: string): Promise<boolean> {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return false;
    }
    // Вбудовані дані не ходять у мережу.
    if (url.protocol === "data:" || url.protocol === "blob:" || raw === "about:blank") return true;
    if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) return false;
    if (url.username || url.password) return false;
    try {
      await this.resolveTarget(url.hostname);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Обриває запити сторінок до приватних адрес через `context.route`. Редиректи
   * Playwright не маршрутизує — їх ловить фільтрувальний проксі (див. proxy.ts).
   */
  async install(context: BrowserContext, opts: { blockMedia?: boolean } = {}): Promise<void> {
    await context.route("**/*", async (route: Route) => {
      const request = route.request();
      const url = request.url();
      if (!(await this.isAllowed(url))) {
        this.noteBlocked(url);
        await route.abort("blockedbyclient").catch(() => {});
        return;
      }
      // Відео й аудіо краулеру не потрібні — економимо трафік і час.
      if (opts.blockMedia && request.resourceType() === "media") {
        await route.abort("blockedbyclient").catch(() => {});
        return;
      }
      await route.continue().catch(() => {});
    });
  }
}
