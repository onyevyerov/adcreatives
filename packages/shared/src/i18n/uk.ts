/**
 * Системні репліки чату українською. Перелік ключів заморожено в Кроці 0;
 * тексти — чернетки, їх наповнює і веде B7 (єдиний власник файлу після Кроку 0).
 * Змінні в текстах: {name}.
 */
export const I18N_KEYS = [
  "welcome",
  "needSiteOrManual",
  "unsafeUrl",
  "manualModePrompt",
  "crawlProgress",
  "crawlPartial",
  "crawlFailed",
  "brandkitProgress",
  "brandCheckpointIntro",
  "askFormats",
  "askLanguage",
  "needMorePhotos",
  "photosAdded",
  "logoChanged",
  "brandkitUpdated",
  "scriptProgress",
  "scriptCheckpointIntro",
  "unverifiedClaimsNote",
  "directingProgress",
  "audioProgress",
  "storyboardCheckpointIntro",
  "qaWarnings",
  "renderProgress",
  "delivered",
  "costLine",
  "costBreakdown",
  "busy",
  "pendingApplied",
  "approveIgnored",
  "mixedMessageNotApproval",
  "revisionStarted",
  "restartConfirm",
  "restarted",
  "stageFailed",
  "retryStarted",
] as const;
export type I18nKey = (typeof I18N_KEYS)[number];

export const uk: Record<I18nKey, string> = {
  welcome: "Вставте адресу сайту бізнесу і, за бажання, додайте фото.",
  needSiteOrManual:
    "Соцмережі й маркетплейси поки не підтримуються. Дайте адресу сайту або напишіть текст про бізнес і додайте фото.",
  unsafeUrl: "Не можу відкрити цю адресу: {reason}",
  manualModePrompt:
    "Сайт недоступний. Напишіть кілька речень про бізнес (послуги, ціни, контакти) і додайте фото.",
  crawlProgress: "Сканую сайт… {done}/{total} сторінок",
  crawlPartial: "Частину сайту не вдалося відкрити — працюю з тим, що є.",
  crawlFailed: "Не вдалося завантажити жодної сторінки сайту.",
  brandkitProgress: "Збираю бренд-кіт…",
  brandCheckpointIntro: "Ось що я зрозумів про бренд. Перевірте і затвердьте або напишіть правки.",
  askFormats: "У яких форматах робимо відео? За замовчуванням — 9:16.",
  askLanguage: "На сайті є кілька мовних версій. Якою мовою робимо відео?",
  needMorePhotos: "Придатних фото замало — додайте, будь ласка, ще хоча б {count}.",
  photosAdded: "Фото додано: {count}.",
  logoChanged: "Лого змінено.",
  brandkitUpdated: "Бренд-кіт оновлено: {summary}",
  scriptProgress: "Пишу сценарій…",
  scriptCheckpointIntro: "Тексти сцен готові. Затвердьте або напишіть правки.",
  unverifiedClaimsNote:
    "Позначені твердження не знайдено на сайті. «Затвердити» означає, що ви їх підтверджуєте.",
  directingProgress: "Генерую сцени… {done}/{total}",
  audioProgress: "Пишу музику…",
  storyboardCheckpointIntro:
    "Розкадровка готова: кадри кожної сцени і музика. Затвердьте або напишіть правки.",
  qaWarnings: "Зауваження перевірки: {count}. Рішення за вами.",
  renderProgress: "Рендерю {format}… {percent}%",
  delivered: "Готово! Відео нижче.",
  costLine: "Витрачено: {usd} $",
  costBreakdown: "Витрати за етапами:",
  busy: "Працюю над попереднім кроком, врахую на наступному погодженні.",
  pendingApplied: "Враховую ваше попереднє повідомлення.",
  approveIgnored: "Цей крок уже затверджено.",
  mixedMessageNotApproval: "Бачу правки — спершу внесу їх, затвердження буде на наступному кроці.",
  revisionStarted: "Вношу правки…",
  restartConfirm: "Почати все спочатку? Поточний прогрес лишиться в історії.",
  restarted: "Починаю заново.",
  stageFailed: "Щось пішло не так на етапі «{stage}»: {reason}",
  retryStarted: "Пробую ще раз…",
};

/** Підставляє {name} у шаблон. */
export function t(
  key: I18nKey,
  vars: Record<string, string | number> = {},
  dict: Record<I18nKey, string> = uk,
): string {
  return dict[key].replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));
}
