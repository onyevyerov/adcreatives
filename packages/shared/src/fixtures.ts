import { type BrandKit, type BrandKitFile, emptySubstance } from "./schemas/brandkit.ts";
import type { AssetManifest, SiteData } from "./schemas/crawl.ts";
import type { ProjectState } from "./schemas/project.ts";
import type { Storyboard } from "./schemas/storyboard.ts";
import type { AudioManifest } from "./types/video.ts";

/**
 * Канонічні фікстури для тестів усіх блоків (кав'ярня «Зерно», Львів).
 * Імпорт: `import { fixtureBrandKit } from "@adc/shared/fixtures"`.
 */

const AT = "2026-10-06T10:00:00.000Z";

export const fixtureSiteData: SiteData = {
  source: "site",
  url: "https://zerno.example.com/",
  finalUrl: "https://zerno.example.com/uk/",
  crawledAt: AT,
  partial: false,
  language: "uk",
  languageVersions: [
    { lang: "uk", url: "https://zerno.example.com/uk/" },
    { lang: "en", url: "https://zerno.example.com/en/" },
  ],
  pages: [
    {
      url: "https://zerno.example.com/uk/",
      title: "Зерно — кав'ярня у Львові",
      description: "Спешелті кава і випічка щодня з 8:00",
      lang: "uk",
      headings: [
        { level: 1, text: "Кава, яку обсмажуємо самі" },
        { level: 2, text: "Сніданки до 12:00" },
      ],
      text: "Обсмажуємо зерно щотижня. Капучино — 75 грн. Знижка 10% на каву з собою до 10:00.",
      buttons: ["Забронювати столик", "Меню"],
      jsonLd: [{ "@type": "CafeOrCoffeeShop", name: "Зерно" }],
      og: { "og:title": "Зерно", "og:image": "https://zerno.example.com/og.jpg" },
      screenshot: "projects/p1/crawl/screenshots/0.png",
    },
  ],
  navigation: [{ text: "Меню", url: "https://zerno.example.com/uk/menu" }],
  contacts: {
    phones: ["+380 67 123 45 67"],
    emails: ["hello@zerno.example.com"],
    addresses: ["Львів, вул. Руська, 1"],
    socials: [{ network: "instagram", url: "https://instagram.com/zerno" }],
  },
  design: {
    cssVars: { "--brand": "#6B3E26" },
    colors: [
      { role: "background", value: "#FFF8F0", count: 120 },
      { role: "button", value: "#6B3E26", count: 14 },
    ],
    fonts: [
      { role: "h1", family: "Montserrat", weight: 700 },
      { role: "body", family: "Inter", weight: 400 },
    ],
    buttonRadius: "999px",
  },
  screenshots: [
    {
      pageUrl: "https://zerno.example.com/uk/",
      path: "projects/p1/crawl/screenshots/0.png",
      viewport: "first",
      width: 1440,
      height: 900,
    },
  ],
  manualText: null,
  stats: { pagesVisited: 1, pagesFailed: 0, durationMs: 4200 },
};

export const fixtureAssets: AssetManifest = {
  updatedAt: AT,
  assets: [
    {
      id: "a01",
      kind: "photo",
      source: "site",
      path: "projects/p1/crawl/assets/a01.jpg",
      originUrl: "https://zerno.example.com/img/hero.jpg",
      pageUrl: "https://zerno.example.com/uk/",
      mime: "image/jpeg",
      bytes: 240_000,
      width: 1920,
      height: 1280,
      phash: "c3a1f0e0d0c0b0a0",
      dominantColors: ["#6B3E26", "#FFF8F0"],
      alt: "Бариста готує капучино",
      context: "Кава, яку обсмажуємо самі",
      isLogoCandidate: false,
      priority: 10,
    },
    {
      id: "a02",
      kind: "logo",
      source: "site",
      path: "projects/p1/crawl/assets/a02.svg",
      originUrl: "https://zerno.example.com/logo.svg",
      pageUrl: "https://zerno.example.com/uk/",
      mime: "image/svg+xml",
      bytes: 4_000,
      width: 320,
      height: 120,
      phash: null,
      dominantColors: ["#6B3E26"],
      alt: "Зерно",
      context: null,
      isLogoCandidate: true,
      priority: 5,
    },
  ],
};

export const fixtureBrandKit: BrandKit = {
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
    heading: { family: "Montserrat", weights: [700, 800], origin: "site" },
    body: { family: "Inter", weights: [400, 600], origin: "site" },
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
  substance: emptySubstance(),
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
};

export const fixtureBrandKitFile: BrandKitFile = {
  ...fixtureBrandKit,
  version: 1,
  createdAt: AT,
  origin: "llm",
  fixes: [],
};

export const fixtureStoryboard: Storyboard = {
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
};

export const fixtureAudioManifest: AudioManifest = {
  music: { src: "music.mp3", durationMs: 16_000, fadeOutMs: 800, volume: 0.8, planHash: "abcdef0123456789" },
  mix: null,
  sfx: [
    { cue: "whoosh", src: "sfx/whoosh.mp3", durationMs: 600, volume: 0.6 },
    { cue: "pop", src: "sfx/pop.mp3", durationMs: 300, volume: 0.6 },
  ],
  totalFrames: 450,
};

export function fixtureProject(overrides: Partial<ProjectState> = {}): ProjectState {
  return {
    id: "p1",
    createdAt: AT,
    updatedAt: AT,
    status: "intake",
    origin: "chat",
    input: { kind: "site", url: "https://zerno.example.com/", manualText: null },
    formats: ["vertical"],
    language: null,
    answers: {},
    durationSeconds: null,
    rev: 1,
    revisions: [{ n: 1, createdAt: AT, basedOn: null, reason: "initial", at: null, instruction: null }],
    brandkitVersion: null,
    phase: "first_delivery",
    pendingMessages: [],
    branches: { video: "idle", audio: "idle" },
    audioPlanHash: null,
    failure: null,
    restartRequested: false,
    firstDeliveredAt: null,
    deliveredAt: null,
    ...overrides,
  };
}
