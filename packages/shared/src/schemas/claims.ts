import { z } from "zod";
import { IsoDate } from "./common.ts";

export const ClaimKind = z.enum(["price", "percent", "number", "date", "superlative", "guarantee"]);
export type ClaimKind = z.infer<typeof ClaimKind>;

/** Твердження, знайдене `verifyClaims` у тексті сцени. */
export const Claim = z.object({
  sceneId: z.string(),
  field: z.enum(["headline", "sub", "item"]),
  /** id з `Scene.items`, коли `field === "item"`. */
  itemId: z.string().nullable().default(null),
  /** Фрагмент тексту, який перевірявся («-20%», «№1», «від 499 грн»). */
  text: z.string(),
  kind: ClaimKind,
  /** Факт, що його підтверджує; null — не підтверджено. */
  factId: z.string().nullable(),
  /** Підтверджено контактами/графіком (телефон, години). */
  matchedContact: z.boolean(),
  /** Число чи обіцянка знайдені дослівно в тексті сайту (`brandkit/site-text.txt`). */
  matchedSite: z.boolean().default(false),
});
export type Claim = z.infer<typeof Claim>;

/** `rev/<n>/claims.json`. */
export const ClaimsReport = z.object({
  checkedAt: IsoDate,
  brandkitVersion: z.number().int(),
  verified: z.array(Claim),
  unverified: z.array(Claim),
});
export type ClaimsReport = z.infer<typeof ClaimsReport>;
