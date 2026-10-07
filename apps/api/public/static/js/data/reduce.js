// @ts-check
/**
 * B2 · Редьюсер подій чату → `UiState`.
 *
 * `reduce(state, event, eventId)` — чиста функція (не мутує `state`, не читає годинник: час —
 * лише з `event.at`).
 *
 * Дедуплікація (без нових ключів у `UiState`) — у два шари:
 * 1. `reduce` ідемпотентний щодо повтору тієї самої події: події, що додають рядок у стрічку
 *    (`message`, `checkpoint`, `error`, новий рядок `progress`), відкидаються, якщо в `feed` уже
 *    є елемент з цим `eventId`; решта застосовуються «за значенням» (повтор дає той самий стан):
 *    `state` з тим самим статусом не вважається зміною статусу, `artifact` — upsert, `cost` —
 *    присвоєння.
 * 2. Порядок і повтори зі стріму (перепідключення, повтор історії) відсікає `createEventGate()` —
 *    «висока вода» за ID стріму Redis (`<ms>-<seq>`, порівняння як `compareStreamIds` з
 *    `@adc/shared`). Ворота живуть у замиканні шару даних (sse.js / mock.js), не в стані.
 */
import { AWAITING, BUSY, CHECKPOINT_STATUS } from "../contracts.js";

/** @typedef {import("../contracts.js").UiState} UiState */
/** @typedef {import("../contracts.js").FeedItem} FeedItem */
/** @typedef {import("../contracts.js").ChatEvent} ChatEvent */
/** @typedef {import("../contracts.js").Checkpoint} Checkpoint */
/** @typedef {import("../contracts.js").ProjectStatus} ProjectStatus */
/**
 * @template {import("../contracts.js").ChatEventType} T
 * @typedef {import("../contracts.js").EventOf<T>} EventOf
 */

/** Статус очікування → чекпоінт. @type {Partial<Record<ProjectStatus, Checkpoint>>} */
const CHECKPOINT_BY_STATUS = Object.fromEntries(
  Object.entries(CHECKPOINT_STATUS).map(([cp, status]) => [status, cp]),
);

/**
 * Порівняння ID записів Redis Stream (`<ms>-<seq>`) — копія `compareStreamIds` з `@adc/shared`.
 * @param {string} a
 * @param {string} b
 * @returns {number} < 0, якщо `a` раніше за `b`
 */
export function compareStreamIds(a, b) {
  const [am = 0, as = 0] = a.split("-").map(Number);
  const [bm = 0, bs = 0] = b.split("-").map(Number);
  return am !== bm ? am - bm : as - bs;
}

/** @param {string} id */
const isStreamId = (id) => /^\d+-\d+$/.test(id);

/**
 * Ворота подій стріму: пропускають лише ID, новіші за останній прийнятий. ID не у форматі стріму
 * (локальні, mock) пропускаються завжди — їх дедуплікує сам `reduce`.
 * @param {string | null} [last]
 * @returns {{ accept(id: string): boolean, readonly last: string | null }}
 */
export function createEventGate(last = null) {
  let high = last;
  return {
    accept(id) {
      if (!id || !isStreamId(id)) return true;
      if (high && compareStreamIds(id, high) <= 0) return false;
      high = id;
      return true;
    },
    get last() {
      return high;
    },
  };
}

/**
 * @param {FeedItem[]} feed
 * @param {string} id
 */
const hasFeedId = (feed, id) => feed.some((item) => item.id === id);

/**
 * Закриває активні рядки progress (повертає той самий масив, якщо закривати нічого).
 * @param {FeedItem[]} feed
 * @returns {FeedItem[]}
 */
function closeProgress(feed) {
  if (!feed.some((item) => item.kind === "progress" && item.running)) return feed;
  return feed.map((item) => (item.kind === "progress" && item.running ? { ...item, running: false } : item));
}

/**
 * @param {UiState} s
 * @param {EventOf<"progress">} ev
 * @param {string} id
 * @returns {UiState}
 */
function onProgress(s, ev, id) {
  const item = { stage: ev.stage, label: ev.label, done: ev.done, total: ev.total };
  const last = s.feed.at(-1);
  /** @type {FeedItem[]} */
  let feed;
  if (last?.kind === "progress" && last.running && last.stage === ev.stage) {
    feed = [...s.feed.slice(0, -1), { ...last, ...item, at: ev.at }];
  } else {
    if (hasFeedId(s.feed, id)) return s;
    feed = [...closeProgress(s.feed), { kind: "progress", id, at: ev.at, ...item, running: true }];
  }
  const stageLog =
    s.stageLog.at(-1)?.label === ev.label
      ? s.stageLog
      : [...s.stageLog, { stage: ev.stage, label: ev.label }];
  return { ...s, feed, progress: item, stageLog };
}

/**
 * @param {UiState} s
 * @param {EventOf<"state">} ev
 * @returns {UiState}
 */
function onState(s, ev) {
  const from = s.status;
  const to = ev.status;
  const wasBusy = BUSY.includes(from);
  const isBusy = BUSY.includes(to);

  // Машинний час: відрізки busy-станів за `at` state-подій. busy → busy (і повтор тієї самої
  // події) зберігає початок відрізка.
  let { busyMs, busySince } = s;
  if (isBusy) {
    if (!wasBusy || !busySince) busySince = ev.at;
  } else if (busySince) {
    busyMs += Math.max(0, Date.parse(ev.at) - Date.parse(busySince));
    busySince = null;
  }

  if (from === to) return { ...s, prevStatus: ev.prev, rev: ev.rev, busyMs, busySince };

  let { checkpoints } = s;
  const left = CHECKPOINT_BY_STATUS[from];
  const entry = left ? checkpoints[left] : null;
  if (left && entry && AWAITING.includes(from)) {
    checkpoints = {
      ...checkpoints,
      [left]: { ...entry, state: to === "revising" ? "superseded" : "approved" },
    };
  }

  return {
    ...s,
    status: to,
    prevStatus: ev.prev,
    rev: ev.rev,
    checkpoints,
    busyMs,
    busySince,
    stageLog: [],
    progress: null,
    feed: closeProgress(s.feed),
    error: to === "failed" ? s.error : null,
  };
}

/**
 * @param {UiState} s
 * @param {EventOf<"artifact">} ev
 * @returns {UiState}
 */
function onArtifact(s, ev) {
  const { artifacts } = s;
  switch (ev.kind) {
    case "video": {
      const format = ev.format;
      if (!format) return s;
      const videos = artifacts.videos.filter((v) => !(v.format === format && v.rev === ev.rev));
      return { ...s, artifacts: { ...artifacts, videos: [...videos, { format, url: ev.url, rev: ev.rev }] } };
    }
    case "poster":
      return { ...s, artifacts: { ...artifacts, poster: ev.url } };
    case "music":
      return { ...s, artifacts: { ...artifacts, music: ev.url } };
    default:
      return s;
  }
}

/**
 * Застосовує подію чату до стану UI.
 * @param {UiState} state
 * @param {ChatEvent} event
 * @param {string} eventId ID події SSE (= ID запису стріму) — стає `id` елемента стрічки
 * @returns {UiState}
 */
export function reduce(state, event, eventId) {
  const s = state;
  const id = eventId;
  switch (event.type) {
    case "message":
      if (hasFeedId(s.feed, id)) return s;
      return {
        ...s,
        feed: [
          ...s.feed,
          {
            kind: "message",
            id,
            at: event.at,
            role: event.role,
            text: event.text,
            buttons: event.buttons ?? [],
          },
        ],
      };
    case "progress":
      return onProgress(s, event, id);
    case "checkpoint":
      if (hasFeedId(s.feed, id)) return s;
      return {
        ...s,
        checkpoints: {
          ...s.checkpoints,
          [event.checkpoint]: { rev: event.rev, at: event.at, payload: event.payload, state: "open" },
        },
        feed: [
          ...closeProgress(s.feed),
          { kind: "checkpoint", id, at: event.at, checkpoint: event.checkpoint, rev: event.rev },
        ],
      };
    case "state":
      return onState(s, event);
    case "artifact":
      return onArtifact(s, event);
    case "cost":
      return { ...s, totalUsd: event.totalUsd, breakdown: event.breakdown ?? s.breakdown };
    case "error": {
      if (hasFeedId(s.feed, id)) return s;
      const error = { stage: event.stage, message: event.message, retryable: event.retryable };
      return { ...s, error, feed: [...s.feed, { kind: "error", id, at: event.at, ...error }] };
    }
    default:
      return s;
  }
}

/**
 * Згортає список подій.
 * @param {UiState} state
 * @param {Iterable<{ id: string, event: ChatEvent }>} events
 * @returns {UiState}
 */
export function reduceAll(state, events) {
  let s = state;
  for (const { id, event } of events) s = reduce(s, event, id);
  return s;
}
