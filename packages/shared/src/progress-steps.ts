import type { CostStage } from "./schemas/project.ts";

/**
 * Підкроки busy-стадій для чекліста прогресу. Дзеркало для фронту — `STAGE_STEPS` у
 * `apps/api/public/static/js/contracts.js` (паритет — `test/parity-contracts.test.ts`).
 */
export interface StageStep {
  id: string;
  /** Підпис у чеклісті (укр.). */
  label: string;
  /** Події progress з цими stage без `step` падають у цей крок (сумісність). */
  stages: CostStage[];
  /** Показується лише якщо почався (fix, review-fix). */
  optional?: boolean;
  /** Гілка для directing: дві колонки. */
  branch?: "scenes" | "music";
}

/** Кроки busy-статусів; `revising` окремого списку не має — UI показує кроки стадій, що реально запустились. */
export const STAGE_STEPS: Record<
  "crawling" | "brandkit" | "scripting" | "directing" | "rendering",
  StageStep[]
> = {
  crawling: [
    { id: "open", label: "Відкриваю сайт", stages: ["crawl"] },
    { id: "pages", label: "Сканую сторінки", stages: [] },
    { id: "assets", label: "Завантажую фото й шрифти", stages: [] },
    { id: "photos", label: "Обробляю фото", stages: ["ingest"] },
  ],
  brandkit: [
    { id: "read", label: "Читаю тексти сайту", stages: ["brandkit"] },
    { id: "look", label: "Роздивляюсь фото й скриншоти", stages: [] },
    { id: "compose", label: "Складаю бренд-кіт", stages: [] },
    { id: "verify", label: "Звіряю факти, кольори й шрифти", stages: [] },
  ],
  scripting: [
    { id: "brief", label: "Читаю бренд-кіт і сайт", stages: ["storyboard"] },
    { id: "write", label: "Пишу концепт і сцени", stages: [] },
    { id: "fit", label: "Підганяю тексти під екран", stages: [] },
    { id: "claims", label: "Звіряю цифри з сайтом", stages: [] },
  ],
  directing: [
    { id: "code", label: "Пишу анімацію сцен", stages: ["codegen", "author"], branch: "scenes" },
    { id: "check", label: "Перевіряю код сцен", stages: ["check"], branch: "scenes" },
    { id: "fix", label: "Виправляю сцени", stages: ["fix"], branch: "scenes", optional: true },
    { id: "stills", label: "Знімаю кадри", stages: [], branch: "scenes" },
    { id: "qa", label: "Перевіряю кадри", stages: ["qa"], branch: "scenes" },
    { id: "music", label: "Пишу музику", stages: ["audio"], branch: "music" },
    { id: "sfx", label: "Розставляю звук", stages: ["sfx"] },
    { id: "review", label: "Рецензент дивиться ролик", stages: ["review"] },
    { id: "review-fix", label: "Правлю за рецензією", stages: [], optional: true },
  ],
  rendering: [
    // Рядок на кожен формат малює UI з done/total.
    { id: "render", label: "Рендер", stages: ["render"] },
  ],
};
