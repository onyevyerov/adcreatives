// @ts-check
/**
 * Готові `UiState` на кожен екран — щоб view-блоки працювали без шару даних (B2).
 * Відкрити в браузері: `/?fixture=awaitingBrand` (див. app.js).
 *
 * Стани згортаються з fixture-events.js спрощеною функцією `fold` за правилами редьюсера з ТЗ
 * (B2). Еталонна реалізація — data/reduce.js; ця — лише для фікстур.
 *
 * Фікстури акаунтів (ТЗ фронтенду акаунтів, 2.10): кожен блок наповнює лише свій
 * `dev/fixtures/<блок>.js` (імена — з карти станів Референсу `#M`), тут вони спредяться у
 * `fixtureStates`. Спільні дані — `dev/fixtures/_base.js`.
 */
import { AWAITING, BUSY } from "../js/contracts.js";
import { initialState } from "../js/initial.js";
import {
  eventsOf,
  PATHS,
  PROJECT_ID,
  SITE_HOST,
  scriptPayloadUnverified,
  segments,
} from "./fixture-events.js";
import adminFixtures from "./fixtures/admin.js";
import adminUsageFixtures from "./fixtures/admin-usage.js";
import authFixtures from "./fixtures/auth.js";
import cabinetFixtures from "./fixtures/cabinet.js";
import chatFixtures from "./fixtures/chat.js";
import checkoutFixtures from "./fixtures/checkout.js";
import historyFixtures from "./fixtures/history.js";
import profileFixtures from "./fixtures/profile.js";
import projectsFixtures from "./fixtures/projects.js";
import sessionFixtures from "./fixtures/session.js";
import startFixtures from "./fixtures/start.js";
import topbarFixtures from "./fixtures/topbar.js";
import workspaceFixtures from "./fixtures/workspace.js";

/** @typedef {import("../js/contracts.js").UiState} UiState */
/** @typedef {import("../js/contracts.js").FeedItem} FeedItem */
/** @typedef {import("../js/contracts.js").Checkpoint} Checkpoint */
/** @typedef {import("./fixture-events.js").StoredEvent} StoredEvent */

/** @type {Record<string, Checkpoint>} */
const CHECKPOINT_BY_STATUS = {
  awaiting_brand: "brand",
  awaiting_script: "script",
  awaiting_storyboard: "storyboard",
};

/**
 * @param {FeedItem[]} feed
 * @returns {FeedItem[]}
 */
const closeProgress = (feed) =>
  feed.map((item) => (item.kind === "progress" && item.running ? { ...item, running: false } : item));

/**
 * @param {UiState} s
 * @param {StoredEvent} stored
 * @returns {UiState}
 */
function apply(s, { id, event: ev }) {
  switch (ev.type) {
    case "message":
      return {
        ...s,
        feed: [
          ...s.feed,
          { kind: "message", id, at: ev.at, role: ev.role, text: ev.text, buttons: ev.buttons ?? [] },
        ],
      };
    case "progress": {
      const last = s.feed.at(-1);
      const item = { stage: ev.stage, label: ev.label, done: ev.done, total: ev.total };
      // `step` рядка — останньої події (без step — поле зникає), як у редьюсері.
      const step = ev.step === undefined ? {} : { step: ev.step };
      /** @type {FeedItem[]} */
      let feed;
      if (last?.kind === "progress" && last.running && last.stage === ev.stage) {
        const { step: _prevStep, ...prev } = last;
        feed = [...s.feed.slice(0, -1), { ...prev, ...item, ...step, at: ev.at }];
      } else {
        feed = [
          ...closeProgress(s.feed),
          { kind: "progress", id, at: ev.at, ...item, ...step, running: true },
        ];
      }
      const stageLog =
        s.stageLog.at(-1)?.label === ev.label
          ? s.stageLog
          : [...s.stageLog, { stage: ev.stage, label: ev.label }];
      return { ...s, feed, progress: item, stageLog };
    }
    case "checkpoint":
      return {
        ...s,
        checkpoints: {
          ...s.checkpoints,
          [ev.checkpoint]: { rev: ev.rev, at: ev.at, payload: ev.payload, state: "open" },
        },
        feed: [
          ...closeProgress(s.feed),
          { kind: "checkpoint", id, at: ev.at, checkpoint: ev.checkpoint, rev: ev.rev },
        ],
      };
    case "state": {
      const from = s.status;
      const checkpoints = { ...s.checkpoints };
      const left = CHECKPOINT_BY_STATUS[from];
      const entry = left ? checkpoints[left] : null;
      if (left && entry && AWAITING.includes(from)) {
        checkpoints[left] = { ...entry, state: ev.status === "revising" ? "superseded" : "approved" };
      }
      const wasBusy = BUSY.includes(from);
      const isBusy = BUSY.includes(ev.status);
      let { busyMs, busySince } = s;
      if (!wasBusy && isBusy) busySince = ev.at;
      if (wasBusy && !isBusy && busySince) {
        busyMs += Date.parse(ev.at) - Date.parse(busySince);
        busySince = null;
      }
      return {
        ...s,
        status: ev.status,
        prevStatus: ev.prev,
        rev: ev.rev,
        checkpoints,
        busyMs,
        busySince,
        stageLog: [],
        progress: null,
        feed: closeProgress(s.feed),
        error: ev.status === "failed" ? s.error : null,
      };
    }
    case "artifact": {
      const { artifacts } = s;
      if (ev.kind === "video" && ev.format) {
        const format = ev.format;
        const videos = artifacts.videos.filter((v) => !(v.format === format && v.rev === ev.rev));
        return {
          ...s,
          artifacts: { ...artifacts, videos: [...videos, { format, url: ev.url, rev: ev.rev }] },
        };
      }
      if (ev.kind === "poster") return { ...s, artifacts: { ...artifacts, poster: ev.url } };
      if (ev.kind === "music") return { ...s, artifacts: { ...artifacts, music: ev.url } };
      return s;
    }
    case "cost":
      return { ...s, totalUsd: ev.totalUsd, breakdown: ev.breakdown ?? s.breakdown };
    case "error": {
      const error = { stage: ev.stage, message: ev.message, retryable: ev.retryable };
      return { ...s, error, feed: [...s.feed, { kind: "error", id, at: ev.at, ...error }] };
    }
    default:
      return s;
  }
}

/**
 * Стан проєкту після подій.
 * @param {StoredEvent[]} events
 * @param {(s: UiState) => UiState} [tweak]
 * @returns {UiState}
 */
export function fold(events, tweak = (s) => s) {
  const base = {
    ...initialState("project", PROJECT_ID),
    site: SITE_HOST,
    conn: /** @type {const} */ ("online"),
  };
  return tweak(events.reduce(apply, base));
}

/**
 * Події до першої (включно), що задовольняє `pred`.
 * @param {StoredEvent[]} events
 * @param {(e: StoredEvent["event"]) => boolean} pred
 */
function upTo(events, pred) {
  const i = events.findIndex((e) => pred(e.event));
  if (i < 0) throw new Error("fixture-states: подію не знайдено");
  return events.slice(0, i + 1);
}

/** @param {string} label */
const progressLabel = (label) => /** @param {StoredEvent["event"]} e */ (e) =>
  e.type === "progress" && e.label === label;

const toBrand = segments.toBrand;
const directing = eventsOf([...PATHS.script, "toStoryboard"]);
const rendering = eventsOf(PATHS.delivered);

/**
 * Стани на кожен екран прототипу (+ варіанти X) — без акаунта (`meStatus: "loading"`), як до Кроку 0:
 * тести дій порівнюють їх з `initialState`. Фейковий me (Олена, 12) їм підставляє app.js у режимі
 * `?fixture=` — лише їм, за `LEGACY_FIXTURES`; фікстури блоків свій акаунт задають самі.
 * @type {Record<string, UiState>}
 */
const legacyStates = {
  start: initialState("start", null),
  /** crawling, 4/7 сторінок (C3: плейхед 8.53%). */
  crawling: fold(upTo(toBrand, progressLabel("Сканую сайт… 4/7 сторінок"))),
  brandkit: fold(upTo(toBrand, progressLabel("Збираю бренд-кіт…"))),
  /** scripting: два кроки ✓, поточний — «Підганяю тексти під екран» (= `?jump=scripting`). */
  scripting: fold(eventsOf(PATHS.scripting)),
  awaitingBrand: fold(eventsOf(PATHS.brand)),
  awaitingScript: fold(eventsOf(PATHS.script)),
  /** X3: чекпоінт 2 з непідтвердженим твердженням. */
  awaitingScriptUnverified: fold(eventsOf(PATHS.script), (s) => {
    const entry = s.checkpoints.script;
    return entry
      ? { ...s, checkpoints: { ...s.checkpoints, script: { ...entry, payload: scriptPayloadUnverified } } }
      : s;
  }),
  /** directing: сцени 2/3, музика ще пишеться. */
  directing: fold(upTo(directing, progressLabel("Генерую сцени… 2/3"))),
  awaitingStoryboard: fold(eventsOf(PATHS.storyboard)),
  /** rendering: 9:16, 50% (формат 1 з 2). */
  rendering: fold(upTo(rendering, progressLabel("Рендерю 9:16… 50%"))),
  delivered: fold(eventsOf(PATHS.delivered)),
  failed: fold(eventsOf(PATHS.failed)),
  /** Правка після видачі, щойно почалась ревізія 2. */
  revising: fold(upTo(eventsOf(PATHS.revision), progressLabel("Вношу правки…"))),
  /** Готово, ревізія 2 (дві ревізії відео). */
  deliveredRev2: fold(eventsOf(PATHS.revisionDelivered)),
};

/** Назви старих станів (без акаунта). */
export const LEGACY_FIXTURES = Object.keys(legacyStates);

/**
 * Зливає набори фікстур; однакове ім'я у двох наборах — помилка (спред мовчки перекрив би його).
 * @param {[string, Record<string, UiState>][]} sets
 * @returns {Record<string, UiState>}
 */
export function collectFixtures(sets) {
  /** @type {Record<string, UiState>} */
  const out = {};
  /** @type {Record<string, string>} */
  const owner = {};
  for (const [source, states] of sets) {
    for (const [name, state] of Object.entries(states)) {
      if (Object.hasOwn(out, name))
        throw new Error(`fixture-states: «${name}» є і в ${owner[name]}, і в ${source}`);
      out[name] = state;
      owner[name] = source;
    }
  }
  return out;
}

/** Усі фікстури: старі стани + `dev/fixtures/<блок>.js`. */
export const fixtureStates = collectFixtures([
  ["fixture-states.js", legacyStates],
  ["fixtures/auth.js", authFixtures],
  ["fixtures/start.js", startFixtures],
  ["fixtures/topbar.js", topbarFixtures],
  ["fixtures/workspace.js", workspaceFixtures],
  ["fixtures/chat.js", chatFixtures],
  ["fixtures/cabinet.js", cabinetFixtures],
  ["fixtures/checkout.js", checkoutFixtures],
  ["fixtures/history.js", historyFixtures],
  ["fixtures/projects.js", projectsFixtures],
  ["fixtures/profile.js", profileFixtures],
  ["fixtures/admin.js", adminFixtures],
  ["fixtures/admin-usage.js", adminUsageFixtures],
  ["fixtures/session.js", sessionFixtures],
]);

/** Назви станів, які вимагає ТЗ (по одному на екран). */
export const REQUIRED_STATES = [
  "start",
  "crawling",
  "brandkit",
  "awaitingBrand",
  "awaitingScript",
  "directing",
  "awaitingStoryboard",
  "rendering",
  "delivered",
  "failed",
  "revising",
];
