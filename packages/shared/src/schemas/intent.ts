import { z } from "zod";
import { FactKind } from "./brandkit.ts";
import { Format, Language } from "./common.ts";

export const IntentKind = z.enum(["approve", "answer", "edit", "question", "restart", "other"]);
export type IntentKind = z.infer<typeof IntentKind>;

/**
 * ChatIntent — LLM-схема `chat-intent` (Sonnet, effort low).
 * `approve` повертається лише коли в повідомленні немає жодної правки;
 * оркестратор додатково перевіряє це кодом (змішане повідомлення ≠ затвердження).
 */
export const ChatIntent = z.object({
  kind: IntentKind,
  /** Відповіді на питання чекпоінта 1 (questionId з BrandKit.questions). */
  answers: z.array(z.object({ questionId: z.string(), answer: z.string() })),
  formats: z.array(Format).nullable(),
  language: Language.nullable(),
  /** Інструкція для brandkit-patch (кольори, назва, тон…), або null. */
  brandEdits: z.string().nullable(),
  /** Правки сценарію/сцен своїми словами, або null. */
  edits: z.string().nullable(),
  /** Факти, які клієнт сам повідомив (ціни, знижки, гарантії…). */
  facts: z.array(z.object({ kind: FactKind, text: z.string() })),
  durationSeconds: z.number().int().min(15).max(30).nullable(),
  /** Питання клієнта, на яке треба відповісти через chat-reply. */
  question: z.string().nullable(),
});
export type ChatIntent = z.infer<typeof ChatIntent>;

/**
 * Чи є в розборі хоч одна правка змісту — тоді це не затвердження.
 * Відповіді на питання, вибір форматів і мови правками не вважаються.
 */
export function intentHasEdits(intent: ChatIntent): boolean {
  return (
    intent.brandEdits !== null ||
    intent.edits !== null ||
    intent.facts.length > 0 ||
    intent.durationSeconds !== null
  );
}

/** Чи містить розбір відповіді/вибір (формати, мова, відповіді на питання). */
export function intentHasAnswers(intent: ChatIntent): boolean {
  return intent.answers.length > 0 || intent.formats !== null || intent.language !== null;
}
