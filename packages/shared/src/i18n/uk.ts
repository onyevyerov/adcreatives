/**
 * Системні репліки чату українською. Перелік ключів Кроку 0 збережено; B7 (єдиний власник
 * файлу після Кроку 0) наповнює тексти і може додавати нові ключі в кінець переліку.
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
  // ── додано B7 ──
  "answersSaved",
  "intentFailed",
  "replyFailed",
  "logoLocked",
  "failedHint",
  "deferredApproveIgnored",
  "directingStarted",
  "renderStarted",
  "templateScenesNote",
  "deliveredHint",
  "manualAccepted",
  "scriptScenesHeader",
  "photosPending",
] as const;
export type I18nKey = (typeof I18N_KEYS)[number];

export const uk: Record<I18nKey, string> = {
  welcome: "Вставте адресу сайту бізнесу і, за бажання, додайте фото.",
  needSiteOrManual:
    "Соцмережі й маркетплейси поки не підтримуються. Дайте адресу сайту або напишіть кілька речень про бізнес і додайте фото.",
  unsafeUrl: "Не можу відкрити цю адресу: {reason}",
  manualModePrompt:
    "Сайт не відкривається. Напишіть кілька речень про бізнес (що продаєте, ціни, адреса, телефон) і додайте фото — зроблю відео без сайту.",
  crawlProgress: "Сканую сайт… {done}/{total} сторінок",
  crawlPartial: "Частину сторінок сайту не вдалося відкрити — працюю з тим, що є.",
  crawlFailed: "Не вдалося завантажити жодної сторінки сайту.",
  brandkitProgress: "Збираю бренд-кіт…",
  brandCheckpointIntro:
    "Ось що я зрозумів про ваш бренд. Перевірте, відповідайте на питання або напишіть, що змінити. Якщо все гаразд — натисніть «Затвердити».",
  askFormats:
    "У яких форматах робимо відео: 9:16 (вертикальне), 1:1 (квадрат), 16:9 (горизонтальне)? Можна кілька. Якщо не скажете — зроблю 9:16.",
  askLanguage: "На сайті є кілька мовних версій. Якою мовою робимо відео — українською чи англійською?",
  needMorePhotos: "Придатних фото замало — додайте, будь ласка, ще хоча б {count}.",
  photosAdded: "Фото додано: {count}.",
  logoChanged: "Лого змінено.",
  brandkitUpdated: "Бренд-кіт оновлено: {summary}",
  scriptProgress: "Пишу сценарій…",
  scriptCheckpointIntro:
    "Сценарій готовий. Перевірте тексти сцен. Якщо все гаразд — натисніть «Затвердити», або напишіть, що змінити.",
  unverifiedClaimsNote:
    "Твердження з позначкою ⚠ я не знайшов на сайті. Натиснувши «Затвердити», ви підтверджуєте, що вони правдиві.",
  directingProgress: "Генерую сцени… {done}/{total}",
  audioProgress: "Пишу музику…",
  storyboardCheckpointIntro:
    "Розкадровка готова: кадри кожної сцени і музика. Якщо все гаразд — натисніть «Затвердити», і я зроблю відео. Або напишіть, що змінити.",
  qaWarnings: "Автоматична перевірка має зауважень: {count}. Подивіться кадри — рішення за вами.",
  renderProgress: "Рендерю {format}… {percent}%",
  delivered: "Готово! Відео нижче.",
  costLine: "Витрачено: {usd} $",
  costBreakdown: "Витрати за етапами:",
  busy: "Працюю над попереднім кроком, врахую ваше повідомлення на наступному погодженні.",
  pendingApplied: "Враховую повідомлення, яке ви надіслали, поки я працював.",
  approveIgnored: "Цей крок уже затверджено.",
  mixedMessageNotApproval:
    "Бачу у повідомленні правки — спершу внесу їх, а затвердити можна буде на наступному кроці.",
  revisionStarted: "Вношу правки…",
  restartConfirm:
    "Почати все спочатку, зі сканування сайту? Поточний результат лишиться в історії. Натисніть кнопку, щоб підтвердити.",
  restarted: "Починаю заново.",
  stageFailed: "Щось пішло не так на етапі «{stage}»: {reason}",
  retryStarted: "Пробую ще раз…",
  answersSaved: "Записав: {what}.",
  intentFailed: "Не вдалося розібрати повідомлення. Напишіть, будь ласка, ще раз або скористайтесь кнопками.",
  replyFailed: "Не вдалося відповісти на питання — спробуйте ще раз трохи згодом.",
  logoLocked:
    "Лого обирається на кроці бренд-кіта. Щоб змінити його зараз, напишіть про це текстом у правках.",
  failedHint:
    "Повідомлення збережено — врахую його на наступному погодженні. Щоб продовжити, натисніть «Спробувати ще раз».",
  deferredApproveIgnored:
    "Спершу перегляньте результат цього кроку, а тоді натисніть «Затвердити» або напишіть правки.",
  directingStarted: "Генерую сцени і музику…",
  renderStarted: "Рендерю відео ({formats})…",
  templateScenesNote:
    "Сцени {scenes} не вдалося зібрати автоматично, тому вони зроблені за простим шаблоном.",
  deliveredHint: "Якщо хочете щось змінити — просто напишіть правку.",
  manualAccepted: "Дякую! Роблю відео за вашим описом.",
  scriptScenesHeader: "Сцени ({seconds} с):",
  photosPending: "Фото отримав — додам їх, щойно закінчу сканувати сайт.",
};

/** Підставляє {name} у шаблон. */
export function t(
  key: I18nKey,
  vars: Record<string, string | number> = {},
  dict: Record<I18nKey, string> = uk,
): string {
  return dict[key].replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));
}
