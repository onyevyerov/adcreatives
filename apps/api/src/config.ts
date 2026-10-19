import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CreditsConfig,
  costTargetUsd,
  defaultCredits,
  loadCredits,
  loadPrices,
  type Prices,
  type Resolver,
} from "@adc/shared";

/** Тека зі статичною сторінкою чату (`apps/api/public`). */
export const DEFAULT_PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

/** Ліміти фото клієнта (збігаються з `ingestUserPhotos` у краулері). */
export const MAX_PHOTOS_PER_REQUEST = 10;
export const MAX_PHOTO_BYTES = 25 * 1024 * 1024;
/** Межа тіла multipart-запиту: 10 фото по 25 МБ + поля. */
export const MAX_UPLOAD_BODY_BYTES = MAX_PHOTOS_PER_REQUEST * MAX_PHOTO_BYTES + 1024 * 1024;
export const MAX_MESSAGE_CHARS = 4000;
export const MAX_MANUAL_TEXT_CHARS = 20_000;

export interface ApiConfig {
  /** Пароль HTTP Basic (`APP_PASSWORD`); порожній — без авторизації. */
  appPassword: string;
  /** `COST_TARGET_USD`: рядки дорожчі за ціль позначаються в /stats. */
  costTargetUsd: number;
  /** `config/prices.json` (для рядка повної собівартості); null — не вдалося прочитати. */
  prices: Prices | null;
  publicDir: string;
  /** DNS-резолвер для `assertPublicHttpUrl` (у тестах — фейк). */
  resolve?: Resolver;
  /** Скільки XREAD BLOCK чекає нових подій перед keep-alive коментарем SSE, мс. */
  sseBlockMs: number;
  now: () => Date;
  /** ADMIN_EMAILS: кома, trim, lowercase. Роль обчислюється з e-mail на кожен запит. */
  adminEmails: string[];
  /** APP_URL — база для посилань у листах і checkout; дефолт http://localhost:${PORT}. */
  appUrl: string;
  /** `config/credits.json` (ціни в кредитах, пакети поповнення). */
  credits: CreditsConfig;
}

/** `ADMIN_EMAILS`: адреси через кому → trim, lowercase, без порожніх. */
export function parseAdminEmails(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0);
}

function safeLoadPrices(): Prices | null {
  try {
    return loadPrices();
  } catch {
    return null;
  }
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  return {
    appPassword: env.APP_PASSWORD ?? "",
    costTargetUsd: costTargetUsd(env),
    prices: safeLoadPrices(),
    publicDir: DEFAULT_PUBLIC_DIR,
    sseBlockMs: 15_000,
    now: () => new Date(),
    adminEmails: parseAdminEmails(env.ADMIN_EMAILS),
    appUrl: (env.APP_URL || `http://localhost:${Number(env.PORT) || 3000}`).replace(/\/+$/, ""),
    // Без валідного config/credits.json API не стартує: ціни — частина контракту з клієнтом.
    credits: loadCredits(),
  };
}

export function defaultConfig(overrides: Partial<ApiConfig> = {}): ApiConfig {
  return {
    appPassword: "",
    costTargetUsd: 3.5,
    prices: null,
    publicDir: DEFAULT_PUBLIC_DIR,
    sseBlockMs: 15_000,
    now: () => new Date(),
    adminEmails: ["admin@example.com"],
    appUrl: "http://localhost:3000",
    credits: defaultCredits(),
    ...overrides,
  };
}
