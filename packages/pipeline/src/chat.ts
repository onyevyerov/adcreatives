import {
  type BrandKitFile,
  ChatIntent,
  checkpointOf,
  type Llm,
  type ProjectState,
  type Storyboard,
} from "@adc/shared";

/** Назви промптів оркестратора (`prompts/<name>.md`). */
export const CHAT_INTENT_PROMPT = "chat-intent";
export const CHAT_REPLY_PROMPT = "chat-reply";

/** Де саме прийшла репліка — так її розуміє chat-intent. */
export type ChatStep = "brand" | "script" | "storyboard" | "delivered" | "failed" | "other";

export function chatStepOf(project: ProjectState): ChatStep {
  const cp = checkpointOf(project.status);
  if (cp) return cp;
  if (project.status === "delivered" || project.status === "failed") return project.status;
  return "other";
}

export interface IntentContext {
  brand: BrandKitFile | null;
  /** Повідомлення, відкладене під час роботи (клієнт ще не бачив результату кроку). */
  deferred: boolean;
}

export function chatIntentVars(project: ProjectState, text: string, ctx: IntentContext) {
  const brand = ctx.brand;
  return {
    step: chatStepOf(project),
    deferred: ctx.deferred ? "так" : "ні",
    formats: project.formats,
    language: project.language ?? "не обрано",
    languageVersions: brand?.languageVersions ?? [],
    questions: (brand?.questions ?? []).map((q) => ({
      id: q.id,
      text: q.text,
      default: q.default,
      options: q.options,
    })),
    answers: project.answers,
    message: text,
  };
}

/** Розбір репліки клієнта (chat-intent, structured). Помилку LLM обробляє драйвер. */
export async function parseIntent(
  llm: Llm,
  project: ProjectState,
  text: string,
  ctx: IntentContext,
): Promise<{ intent: ChatIntent; usd: number }> {
  const res = await llm.structured(CHAT_INTENT_PROMPT, chatIntentVars(project, text, ctx), ChatIntent);
  return { intent: res.data, usd: res.usd };
}

export interface ReplyContext {
  brand: BrandKitFile | null;
  storyboard: Storyboard | null;
}

export function chatReplyVars(project: ProjectState, question: string, ctx: ReplyContext) {
  const b = ctx.brand;
  const sb = ctx.storyboard;
  const context = {
    step: chatStepOf(project),
    formats: project.formats,
    language: project.language,
    brand: b
      ? {
          name: b.identity.name,
          category: b.identity.category,
          offerings: b.offerings.map((o) => o.name),
          cta: b.cta.text,
          facts: b.facts.map((f) => ({ text: f.text, source: f.source })),
        }
      : null,
    script: sb
      ? {
          concept: sb.concept,
          scenes: sb.scenes.map((s) => ({
            id: s.id,
            seconds: Math.round((s.durationFrames / sb.fps) * 10) / 10,
            headline: s.text.headline,
            sub: s.text.sub,
            items: s.items.map((i) => i.text),
          })),
          music: sb.musicBrief.genre,
        }
      : null,
  };
  return { context, question };
}

export async function replyToQuestion(
  llm: Llm,
  project: ProjectState,
  question: string,
  ctx: ReplyContext,
): Promise<{ text: string; usd: number }> {
  const res = await llm.text(CHAT_REPLY_PROMPT, chatReplyVars(project, question, ctx));
  return { text: res.text.trim(), usd: res.usd };
}
