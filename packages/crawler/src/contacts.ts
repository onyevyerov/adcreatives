import type { Contacts } from "@adc/shared";

/** Сирі контакти зі сторінки (inpage) або з тексту. */
export interface RawContacts {
  phones: string[];
  emails: string[];
  socials: Array<{ network: string; url: string }>;
  addresses: string[];
  bodyText: string;
}

const PHONE_RE = /(?:\+\s?\d{1,3}[\s.-]?)?\(?\d{2,4}\)?[\s.-]?\d{2,4}[\s.-]?\d{2,3}[\s.-]?\d{2,3}(?![\d])/g;
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,24}/gi;
const SOCIAL_HOSTS: Array<[string, RegExp]> = [
  ["instagram", /(^|\.)instagram\.com$/],
  ["facebook", /(^|\.)(facebook\.com|fb\.com|fb\.me)$/],
  ["tiktok", /(^|\.)tiktok\.com$/],
  ["youtube", /(^|\.)(youtube\.com|youtu\.be)$/],
  ["telegram", /(^|\.)(t\.me|telegram\.me)$/],
  ["linkedin", /(^|\.)linkedin\.com$/],
  ["x", /(^|\.)(twitter\.com|x\.com)$/],
  ["viber", /(^|\.)viber\.com$/],
  ["whatsapp", /(^|\.)(wa\.me|whatsapp\.com)$/],
];

/** Цифри номера (з `+`, якщо є). null — не схоже на телефон. */
export function phoneDigits(raw: string): string | null {
  const digits = raw.replace(/[^\d]/g, "");
  if (digits.length < 9 || digits.length > 15) return null;
  // Дати, ціни і т. п. — надто однорідні послідовності не телефони.
  if (/^(\d)\1+$/.test(digits)) return null;
  return digits;
}

/** Приводить телефон до охайного вигляду без зміни цифр. */
export function formatPhone(raw: string): string {
  return raw
    .replace(/[^\d+()\s-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Телефони з тексту: лише ті, що схожі на номер (з `+` або українського формату 0XX). */
export function phonesFromText(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(PHONE_RE)) {
    const raw = m[0].trim();
    const digits = phoneDigits(raw);
    if (!digits) continue;
    const looksIntl = raw.startsWith("+");
    const looksUa = /^\(?0\d{2}\)?/.test(raw) && digits.length === 10;
    if (!looksIntl && !looksUa) continue;
    out.push(formatPhone(raw));
  }
  return out;
}

export function emailsFromText(text: string): string[] {
  return [...text.matchAll(EMAIL_RE)]
    .map((m) => m[0].toLowerCase().replace(/\.$/, ""))
    .filter((e) => !/\.(png|jpe?g|gif|webp|svg|avif)$/i.test(e) && !/@\d+x\./.test(e));
}

export function socialsFromText(text: string): Array<{ network: string; url: string }> {
  const out: Array<{ network: string; url: string }> = [];
  for (const m of text.matchAll(/(?:https?:\/\/)?(?:www\.)?[a-z0-9.-]+\.[a-z]{2,}\/[^\s,;)]+/gi)) {
    const raw = m[0].startsWith("http") ? m[0] : `https://${m[0]}`;
    try {
      const url = new URL(raw);
      const net = SOCIAL_HOSTS.find(([, re]) => re.test(url.hostname.toLowerCase()));
      if (net) out.push({ network: net[0], url: url.href });
    } catch {
      // ігноруємо
    }
  }
  return out;
}

/** Адреси з JSON-LD (PostalAddress у LocalBusiness/Organization). */
export function addressesFromJsonLd(blocks: unknown[]): string[] {
  const out: string[] = [];
  const visit = (node: unknown, depth: number): void => {
    if (depth > 6 || !node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const n of node) visit(n, depth + 1);
      return;
    }
    const obj = node as Record<string, unknown>;
    const address = obj.address;
    if (typeof address === "string" && address.trim()) out.push(address.trim());
    else if (address && typeof address === "object" && !Array.isArray(address)) {
      const a = address as Record<string, unknown>;
      const parts = [a.addressLocality, a.streetAddress, a.postalCode]
        .filter((p): p is string => typeof p === "string" && p.trim().length > 0)
        .map((p) => p.trim());
      if (parts.length) out.push(parts.join(", "));
    }
    for (const [k, v] of Object.entries(obj)) if (k !== "address") visit(v, depth + 1);
  };
  visit(blocks, 0);
  return out;
}

function socialKey(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^(www|m)\./, "")}${u.pathname.replace(/\/+$/, "").toLowerCase()}`;
  } catch {
    return url;
  }
}

/** Зводить контакти з усіх сторінок: дедуп, ліміти. */
export function mergeContacts(raws: RawContacts[], jsonLd: unknown[] = []): Contacts {
  const phones = new Map<string, string>();
  const emails = new Set<string>();
  const addresses = new Map<string, string>();
  const socials = new Map<string, { network: string; url: string }>();

  const addPhone = (raw: string) => {
    const digits = phoneDigits(raw);
    if (!digits) return;
    const key = digits.slice(-9);
    if (!phones.has(key)) phones.set(key, formatPhone(raw));
  };

  for (const r of raws) {
    for (const p of r.phones) addPhone(p);
    for (const e of r.emails) {
      const email = e.trim().toLowerCase();
      if (/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(email)) emails.add(email);
    }
    for (const s of r.socials) {
      const key = socialKey(s.url);
      if (!socials.has(key)) socials.set(key, s);
    }
    for (const a of r.addresses) {
      const key = a.toLowerCase().replace(/\s+/g, " ");
      if (!addresses.has(key)) addresses.set(key, a);
    }
  }
  // Із тексту — лише якщо явних посилань не знайшли.
  if (phones.size === 0) for (const r of raws) for (const p of phonesFromText(r.bodyText)) addPhone(p);
  if (emails.size === 0) for (const r of raws) for (const e of emailsFromText(r.bodyText)) emails.add(e);
  if (socials.size === 0) {
    for (const r of raws) {
      for (const s of socialsFromText(r.bodyText))
        if (!socials.has(socialKey(s.url))) socials.set(socialKey(s.url), s);
    }
  }
  for (const a of addressesFromJsonLd(jsonLd)) {
    const key = a.toLowerCase().replace(/\s+/g, " ");
    if (!addresses.has(key)) addresses.set(key, a);
  }

  return {
    phones: [...phones.values()].slice(0, 5),
    emails: [...emails].slice(0, 5),
    addresses: [...addresses.values()].slice(0, 5),
    socials: [...socials.values()].slice(0, 10),
  };
}
