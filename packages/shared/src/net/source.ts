/**
 * Тип джерела за адресою. Демо працює лише із сайтами; соцмережі й маркетплейси
 * відхиляються одразу з проханням дати сайт або текст і фото.
 */
export type SourceKind = "site" | "social" | "marketplace";

/** Домени соцмереж, месенджерів, мап і «link in bio» (з піддоменами). */
const SOCIAL_DOMAINS = [
  "facebook.com",
  "fb.com",
  "fb.me",
  "instagram.com",
  "instagr.am",
  "threads.net",
  "threads.com",
  "tiktok.com",
  "twitter.com",
  "x.com",
  "t.me",
  "telegram.me",
  "telegram.org",
  "youtube.com",
  "youtu.be",
  "linkedin.com",
  "pinterest.com",
  "pin.it",
  "snapchat.com",
  "vk.com",
  "ok.ru",
  "viber.com",
  "whatsapp.com",
  "wa.me",
  "linktr.ee",
  "taplink.cc",
  "taplink.at",
  "maps.google.com",
  "maps.app.goo.gl",
  "goo.gl",
  "g.page",
  "business.site",
  "tripadvisor.com",
  "yelp.com",
];

/** Маркетплейси й дошки оголошень. */
const MARKETPLACE_DOMAINS = [
  "rozetka.com.ua",
  "prom.ua",
  "olx.ua",
  "olx.com",
  "olx.pl",
  "epicentrk.ua",
  "allo.ua",
  "kasta.ua",
  "bigl.ua",
  "shafa.ua",
  "makeup.com.ua",
  "foxtrot.com.ua",
  "comfy.ua",
  "etsy.com",
  "booking.com",
  "airbnb.com",
  "glovo.com",
  "glovoapp.com",
  "bolt.eu",
  "wolt.com",
];

/** Маркетплейси з багатьма доменними зонами: amazon.de, ebay.co.uk, aliexpress.ru… */
const MARKETPLACE_LABELS = [
  "amazon",
  "ebay",
  "aliexpress",
  "temu",
  "shein",
  "walmart",
  "allegro",
  "wildberries",
  "ozon",
];

function matchesDomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

export function classifySource(input: string | URL): SourceKind {
  let url: URL;
  try {
    url = typeof input === "string" ? new URL(input) : input;
  } catch {
    return "site";
  }
  const host = url.hostname
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^(www|m)\./, "");
  if (SOCIAL_DOMAINS.some((d) => matchesDomain(host, d))) return "social";
  // Google Maps / профіль компанії: google.com/maps, google.com.ua/maps…
  if (/^google\.[a-z.]+$/.test(host) && url.pathname.startsWith("/maps")) return "social";
  if (MARKETPLACE_DOMAINS.some((d) => matchesDomain(host, d))) return "marketplace";
  const labels = host.split(".");
  if (labels.some((l) => MARKETPLACE_LABELS.includes(l))) return "marketplace";
  return "site";
}
