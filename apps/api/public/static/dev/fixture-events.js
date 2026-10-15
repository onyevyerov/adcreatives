// @ts-check
/**
 * Фікстура подій чату для розробки без бекенду: кав'ярня «Зерно» (дані — копія
 * `packages/shared/src/fixtures.ts`; збіг перевіряє test/ui/contracts.test.ts).
 *
 * Сегменти програються послідовно (mock у data/mock.js, B2):
 *   щасливий шлях — toBrand → brandAnswers → toScript → toStoryboard → toDelivered;
 *   помилка        — toBrand → brandAnswers → toScript → failed → retry → toDelivered;
 *   правка         — … → toDelivered → revisionAfterDelivery → revisionDelivered.
 * ID подій (= SSE id, «ms-0») зростають у порядку оголошення сегментів, тож будь-який із
 * шляхів вище монотонний і дедуплікується за id.
 */

/** @typedef {import("../js/contracts.js").ChatEvent} ChatEvent */
/** @typedef {import("../js/contracts.js").BrandCheckpointPayload} BrandCheckpointPayload */
/** @typedef {import("../js/contracts.js").ScriptCheckpointPayload} ScriptCheckpointPayload */
/** @typedef {import("../js/contracts.js").StoryboardCheckpointPayload} StoryboardCheckpointPayload */
/** @typedef {{ id: string, event: ChatEvent }} StoredEvent */
/** @typedef {import("@adc/shared/schemas").BrandKitFile} BrandKitFile */
/** @typedef {import("@adc/shared/schemas").Storyboard} Storyboard */

const AT = "2026-10-06T10:00:00.000Z";

export const PROJECT_ID = "p1";
export const SITE_URL = "https://zerno.example.com/";
export const SITE_HOST = "zerno.example.com";

const M = "/static/dev/media";
export const MEDIA = {
  logo: `${M}/logo-a02.svg`,
  photo: `${M}/photo-a01.svg`,
  /** @param {string} sceneId @param {"a" | "b"} variant */
  still: (sceneId, variant) => `${M}/still-${sceneId}-${variant}.svg`,
  sheetSquare: `${M}/sheet-square.svg`,
  poster: `${M}/poster.svg`,
  videoVertical: `${M}/sample.mp4`,
  videoSquare: `${M}/sample-1x1.mp4`,
  /** Аудіодоріжка того самого ролика — `<audio>` грає mp4. */
  music: `${M}/sample.mp4`,
};

// ─────────────────────────── дані «Зерна» ───────────────────────────

/** = fixtureBrandKitFile. @type {BrandKitFile} */
export const brandkitFile = {
  identity: {
    name: "Зерно",
    tagline: "Кава, яку обсмажуємо самі",
    category: "кав'ярня",
    language: "uk",
    city: "Львів",
    serviceArea: null,
  },
  languageVersions: [
    { lang: "uk", url: "https://zerno.example.com/uk/" },
    { lang: "en", url: "https://zerno.example.com/en/" },
  ],
  palette: {
    primary: "#6B3E26",
    secondary: "#C89F7A",
    accent: "#E85D2A",
    background: "#FFF8F0",
    surface: "#F3E6D8",
    textOnDark: "#FFFFFF",
    textOnLight: "#1E1410",
    danger: null,
    warning: null,
    success: null,
  },
  typography: {
    heading: { family: "Montserrat", weights: [700, 800], origin: "site", files: [] },
    body: { family: "Inter", weights: [400, 600], origin: "site", files: [] },
    mono: null,
    detected: ["Montserrat", "Inter"],
  },
  logo: { assetId: "a02", type: "svg", needsBackground: false, textFallback: "Зерно" },
  logoCandidates: ["a02"],
  voice: {
    tone: ["теплий", "дружній"],
    formality: "casual",
    description: "Говоримо як бариста з постійним гостем.",
  },
  audience: "Мешканці й гості центру Львова, які люблять спешелті каву",
  offerings: [
    { name: "Капучино", description: "Спешелті еспресо з молоком", price: "75 грн" },
    { name: "Сніданки", description: "До 12:00", price: null },
  ],
  usps: ["Обсмажуємо зерно щотижня"],
  substance: { steps: [], checks: [], exampleIssues: [], planRows: [], products: [], comparisons: [] },
  socialProof: { rating: 4.8, reviewsCount: 320, quotes: [] },
  location: { address: "Львів, вул. Руська, 1", city: "Львів", hours: "щодня 8:00–21:00" },
  contacts: {
    phones: ["+380 67 123 45 67"],
    emails: ["hello@zerno.example.com"],
    website: "https://zerno.example.com/",
    socials: ["https://instagram.com/zerno"],
  },
  cta: { text: "Забронюйте столик", target: "https://zerno.example.com/" },
  facts: [
    {
      id: "f1",
      kind: "price",
      text: "Капучино — 75 грн",
      source: "site",
      sourceUrl: "https://zerno.example.com/uk/",
      quote: "Капучино — 75 грн.",
    },
    {
      id: "f2",
      kind: "discount",
      text: "Знижка 10% на каву з собою до 10:00",
      source: "site",
      sourceUrl: "https://zerno.example.com/uk/",
      quote: "Знижка 10% на каву з собою до 10:00.",
    },
  ],
  visualStyle: {
    mood: ["затишний", "крафтовий"],
    motionPersonality: "calm",
    density: "balanced",
    shapes: "rounded",
    musicHints: ["lo-fi", "acoustic"],
  },
  assets: [
    {
      assetId: "a01",
      role: "hero",
      quality: 4,
      cropFocus: { x: 0.5, y: 0.4 },
      hasBakedText: false,
      description: "Бариста з капучино",
    },
  ],
  gaps: [{ kind: "few_photos", note: "Лише одне придатне фото" }],
  confidence: 0.8,
  questions: [
    {
      id: "q1",
      topic: "goal",
      text: "Яка головна мета ролика?",
      default: "Привести нових гостей",
      options: ["Привести нових гостей", "Анонс сніданків"],
    },
  ],
  version: 1,
  createdAt: AT,
  origin: "llm",
  fixes: [],
};

/** = fixtureStoryboard. @type {Storyboard} */
export const storyboard = {
  concept: "Ранок у «Зерні»: від зерна до чашки",
  hook: "Кава, яку обсмажуємо самі",
  fps: 30,
  scenes: [
    {
      id: "s1",
      purpose: "hook",
      durationFrames: 150,
      transitionFrames: 0,
      text: { headline: "Кава, яку обсмажуємо самі", sub: null, emphasis: ["самі"] },
      items: [],
      events: [],
      factIds: [],
      assetIds: ["a01"],
      layoutIntent: "hero_image",
      motionIntent: "повільний наїзд на фото, заголовок по словах",
      transitionIn: "cut",
      sfxCue: "whoosh",
      musicEnergy: 0.4,
    },
    {
      id: "s2",
      purpose: "offer",
      durationFrames: 165,
      transitionFrames: 15,
      text: {
        headline: "Капучино — 75 грн",
        sub: "-10% на каву з собою до 10:00",
        emphasis: ["75 грн", "-10%"],
      },
      items: [
        { id: "t1", role: "label", text: "Спешелті еспресо з молоком", group: null, factIds: [] },
        { id: "t2", role: "number", text: "75 грн", group: "row:ціна", factIds: ["f1"] },
        { id: "t3", role: "badge", text: "-10%", group: "row:ціна", factIds: ["f2"] },
      ],
      events: [
        {
          id: "price-hit",
          at: 30,
          what: "The price lands with a bump.",
          sound: { cue: "impact", accent: "hard" },
          textIds: ["t2"],
        },
        {
          id: "badge-in",
          at: 60,
          what: "The discount badge fades in next to the price.",
          sound: null,
          textIds: ["t3"],
        },
      ],
      factIds: ["f1", "f2"],
      assetIds: [],
      layoutIntent: "typographic",
      motionIntent: "ціна виїжджає знизу, акцент кольором",
      transitionIn: "slide",
      sfxCue: "pop",
      musicEnergy: 0.6,
    },
    {
      id: "s3",
      purpose: "cta",
      durationFrames: 165,
      transitionFrames: 15,
      text: { headline: "Забронюйте столик", sub: "Львів, вул. Руська, 1", emphasis: [] },
      items: [],
      events: [],
      factIds: [],
      assetIds: [],
      layoutIntent: "logo_lockup",
      motionIntent: "лого з'являється з м'якою пружиною, кнопка пульсує",
      transitionIn: "fade",
      sfxCue: "shimmer",
      musicEnergy: 0.7,
    },
  ],
  musicBrief: {
    genre: "lo-fi hip hop",
    mood: ["теплий", "ранковий"],
    bpm: 85,
    instrumentation: ["rhodes", "soft drums", "vinyl crackle"],
    structure: [
      { label: "intro", sceneIds: ["s1"], energy: 0.4, mix: "full" },
      { label: "main", sceneIds: ["s2", "s3"], energy: 0.65, mix: "breakdown" },
    ],
  },
  copyRules: {
    maxCharsPerLine: { vertical: 18, square: 22, landscape: 32 },
    maxLines: { headline: 3, sub: 2 },
  },
  throughline: null,
};

// ─────────────────────────── payload-и чекпоінтів ───────────────────────────

/** @type {BrandCheckpointPayload} */
export const brandPayload = {
  checkpoint: "brand",
  brandkit: brandkitFile,
  logoCandidates: [{ assetId: "a02", url: MEDIA.logo }],
  photos: [{ assetId: "a01", url: MEDIA.photo }],
  formats: ["vertical"],
  languageOptions: [
    { lang: "uk", url: "https://zerno.example.com/uk/" },
    { lang: "en", url: "https://zerno.example.com/en/" },
  ],
  needMorePhotos: true,
};

/** @type {ScriptCheckpointPayload} */
export const scriptPayload = {
  checkpoint: "script",
  storyboard,
  claims: {
    checkedAt: "2026-10-06T10:01:30.000Z",
    brandkitVersion: 1,
    verified: [
      {
        sceneId: "s2",
        field: "headline",
        itemId: null,
        text: "75 грн",
        kind: "price",
        factId: "f1",
        matchedContact: false,
        matchedSite: false,
      },
      {
        sceneId: "s2",
        field: "sub",
        itemId: null,
        text: "-10%",
        kind: "percent",
        factId: "f2",
        matchedContact: false,
        matchedSite: false,
      },
    ],
    unverified: [],
  },
  thumbnails: [{ assetId: "a01", url: MEDIA.photo }],
  musicBrief: storyboard.musicBrief,
  durationSeconds: 15,
};

/**
 * Варіант чекпоінта 2 з непідтвердженим твердженням (X3): заголовок s1 — «Найкраща кава №1 у Львові».
 * @type {ScriptCheckpointPayload}
 */
export const scriptPayloadUnverified = {
  ...scriptPayload,
  storyboard: {
    ...storyboard,
    scenes: storyboard.scenes.map((s) =>
      s.id === "s1"
        ? { ...s, text: { ...s.text, headline: "Найкраща кава №1 у Львові", emphasis: ["№1"] } }
        : s,
    ),
  },
  claims: {
    ...scriptPayload.claims,
    unverified: [
      {
        sceneId: "s1",
        field: "headline",
        itemId: null,
        text: "№1",
        kind: "superlative",
        factId: null,
        matchedContact: false,
        matchedSite: false,
      },
    ],
  },
};

/** @type {StoryboardCheckpointPayload} */
export const storyboardPayload = {
  checkpoint: "storyboard",
  primaryFormat: "vertical",
  stills: ["s1", "s2", "s3"].flatMap((sceneId) =>
    /** @type {const} */ (["a", "b"]).map((variant) => ({
      sceneId,
      variant,
      url: MEDIA.still(sceneId, variant),
    })),
  ),
  sheets: [{ format: "square", url: MEDIA.sheetSquare }],
  warnings: [
    {
      sceneId: "s2",
      format: "vertical",
      severity: "minor",
      kind: "outside_safe_area",
      description: "Плашка зі знижкою на 12 px ближче до краю, ніж safe-зона.",
      fix: "Зсунути плашку на 12 px всередину кадру.",
    },
    {
      sceneId: "s3",
      format: "square",
      severity: "major",
      kind: "clipped_text",
      description: "Адреса обрізана справа.",
      fix: "Зменшити кегль адреси або перенести на два рядки.",
    },
  ],
  templateScenes: [],
  music: { url: MEDIA.music },
  changedScenes: null,
};

/** Ревізія 2 після правки на «Готово»: змінено лише s1. @type {StoryboardCheckpointPayload} */
export const storyboardPayloadRev2 = {
  ...storyboardPayload,
  stills: storyboardPayload.stills.filter((s) => s.sceneId === "s1"),
  warnings: [],
  changedScenes: ["s1"],
};

// ─────────────────────────── події ───────────────────────────

/**
 * Подія без `at`; `dt` — секунд від попередньої події (за замовчуванням 0.4, мінімум 1 мс).
 * @typedef {import("@adc/shared/schemas").ChatEventInput & { dt?: number }} Draft
 */

let clock = Date.parse(AT);

/**
 * Ставить `at` і ID стріму. Викликається в порядку оголошення — так ID монотонні.
 * @param {Draft[]} drafts
 * @returns {StoredEvent[]}
 */
function stamp(drafts) {
  return drafts.map(({ dt = 0.4, ...rest }) => {
    clock += Math.max(1, Math.round(dt * 1000));
    const event = /** @type {ChatEvent} */ ({ ...rest, at: new Date(clock).toISOString() });
    return { id: `${clock}-0`, event };
  });
}

/** @param {import("../js/contracts.js").ProjectStatus} status @param {import("../js/contracts.js").ProjectStatus | null} prev @param {number} [rev] @param {number} [dt] @returns {Draft} */
const state = (status, prev, rev = 1, dt = 0.4) => ({ type: "state", status, prev, rev, dt });
/** @param {import("@adc/shared/schemas").CostStage} stage @param {string} label @param {number | null} [done] @param {number | null} [total] @param {number} [dt] @returns {Draft} */
const progress = (stage, label, done = null, total = null, dt = 0.4) => ({
  type: "progress",
  stage,
  label,
  done,
  total,
  dt,
});
/** @param {string} text @param {import("../js/contracts.js").Button[]} [buttons] @param {number} [dt] @returns {Draft} */
const say = (text, buttons, dt = 0.4) => ({
  type: "message",
  role: "assistant",
  text,
  ...(buttons ? { buttons } : {}),
  dt,
});
/** @param {string} text @param {number} [dt] @returns {Draft} */
const user = (text, dt = 3) => ({ type: "message", role: "user", text, dt });
/** @param {import("@adc/shared/schemas").CostStage} stage @param {number} stageUsd @param {number} totalUsd @returns {Draft} */
const cost = (stage, stageUsd, totalUsd) => ({ type: "cost", stage, stageUsd, totalUsd, dt: 0.1 });

const BREAKDOWN = [
  { stage: "crawl", usd: 0.02 },
  { stage: "brandkit", usd: 0.31 },
  { stage: "storyboard", usd: 0.46 },
  { stage: "codegen", usd: 1.08 },
  { stage: "qa", usd: 0.12 },
  { stage: "audio", usd: 0.32 },
];
const BREAKDOWN_REV2 = [
  ...BREAKDOWN.map((b) =>
    b.stage === "codegen" ? { ...b, usd: 1.29 } : b.stage === "qa" ? { ...b, usd: 0.15 } : b,
  ),
  { stage: "revise", usd: 0.04 },
];

const BRAND_TEXT = [
  "Ось що я зрозумів про ваш бренд. Перевірте, відповідайте на питання або напишіть, що змінити. Якщо все гаразд — натисніть «Затвердити».",
  "",
  "**Зерно** — кав'ярня, Львів. «Кава, яку обсмажуємо самі».",
  "Палітра: #6B3E26, #C89F7A, #E85D2A. Шрифти: Montserrat / Inter.",
  "Факти: Капучино — 75 грн; Знижка 10% на каву з собою до 10:00.",
  "",
  "У яких форматах робимо відео: 9:16 (вертикальне), 1:1 (квадрат), 16:9 (горизонтальне)? Можна кілька. Якщо не скажете — зроблю 9:16. Зараз обрано: 9:16.",
  "На сайті є кілька мовних версій. Якою мовою робимо відео — українською чи англійською?",
].join("\n");

const SCRIPT_TEXT = [
  "Сценарій готовий. Перевірте тексти сцен. Якщо все гаразд — натисніть «Затвердити», або напишіть, що змінити.",
  "",
  "**Ранок у «Зерні»: від зерна до чашки**",
  "",
  "Сцени (15 с):",
  "1. 0–5 с — Кава, яку обсмажуємо самі",
  "2. 4,5–10 с — Капучино — 75 грн / -10% на каву з собою до 10:00",
  "3. 9,5–15 с — Забронюйте столик / Львів, вул. Руська, 1",
  "",
  "**Музика:** lo-fi hip hop, теплий, ранковий, ~85 BPM",
].join("\n");

const STORYBOARD_TEXT = [
  "Розкадровка готова: кадри кожної сцени і музика. Якщо все гаразд — натисніть «Затвердити», і я зроблю відео. Або напишіть, що змінити.",
  "",
  "Автоматична перевірка має зауважень: 2. Подивіться кадри — рішення за вами.",
  "- s2 (9:16): Плашка зі знижкою на 12 px ближче до краю, ніж safe-зона.",
  "- s3 (1:1): Адреса обрізана справа.",
].join("\n");

/** @param {number} total @param {{ stage: string, usd: number }[]} rows */
const deliveredText = (total, rows) =>
  [
    "Готово! Відео нижче.",
    "",
    `Витрачено: ${total.toFixed(2)} $`,
    "Витрати за етапами:",
    ...rows.map((b) => `- ${b.stage}: ${b.usd.toFixed(2)} $`),
    "",
    "Якщо хочете щось змінити — просто напишіть правку.",
  ].join("\n");

/** @returns {Draft[]} */
const renderBody = () => [
  progress("render", "Рендерю відео (9:16, 1:1)…"),
  ...[0, 25, 50, 75, 100].map((p) => progress("render", `Рендерю 9:16… ${p}%`, p, 100, p === 0 ? 1 : 3)),
  ...[0, 25, 50, 75, 100].map((p) => progress("render", `Рендерю 1:1… ${p}%`, p, 100, p === 0 ? 1 : 3)),
];

/** @param {number} rev @param {{ stage: string, usd: number }[]} rows @returns {Draft[]} */
const deliveryBody = (rev, rows) => {
  const total = Math.round(rows.reduce((a, b) => a + b.usd, 0) * 100) / 100;
  const q = rev > 1 ? `?rev=${rev}` : "";
  return [
    state("delivered", "rendering", rev, 1),
    {
      type: "artifact",
      rev,
      kind: "video",
      url: MEDIA.videoVertical + q,
      format: "vertical",
      sceneId: null,
      dt: 0.1,
    },
    {
      type: "artifact",
      rev,
      kind: "video",
      url: MEDIA.videoSquare + q,
      format: "square",
      sceneId: null,
      dt: 0.1,
    },
    {
      type: "artifact",
      rev,
      kind: "poster",
      url: MEDIA.poster + q,
      format: "vertical",
      sceneId: null,
      dt: 0.1,
    },
    say(deliveredText(total, rows)),
    { type: "cost", totalUsd: total, stage: null, stageUsd: 0, breakdown: rows, dt: 0.1 },
  ];
};

/** Гілки directing → чекпоінт 3 (спільні для щасливого шляху і повтору після помилки). @returns {Draft[]} */
const directingBody = () => [
  progress("codegen", "Генерую сцени і музику…"),
  progress("audio", "Пишу музику…", null, null, 0.6),
  progress("codegen", "Генерую сцени… 0/3", 0, 3, 2),
  progress("codegen", "Генерую сцени… 1/3", 1, 3, 12),
  progress("codegen", "Генерую сцени… 2/3", 2, 3, 10),
  progress("audio", "Музику записано", 1, 1, 6),
  cost("audio", 0.32, 1.11),
  progress("codegen", "Генерую сцени… 3/3", 3, 3, 9),
  cost("codegen", 1.08, 2.19),
  progress("check", "Перевіряю код сцен…", null, null, 1),
  progress("check", "Збираю відео-проєкт…", null, null, 6),
  ...[2, 4, 6].map((n) => progress("check", `Знімаю кадри сцен… ${n}/6`, n, 6, 6)),
  progress("qa", "Перевіряю кадри…", null, null, 2),
  cost("qa", 0.12, 2.31),
  state("awaiting_storyboard", "directing", 1, 12),
  say(STORYBOARD_TEXT, ["approve", "edit"]),
  { type: "checkpoint", rev: 1, checkpoint: "storyboard", payload: storyboardPayload, dt: 0.1 },
];

/** До чекпоінта 1: сканування → бренд-кіт → awaiting_brand. */
const toBrand = stamp([
  state("crawling", "intake", 1, 0.2),
  ...[1, 2, 3, 4, 5, 6, 7].map((n) =>
    progress("crawl", `Сканую сайт… ${n}/7 сторінок`, n, 7, n === 1 ? 0.6 : 0.55),
  ),
  cost("crawl", 0.02, 0.02),
  state("brandkit", "crawling", 1, 0.3),
  progress("brandkit", "Збираю бренд-кіт…"),
  cost("brandkit", 0.31, 0.33),
  state("awaiting_brand", "brandkit", 1, 4.5),
  say(BRAND_TEXT, ["approve", "edit"]),
  { type: "checkpoint", rev: 1, checkpoint: "brand", payload: brandPayload, dt: 0.1 },
]);

/** Рішення клієнта на чекпоінті 1 (повідомленнями, як у продакшні). */
const brandAnswers = stamp([
  user("Формати: 9:16, 1:1", 20),
  say("Записав: формати — 9:16, 1:1.", undefined, 1.5),
  user("Мова відео: uk", 8),
  say("Записав: мова відео — українська.", undefined, 1.5),
]);

/** Після «Затвердити» на чекпоінті 1 → чекпоінт 2. */
const toScript = stamp([
  state("scripting", "awaiting_brand", 1, 25),
  progress("storyboard", "Пишу сценарій…"),
  cost("storyboard", 0.46, 0.79),
  state("awaiting_script", "scripting", 1, 15),
  say(SCRIPT_TEXT, ["approve", "edit"]),
  { type: "checkpoint", rev: 1, checkpoint: "script", payload: scriptPayload, dt: 0.1 },
]);

/** Після «Затвердити» на чекпоінті 2: збій генерації сцен. */
const failed = stamp([
  state("directing", "awaiting_script", 1, 45),
  progress("codegen", "Генерую сцени і музику…"),
  progress("audio", "Пишу музику…", null, null, 0.6),
  progress("codegen", "Генерую сцени… 1/3", 1, 3, 14),
  state("failed", "directing", 1, 30),
  { type: "error", stage: "codegen", message: "модель не відповіла вчасно.", retryable: true, dt: 0 },
  say("Щось пішло не так на етапі «генерація сцен»: модель не відповіла вчасно.", ["retry"], 0),
]);

/** Після «Спробувати ще раз» → чекпоінт 3. */
const retry = stamp([
  say("Пробую ще раз…", undefined, 20),
  state("directing", "failed", 1, 0.2),
  ...directingBody(),
]);

/** Щасливий шлях: після «Затвердити» на чекпоінті 2 → чекпоінт 3. */
const toStoryboard = stamp([state("directing", "awaiting_script", 1, 45), ...directingBody()]);

/** Після «Затвердити й рендерити» → готово (ревізія 1, формати 9:16 і 1:1). */
const toDelivered = stamp([
  state("rendering", "awaiting_storyboard", 1, 40),
  ...renderBody(),
  ...deliveryBody(1, BREAKDOWN),
]);

/** Правка після видачі → ревізія 2 → чекпоінт 3 зі зміненою s1. */
const revisionAfterDelivery = stamp([
  user("Зроби заголовок першої сцени коротшим", 60),
  state("revising", "delivered", 2, 1),
  say("Вношу правки…"),
  progress("revise", "Вношу правки…"),
  cost("revise", 0.04, 2.35),
  state("directing", "revising", 2, 5),
  progress("codegen", "Генерую сцени… 0/1", 0, 1),
  progress("codegen", "Генерую сцени… 1/1", 1, 1, 12),
  cost("codegen", 0.21, 2.56),
  progress("check", "Знімаю кадри сцен… 2/2", 2, 2, 6),
  progress("qa", "Перевіряю кадри…", null, null, 2),
  cost("qa", 0.03, 2.59),
  state("awaiting_storyboard", "directing", 2, 6),
  say(
    "Розкадровка готова: кадри кожної сцени і музика. Якщо все гаразд — натисніть «Затвердити», і я зроблю відео. Або напишіть, що змінити.",
    ["approve", "edit"],
  ),
  { type: "checkpoint", rev: 2, checkpoint: "storyboard", payload: storyboardPayloadRev2, dt: 0.1 },
]);

/** Після «Затвердити» ревізії 2 → готово (ревізія 2). */
const revisionDelivered = stamp([
  state("rendering", "awaiting_storyboard", 2, 30),
  ...renderBody(),
  ...deliveryBody(2, BREAKDOWN_REV2),
]);

/** Усі сегменти; ключі — назви в порядку часу. */
export const segments = {
  toBrand,
  brandAnswers,
  toScript,
  failed,
  retry,
  toStoryboard,
  toDelivered,
  revisionAfterDelivery,
  revisionDelivered,
};

/** @typedef {keyof typeof segments} SegmentName */

/** @typedef {"brand" | "script" | "storyboard" | "delivered" | "failed" | "revision" | "revisionDelivered"} PathName */

/** Шляхи програвання для `?jump=` (mock) і для fixture-states. @type {Record<PathName, SegmentName[]>} */
export const PATHS = {
  brand: ["toBrand"],
  script: ["toBrand", "brandAnswers", "toScript"],
  storyboard: ["toBrand", "brandAnswers", "toScript", "toStoryboard"],
  delivered: ["toBrand", "brandAnswers", "toScript", "toStoryboard", "toDelivered"],
  failed: ["toBrand", "brandAnswers", "toScript", "failed"],
  revision: ["toBrand", "brandAnswers", "toScript", "toStoryboard", "toDelivered", "revisionAfterDelivery"],
  revisionDelivered: [
    "toBrand",
    "brandAnswers",
    "toScript",
    "toStoryboard",
    "toDelivered",
    "revisionAfterDelivery",
    "revisionDelivered",
  ],
};

/**
 * Події шляху підряд.
 * @param {SegmentName[]} names
 * @returns {StoredEvent[]}
 */
export function eventsOf(names) {
  return names.flatMap((n) => segments[n]);
}

/** Усі події фікстури (усі сегменти, у порядку ID). */
export const allEvents = Object.values(segments).flat();
