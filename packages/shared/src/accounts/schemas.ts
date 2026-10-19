import { z } from "zod";
import { Format, IsoDate } from "../schemas/common.ts";

/**
 * Акаунти, кредитний леджер, поповнення і листи (макет: outbox замість відправки).
 * Файли — у `DATA_DIR` (див. `accountPaths`), сесії й одноразові токени — у Redis.
 */

export const UserId = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
export type UserId = z.infer<typeof UserId>;

export const Email = z.string().trim().toLowerCase().email().max(254);
export type Email = z.infer<typeof Email>;

/** `users/<id>/user.json`. */
export const User = z.object({
  id: UserId,
  email: Email,
  name: z.string().trim().min(1).max(80),
  /** "scrypt$N$r$p$<salt b64url>$<hash b64url>" */
  passwordHash: z.string(),
  createdAt: IsoDate,
  activatedAt: IsoDate.nullable(),
});
export type User = z.infer<typeof User>;

/** Користувач у відповідях API: без хеша пароля, з роллю (обчислюється з `ADMIN_EMAILS`). */
export const PublicUser = User.omit({ passwordHash: true }).extend({ isAdmin: z.boolean() });
export type PublicUser = z.infer<typeof PublicUser>;

export const LEDGER_KINDS = ["topup", "bonus", "charge", "refund", "adjust"] as const;
export const LedgerKind = z.enum(LEDGER_KINDS);
export type LedgerKind = z.infer<typeof LedgerKind>;

/** Рядок `users/<id>/ledger.jsonl`. */
export const LedgerEntry = z.object({
  /** Ключ ідемпотентності: video:<pid> | revision:<pid>:r<n> | format:<pid>:<format> | topup:<id> | bonus:signup:<uid> | refund:<pid> | adjust:<nanoid> */
  id: z.string().min(1).max(120),
  userId: UserId,
  at: IsoDate,
  kind: LedgerKind,
  /** Цілі кредити; charge < 0, решта > 0 (adjust — будь-який знак ≠ 0). */
  credits: z.number().int(),
  balanceAfter: z.number().int(),
  ref: z
    .object({
      projectId: z.string().optional(),
      rev: z.number().int().optional(),
      format: Format.optional(),
      topupId: z.string().optional(),
      /** adjust: хто нарахував. */
      byUserId: UserId.optional(),
    })
    .default({}),
  note: z.string().max(200).default(""),
});
export type LedgerEntry = z.infer<typeof LedgerEntry>;

export const TopUpStatus = z.enum(["pending", "paid", "failed"]);
export type TopUpStatus = z.infer<typeof TopUpStatus>;

/** `users/<id>/topups/<topupId>.json`. */
export const TopUp = z.object({
  id: z.string(),
  userId: UserId,
  /** id пакета з credits.json або "custom". */
  packageId: z.string(),
  credits: z.number().int().positive(),
  priceUsd: z.number().min(0),
  status: TopUpStatus,
  createdAt: IsoDate,
  paidAt: IsoDate.nullable(),
});
export type TopUp = z.infer<typeof TopUp>;

/** `outbox/<ts>-<id>.json` — «надісланий» лист. */
export const OutboxMail = z.object({
  id: z.string(),
  at: IsoDate,
  to: Email,
  kind: z.enum(["activate", "reset"]),
  subject: z.string(),
  text: z.string(),
  /** Посилання з листа — те, що власник відкриває вручну з outbox/логу. */
  link: z.string().url(),
});
export type OutboxMail = z.infer<typeof OutboxMail>;

export const CreditPrices = z.object({
  video: z.number().int().min(0),
  revision: z.number().int().min(0),
  extraFormat: z.number().int().min(0),
});
export type CreditPrices = z.infer<typeof CreditPrices>;

/** `config/credits.json`: усі значення — плейсхолдери до розрахунку. */
export const CreditsConfig = z.object({
  checkedAt: z.string(),
  currency: z.literal("credits"),
  creditsPerUsd: z.number().positive(),
  prices: CreditPrices,
  packages: z
    .array(
      z.object({
        id: z.string(),
        credits: z.number().int().positive(),
        priceUsd: z.number().min(0),
        label: z.string(),
      }),
    )
    .min(1),
  custom: z.object({ min: z.number().int().positive(), max: z.number().int().positive() }),
  signupBonus: z.number().int().min(0),
});
export type CreditsConfig = z.infer<typeof CreditsConfig>;
