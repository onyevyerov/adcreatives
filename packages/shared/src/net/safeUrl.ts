import { lookup as dnsLookup } from "node:dns/promises";
import ipaddr from "ipaddr.js";

/**
 * Захист від SSRF: краулер і API ходять лише на публічні http(s)-адреси.
 * Викликається перед стартом краулера і на кожному редиректі; запити сторінки
 * до приватних адрес краулер обриває через `page.route` + `isPublicIp`.
 */

export type UnsafeUrlReason =
  | "invalid"
  | "protocol"
  | "credentials"
  | "private_address"
  | "blocked_host"
  | "dns";

export class UnsafeUrlError extends Error {
  override name = "UnsafeUrlError";
  constructor(
    public readonly reason: UnsafeUrlReason,
    message: string,
  ) {
    super(message);
  }
}

/** Імена хостів, які ніколи не краулимо (метадані хмар, локальні зони). */
const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata",
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
  "instance-data.ec2.internal",
]);
const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".localdomain", ".home.arpa", ".lan"];

/** Чи є IP-адреса публічною unicast (не приватна, не loopback, не link-local, не метадані). */
export function isPublicIp(ip: string): boolean {
  if (!ipaddr.isValid(ip)) return false;
  let addr = ipaddr.parse(ip);
  if (addr.kind() === "ipv6" && (addr as ipaddr.IPv6).isIPv4MappedAddress()) {
    addr = (addr as ipaddr.IPv6).toIPv4Address();
  }
  if (addr.range() !== "unicast") return false;
  if (addr.kind() === "ipv6") {
    // NAT64/6to4/Teredo можуть вести на внутрішні IPv4 — для демо просто не пускаємо.
    const v6 = addr as ipaddr.IPv6;
    const first = v6.parts[0] ?? 0;
    if (
      first === 0x2002 ||
      (first === 0x2001 && v6.parts[1] === 0) ||
      (first === 0x64 && v6.parts[1] === 0xff9b)
    ) {
      return false;
    }
  }
  return true;
}

export function isBlockedHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  if (BLOCKED_HOSTNAMES.has(h)) return true;
  if (BLOCKED_SUFFIXES.some((s) => h.endsWith(s))) return true;
  // Хост без крапки (intranet-імена) не публічний.
  return !h.includes(".") && !ipaddr.isValid(h);
}

export type Resolver = (hostname: string) => Promise<string[]>;

export const systemResolver: Resolver = async (hostname) =>
  (await dnsLookup(hostname, { all: true, verbatim: true })).map((r) => r.address);

/** Додає https://, якщо клієнт вставив адресу без схеми. */
export function normalizeInputUrl(input: string): string {
  const trimmed = input.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed.replace(/^\/\//, "")}`;
}

/**
 * Перевіряє, що URL — публічна http(s)-адреса: протокол, відсутність облікових даних,
 * хост не з чорного списку, IP (літерал або всі адреси з DNS) — публічні.
 */
export async function assertPublicHttpUrl(
  input: string | URL,
  opts: { resolve?: Resolver } = {},
): Promise<URL> {
  let url: URL;
  try {
    url = typeof input === "string" ? new URL(input) : new URL(input.href);
  } catch {
    throw new UnsafeUrlError("invalid", `некоректна адреса: ${String(input)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UnsafeUrlError("protocol", `дозволено лише http і https, отримано ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new UnsafeUrlError("credentials", "адреса з логіном/паролем заборонена");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host) throw new UnsafeUrlError("invalid", "порожній хост");

  if (ipaddr.isValid(host)) {
    if (!isPublicIp(host))
      throw new UnsafeUrlError("private_address", `приватна або службова адреса: ${host}`);
    return url;
  }
  // Десяткові/шістнадцяткові записи IPv4 (http://2130706433/) WHATWG URL вже нормалізує в крапковий вигляд.
  if (isBlockedHostname(host)) throw new UnsafeUrlError("blocked_host", `заборонений хост: ${host}`);

  let addresses: string[];
  try {
    addresses = await (opts.resolve ?? systemResolver)(host);
  } catch (err) {
    throw new UnsafeUrlError("dns", `не вдалося знайти сайт ${host}: ${(err as Error).message}`);
  }
  if (addresses.length === 0) throw new UnsafeUrlError("dns", `сайт ${host} не має адрес`);
  const bad = addresses.find((a) => !isPublicIp(a));
  if (bad) throw new UnsafeUrlError("private_address", `${host} веде на приватну адресу ${bad}`);
  return url;
}
