// @ts-check
/**
 * B4 · фікстури вкладки «Використання» (`/?fixture=<ім'я>`): адмін на `?admin=usage`.
 * Дані узгоджені, як рахує бекенд (`docs/usage-api.md`): агрегат проєкту — сума його рядків
 * моделей, користувач — сума його проєктів, підсумок — користувачі + «Система» (проєкти без
 * власника й спільні витрати). Ціни — config/prices.json; кредитів за $1 — `CREDITS_PER_USD`.
 * Період за замовчуванням — 30 днів до 22.10.2026 (дні UTC).
 *
 * Кадри: `adu-loaded`, `adu-user-open`, `adu-project-open`, `adu-custom-range`, `adu-range-error`,
 * `adu-eval` (кредити й маржа «—»), `adu-empty`, `adu-loading`, `adu-error`.
 */
import { ADMIN, ADMIN_ME, ANDRIY, accountFixture, at, CREDITS_PER_USD, IRYNA, OLENA } from "./_base.js";

/** @typedef {import("../../js/contracts.js").UiState} UiState */
/** @typedef {import("../../js/contracts.js").PublicUser} PublicUser */
/** @typedef {import("../../js/contracts.js").ProjectStatus} ProjectStatus */
/** @typedef {import("../../js/contracts.js").CostStage} CostStage */
/** @typedef {import("../../js/contracts.js").UsageState} UsageState */
/** @typedef {import("../../js/contracts.js").UsageSource} UsageSource */
/** @typedef {import("../../js/contracts.js").UsageRange} UsageRange */
/** @typedef {import("../../js/contracts.js").UsageTokens} UsageTokens */
/** @typedef {import("../../js/contracts.js").UsageAggregate} UsageAggregate */
/** @typedef {import("../../js/contracts.js").UsageModelRow} UsageModelRow */
/** @typedef {import("../../js/contracts.js").UsageStageRow} UsageStageRow */
/** @typedef {import("../../js/contracts.js").UsageSummary} UsageSummary */
/** @typedef {import("../../js/contracts.js").UsageUserRow} UsageUserRow */
/** @typedef {import("../../js/contracts.js").UsageProjectRow} UsageProjectRow */
/** @typedef {import("../../js/contracts.js").UsageProjectsPage} UsageProjectsPage */

/** Округлення як у бекенді (6 знаків). @param {number} n */
const r6 = (n) => Math.round(n * 1e6) / 1e6;

/** @param {number} [input] @param {number} [output] @param {number} [cacheWrite] @param {number} [cacheRead] @returns {UsageTokens} */
const tok = (input = 0, output = 0, cacheWrite = 0, cacheRead = 0) => ({
  input,
  output,
  cacheWrite,
  cacheRead,
  total: input + output + cacheWrite + cacheRead,
});

/** $ за 1 млн токенів: вхід, вихід, запис кешу, читання кешу (config/prices.json). */
const CLAUDE_PRICES = {
  "claude-opus-5-5": [4, 20, 5, 0.2],
  "claude-sonnet-5-5": [2, 10, 2.5, 0.2],
};

/**
 * @param {keyof typeof CLAUDE_PRICES} model
 * @param {number} calls @param {number} input @param {number} output @param {number} cacheWrite @param {number} cacheRead
 * @returns {UsageModelRow}
 */
const claude = (model, calls, input, output, cacheWrite, cacheRead) => {
  const [pi = 0, po = 0, pw = 0, pr = 0] = CLAUDE_PRICES[model];
  return {
    provider: "anthropic",
    model,
    calls,
    tokens: tok(input, output, cacheWrite, cacheRead),
    audioSeconds: 0,
    renders: 0,
    usd: r6((input * pi + output * po + cacheWrite * pw + cacheRead * pr) / 1e6),
  };
};

/** @param {number} calls @param {number} input @param {number} output @param {number} cacheWrite @param {number} cacheRead */
const opus = (calls, input, output, cacheWrite, cacheRead) =>
  claude("claude-opus-5-5", calls, input, output, cacheWrite, cacheRead);
/** @param {number} calls @param {number} input @param {number} output @param {number} cacheWrite @param {number} cacheRead */
const sonnet = (calls, input, output, cacheWrite, cacheRead) =>
  claude("claude-sonnet-5-5", calls, input, output, cacheWrite, cacheRead);

/**
 * Аудіо: музика ElevenLabs $0.15/хв, звуки $0.12/хв, каталог Epidemic — без доплати.
 * @param {"music" | "sfx" | "epidemic"} kind @param {number} calls @param {number} seconds
 * @returns {UsageModelRow}
 */
const audio = (kind, calls, seconds) => ({
  provider: kind === "epidemic" ? "epidemic" : "elevenlabs",
  model: { music: "music_v1", sfx: "eleven_text_to_sound_v2", epidemic: "epidemic-catalog" }[kind],
  calls,
  tokens: tok(),
  audioSeconds: seconds,
  renders: 0,
  usd: r6((seconds / 60) * { music: 0.15, sfx: 0.12, epidemic: 0 }[kind]),
});

/** Рендери Remotion, $0.01 за рендер. @param {number} n @returns {UsageModelRow} */
const render = (n) => ({
  provider: "remotion",
  model: "remotion",
  calls: n,
  tokens: tok(),
  audioSeconds: 0,
  renders: n,
  usd: r6(n * 0.01),
});

/** @type {UsageAggregate} */
const ZERO = { calls: 0, tokens: tok(), audioSeconds: 0, renders: 0, usd: 0 };

/** Сума агрегатів (лише поля `UsageAggregate`). @param {readonly UsageAggregate[]} list @returns {UsageAggregate} */
const sum = (list) =>
  list.reduce(
    (a, x) => ({
      calls: a.calls + x.calls,
      tokens: tok(
        a.tokens.input + x.tokens.input,
        a.tokens.output + x.tokens.output,
        a.tokens.cacheWrite + x.tokens.cacheWrite,
        a.tokens.cacheRead + x.tokens.cacheRead,
      ),
      audioSeconds: a.audioSeconds + x.audioSeconds,
      renders: a.renders + x.renders,
      usd: r6(a.usd + x.usd),
    }),
    ZERO,
  );

/** Злиття рядків моделей за (provider, model); usd ↓, provider ↑, model ↑. @param {UsageModelRow[][]} lists */
const mergeModels = (lists) => {
  /** @type {Map<string, UsageModelRow>} */
  const map = new Map();
  for (const m of lists.flat()) {
    const key = `${m.provider}/${m.model}`;
    const prev = map.get(key);
    map.set(key, prev ? { ...sum([prev, m]), provider: m.provider, model: m.model } : m);
  }
  return [...map.values()].sort(
    (a, b) => b.usd - a.usd || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model),
  );
};

/** Злиття рядків етапів; usd ↓, stage ↑. @param {UsageStageRow[][]} lists */
const mergeStages = (lists) => {
  /** @type {Map<CostStage, UsageStageRow>} */
  const map = new Map();
  for (const s of lists.flat()) {
    const prev = map.get(s.stage);
    map.set(s.stage, prev ? { stage: s.stage, calls: prev.calls + s.calls, usd: r6(prev.usd + s.usd) } : s);
  }
  return [...map.values()].sort((a, b) => b.usd - a.usd || a.stage.localeCompare(b.stage));
};

/** Як виклики Anthropic розходяться по етапах (частки в сумі 1). @type {[CostStage, number][]} */
const CLAUDE_STAGES = [
  ["codegen", 0.36],
  ["storyboard", 0.2],
  ["brandkit", 0.14],
  ["check", 0.1],
  ["crawl", 0.08],
  ["chat-reply", 0.07],
  ["chat-intent", 0.05],
];

/**
 * Розбивка по етапах із рядків моделей: Anthropic — за частками, аудіо — `audio`
 * (або `sfx-cache` для спільних витрат), Remotion — `render`.
 * @param {UsageModelRow[]} models @param {boolean} [shared]
 * @returns {UsageStageRow[]}
 */
const stagesOf = (models, shared = false) => {
  /** @type {UsageStageRow[]} */
  const out = [];
  for (const m of models) {
    if (m.provider !== "anthropic") {
      out.push({
        stage: m.provider === "remotion" ? "render" : shared ? "sfx-cache" : "audio",
        calls: m.calls,
        usd: m.usd,
      });
      continue;
    }
    // Виклики — за частками (остача — найбільшому етапу), гроші — між етапами з викликами.
    let left = m.calls;
    const parts = CLAUDE_STAGES.map(([stage, part]) => {
      const calls = Math.min(left, Math.round(m.calls * part));
      left -= calls;
      return { stage, part, calls };
    });
    const first = parts[0];
    if (first) first.calls += left;
    const used = parts.filter((p) => p.calls > 0);
    const weight = used.reduce((n, p) => n + p.part, 0);
    let usd = m.usd;
    used.forEach((p, i) => {
      const u = i === used.length - 1 ? r6(usd) : r6((m.usd * p.part) / weight);
      usd -= u;
      out.push({ stage: p.stage, calls: p.calls, usd: u });
    });
  }
  return mergeStages([out]);
};

/**
 * Рядок `GET /api/admin/usage/projects`. Мета не прочиталась (R4) — `status`/`created`/`host` = null.
 * @param {{ id: string, owner: PublicUser | null, host: string | null, status: ProjectStatus | null,
 *   created: string | null, delivered?: string, revisions?: number, revisionUsd?: number,
 *   models: UsageModelRow[] }} o
 * @returns {UsageProjectRow}
 */
const project = (o) => {
  const byModel = mergeModels([o.models]);
  const agg = sum(byModel);
  const revisionUsd = o.revisionUsd ?? 0;
  return {
    ...agg,
    projectId: o.id,
    ownerId: o.owner?.id ?? null,
    ownerEmail: o.owner?.email ?? null,
    host: o.host,
    url: o.host ? `https://${o.host}/` : null,
    status: o.status,
    createdAt: o.created,
    firstDeliveredAt: o.delivered ?? null,
    revisions: o.revisions ?? 0,
    firstDeliveryUsd: r6(agg.usd - revisionUsd),
    revisionUsd,
    byModel,
    byStage: stagesOf(byModel),
  };
};

// ───────────── Проєкти (джерело chat) ─────────────

/** Олена: здано 14.10 і одна правка (рев. 2). */
const ZERNO = project({
  id: "p_zerno",
  owner: OLENA,
  host: "zerno.example.com",
  status: "delivered",
  created: at("14.10 10:05"),
  delivered: at("14.10 10:52"),
  revisions: 1,
  revisionUsd: 0.584,
  models: [
    opus(46, 120_000, 52_000, 70_000, 900_000),
    sonnet(28, 60_000, 9_000, 20_000, 300_000),
    audio("music", 2, 60),
    audio("sfx", 4, 20),
    render(3),
  ],
});
const FLOR = project({
  id: "p_flor",
  owner: OLENA,
  host: "florist-kyiv.example.com",
  status: "rendering",
  created: at("19.10 10:15"),
  models: [
    opus(38, 100_000, 44_000, 60_000, 700_000),
    sonnet(20, 40_000, 6_000, 15_000, 200_000),
    audio("music", 1, 30),
    audio("epidemic", 1, 30),
  ],
});
/** Проєкт за описом — без сайту. */
const KAV = project({
  id: "p_kav",
  owner: OLENA,
  host: null,
  status: "awaiting_script",
  created: at("18.10 09:04"),
  models: [opus(14, 40_000, 15_000, 30_000, 200_000), sonnet(9, 20_000, 3_000, 8_000, 60_000)],
});
const SHYNA = project({
  id: "p_shyna",
  owner: OLENA,
  host: "shyna-lviv.example.com",
  status: "failed",
  created: at("16.10 18:40"),
  models: [opus(22, 70_000, 25_000, 40_000, 420_000), sonnet(12, 30_000, 4_000, 10_000, 120_000)],
});
const AN1 = project({
  id: "p_an1",
  owner: ANDRIY,
  host: null,
  status: "awaiting_brand",
  created: at("15.10 12:20"),
  models: [opus(8, 30_000, 9_000, 25_000, 90_000), sonnet(5, 10_000, 2_000, 5_000, 20_000)],
});
/** Без власника: клієнтський проєкт до акаунтів. */
const PEKARNIA = project({
  id: "p_pek",
  owner: null,
  host: "pekarnia-dnipro.example.com",
  status: "delivered",
  created: at("25.09 14:10"),
  delivered: at("25.09 15:02"),
  models: [
    opus(41, 110_000, 47_000, 65_000, 820_000),
    sonnet(24, 50_000, 8_000, 18_000, 260_000),
    audio("music", 2, 60),
    render(2),
  ],
});
/** Мета не прочиталась (R4): хост, статус і дата — null, гроші рахуються. */
const BROKEN = project({
  id: "p_8f3k2q",
  owner: null,
  host: null,
  status: null,
  created: null,
  models: [sonnet(3, 8_000, 1_500, 0, 20_000)],
});

/** `costs-shared.jsonl`: кеш звукових ефектів. */
const SHARED = [audio("sfx", 6, 90)];

// ───────────── Проєкти eval ─────────────

const EV1 = project({
  id: "p_ev1",
  owner: null,
  host: "kavarnia-eval.example.com",
  status: "delivered",
  created: at("13.10 15:00"),
  delivered: at("13.10 15:41"),
  models: [
    opus(52, 140_000, 61_000, 80_000, 1_050_000),
    sonnet(31, 70_000, 10_000, 22_000, 340_000),
    audio("music", 3, 90),
    render(3),
  ],
});
const EV2 = project({
  id: "p_ev2",
  owner: null,
  host: "zerno.example.com",
  status: "failed",
  created: at("12.10 16:30"),
  models: [opus(17, 52_000, 18_000, 30_000, 260_000), sonnet(7, 14_000, 2_000, 5_000, 40_000)],
});

// ───────────── Збирач відповідей ─────────────

/** Користувачі адмінки (`accounts.listUsers()`). */
const ACCOUNTS = [ADMIN, OLENA, ANDRIY, IRYNA];

/** Списано кредитів у вікні (charge − refund): Олена 12 + 10 + (10 − 10) + 15, Андрій 10. */
const CREDITS = { [OLENA.id]: 37, [ANDRIY.id]: 10 };

const RANGE_30D = { from: "2026-09-23", to: "2026-10-22" };

/**
 * Відповіді трьох ендпоінтів на одну вибірку: `summary`, `users` (usd ↓, email ↑) і `all`
 * (сторінка 1 «Усіх проєктів», usd ↓).
 * `credits` — списання по користувачах (дефолт `CREDITS`).
 * @param {{ projects: UsageProjectRow[], shared: UsageModelRow[], source?: UsageSource, range?: UsageRange, credits?: Record<string, number> }} o
 */
function dataset({ projects, shared, source = "chat", range = RANGE_30D, credits = CREDITS }) {
  const credited = source === "chat" || source === "all";
  const owned = projects.filter((p) => p.ownerId);
  const ownerless = projects.filter((p) => !p.ownerId);

  /** @type {UsageUserRow[]} */
  const users = ACCOUNTS.map((u) => {
    const mine = owned.filter((p) => p.ownerId === u.id);
    const agg = sum(mine);
    const charged = credited ? (credits[u.id] ?? 0) : null;
    return {
      ...agg,
      id: u.id,
      email: u.email,
      name: u.name,
      createdAt: u.createdAt,
      projects: mine.length,
      delivered: mine.filter((p) => p.firstDeliveredAt).length,
      creditsCharged: charged,
      marginUsd: charged === null ? null : r6(charged / CREDITS_PER_USD - agg.usd),
      byModel: mergeModels(mine.map((p) => p.byModel)),
    };
  }).sort((a, b) => b.usd - a.usd || a.email.localeCompare(b.email));

  const delivered = projects.filter((p) => p.firstDeliveredAt);
  const revisions = projects.reduce((n, p) => n + p.revisions, 0);
  const charged = credited ? users.reduce((n, u) => n + (u.creditsCharged ?? 0), 0) : null;
  const creditsUsd = charged === null ? null : r6(charged / CREDITS_PER_USD);

  /** @type {UsageSummary} */
  const summary = {
    from: range.from,
    to: range.to,
    source,
    totals: {
      ...sum([...projects, ...shared]),
      users: users.filter((u) => u.calls > 0).length,
      projects: projects.length,
      delivered: delivered.length,
      avgUsdPerDelivered: delivered.length
        ? r6(delivered.reduce((n, p) => n + p.firstDeliveryUsd, 0) / delivered.length)
        : null,
      avgUsdPerRevision: revisions ? r6(projects.reduce((n, p) => n + p.revisionUsd, 0) / revisions) : null,
      creditsCharged: charged,
      creditsUsd,
      marginUsd: creditsUsd === null ? null : r6(creditsUsd - sum(owned).usd),
    },
    byModel: mergeModels([...projects.map((p) => p.byModel), shared]),
    byStage: mergeStages([...projects.map((p) => p.byStage), stagesOf(shared, true)]),
    system: sum([...ownerless, ...shared]),
  };

  /** @param {UsageProjectRow[]} items @param {string | null} owner @returns {UsageProjectsPage} */
  const page = (items, owner) => {
    const sorted = [...items].sort((a, b) => b.usd - a.usd || a.projectId.localeCompare(b.projectId));
    return {
      owner,
      from: range.from,
      to: range.to,
      source,
      page: 1,
      pageSize: 25,
      total: sorted.length,
      items: sorted,
      totals: sum(sorted),
    };
  };

  return {
    summary,
    users,
    all: page(projects, null),
    /** @param {string} userId */
    of: (userId) =>
      page(
        owned.filter((p) => p.ownerId === userId),
        userId,
      ),
  };
}

const CHAT = dataset({ projects: [ZERNO, FLOR, SHYNA, KAV, AN1, PEKARNIA, BROKEN], shared: SHARED });
/** 14–19.10: лише проєкти, створені в ці дні. */
const RANGE_CUSTOM = { from: "2026-10-14", to: "2026-10-19" };
const CUSTOM = dataset({ projects: [ZERNO, FLOR, SHYNA, KAV, AN1], shared: SHARED, range: RANGE_CUSTOM });
const EVAL = dataset({ projects: [EV1, EV2], shared: [], source: "eval" });
/** Порожній період: ні подій, ні списань (інакше вкладка показала б списані кредити). */
const EMPTY = dataset({
  projects: [],
  shared: [],
  range: { from: "2026-10-16", to: "2026-10-22" },
  credits: {},
});

/**
 * Адмінка під адміном на вкладці «Використання»; `usage` зливається поверх `initialUsage()`.
 * @param {Partial<{ [K in keyof UsageState]: any }>} usage
 * @returns {UiState}
 */
const adu = (usage) =>
  accountFixture({
    route: "admin",
    account: { me: ADMIN_ME },
    admin: { tab: "usage", usage: { preset: "30d", range: RANGE_30D, ...usage } },
  });

/** @param {ReturnType<typeof dataset>} d */
const loaded = (d) => ({ summary: d.summary, users: d.users, all: { data: d.all } });

const USER_OPEN = {
  ...loaded(CHAT),
  expandedUserId: OLENA.id,
  userProjects: { data: CHAT.of(OLENA.id) },
};

/** @type {Record<string, UiState>} */
export default {
  "adu-loaded": adu(loaded(CHAT)),
  "adu-user-open": adu(USER_OPEN),
  "adu-project-open": adu({ ...USER_OPEN, expandedProjectId: ZERNO.projectId }),
  "adu-custom-range": adu({ preset: "custom", range: RANGE_CUSTOM, ...loaded(CUSTOM) }),
  "adu-range-error": adu({
    preset: "custom",
    range: { from: "2026-10-19", to: "2026-10-14" },
    rangeError: true,
    ...loaded(CUSTOM),
  }),
  "adu-eval": adu({ source: "eval", ...loaded(EVAL) }),
  "adu-empty": adu({ preset: "7d", range: { from: "2026-10-16", to: "2026-10-22" }, ...loaded(EMPTY) }),
  "adu-loading": adu({ loading: true }),
  "adu-error": adu({ error: true }),
};
