// @ts-check
/**
 * B2 · Дії і запуск потоку даних.
 *
 * `createActions(store, { params })` повертає `Actions` і сам запускає потік даних для поточного
 * маршруту: `?project=<id>` → GET проєкту + SSE; `?mock=1` → mock-бекенд (data/mock.js), який
 * програє фікстуру подій (з `&jump=…` або `&project=…` — одразу робочий простір).
 * Переходи createProject → project і newProject → start теж робить шар даних.
 *
 * `setFormats` / `setLanguage` лише пишуть чернетку вибору (`ui.pendingFormats` /
 * `ui.pendingLanguage`) — без повідомлень і запитів. На ЧП1 її фіксує `approve()` (команда з
 * `choices`), на ЧП3 — `applyFormats()` («Формати: …», це ревізія). Повідомлення не з композера
 * (`applyFormats`) не чіпає чернетку `ui.draft` і режим правки — їх скидає лише `sendMessage`.
 *
 * Крок 0 акаунтів: переходи старт ↔ проєкт скидають лише гілки проєкту (`projectState`), акаунт і
 * модалку входу не чіпають; `GET /api/projects/:id` 404 → `session: "404"`, поле `credits` →
 * `projectCredits`; `POST /api/projects` 402 → `ui.startShortage`, успіх → `refreshMe()`.
 * Решту акаунтів (`Object.assign` поверх цього об'єкта) збирає data/account.js.
 */
import { CHECKPOINT_STATUS, FORMAT_LABELS, FORMATS } from "../contracts.js";
import { projectState } from "../initial.js";
import * as api from "./api.js";
import { createMockBackend } from "./mock.js";
import { reduceAll } from "./reduce.js";
import { connectEvents } from "./sse.js";

/** @typedef {import("../contracts.js").Store} Store */
/** @typedef {import("../contracts.js").ProjectActions} ProjectActions */
/** @typedef {import("../contracts.js").DataOptions} DataOptions */
/** @typedef {import("../contracts.js").UiFlags} UiFlags */
/** @typedef {import("../contracts.js").ChatEvent} ChatEvent */
/** @typedef {import("../contracts.js").UiState} UiState */
/** @typedef {import("../contracts.js").Format} Format */
/** @typedef {import("../contracts.js").Language} Language */
/** @typedef {import("./api.js").CommandBody} CommandBody */
/** @typedef {import("./sse.js").EventSourceCtor} EventSourceCtor */

/**
 * Джерело даних проєкту: справжній API + SSE або mock.
 * @typedef {{
 *   start(projectId: string): Promise<void>,
 *   stop(): void,
 *   createProject(form: FormData): Promise<string>,
 *   sendMessage(projectId: string, text: string): Promise<void>,
 *   sendCommand(projectId: string, body: CommandBody): Promise<void>,
 *   uploadPhotos(projectId: string, files: File[]): Promise<void>
 * }} Backend
 */

/**
 * Додаткові залежності (тести). `batchMs` — вікно, за яке події SSE збираються в один
 * `setState` (повтор історії при підключенні не рендериться подія за подією); 0 — синхронно.
 * @typedef {{ EventSource?: EventSourceCtor, batchMs?: number, backend?: Backend }} DataDeps
 */

/** Вікно збирання подій SSE в один `setState`, мс. */
export const BATCH_MS = 30;

export const NEED_FORMAT = "Оберіть хоча б один формат.";
export const APPLY_FORMATS_FIRST = "Спершу застосуйте або скиньте формати.";

/** @param {readonly Format[]} list @returns {Format[]} у канонічному порядку `FORMATS` */
const canonical = (list) => FORMATS.filter((f) => list.includes(f));

/** @param {readonly Format[]} a @param {readonly Format[]} b */
const sameFormats = (a, b) => canonical(a).join() === canonical(b).join();

/**
 * Мова відео, яку показує ЧП1 без чернетки: мова бренд-кіта, якщо вона серед мовних версій сайту
 * (або версій немає), інакше перша версія; `null` — payload немає.
 * @param {Pick<UiState, "checkpoints">} state
 * @returns {string | null}
 */
export function brandLanguage(state) {
  const p = state.checkpoints.brand?.payload;
  if (p?.checkpoint !== "brand") return null;
  const langs = p.languageOptions.map((o) => o.lang);
  const kit = p.brandkit.identity.language;
  return langs.length === 0 || langs.includes(kit) ? kit : (langs[0] ?? kit);
}

/**
 * Вибір ЧП1 для команди approve: те з чернетки, що відрізняється від payload. `null` — змін немає
 * (approve без `choices`), `"empty"` — зняли всі формати (затверджувати не можна).
 * @param {Pick<UiState, "ui" | "checkpoints">} state
 * @returns {{ formats?: Format[], language?: Language } | null | "empty"}
 */
export function brandChoices(state) {
  const p = state.checkpoints.brand?.payload;
  if (p?.checkpoint !== "brand") return null;
  const { pendingFormats, pendingLanguage } = state.ui;
  if (pendingFormats && pendingFormats.length === 0) return "empty";
  /** @type {{ formats?: Format[], language?: Language }} */
  const choices = {};
  if (pendingFormats && !sameFormats(pendingFormats, p.formats)) choices.formats = canonical(pendingFormats);
  if (pendingLanguage && pendingLanguage !== brandLanguage(state)) choices.language = pendingLanguage;
  return choices.formats || choices.language ? choices : null;
}

/**
 * Формати ЧП3 без чернетки: `primaryFormat` + формати аркушів (бекенд робить аркуш на кожен
 * неосновний формат), у канонічному порядку; `[]` — payload немає.
 * @param {Pick<UiState, "checkpoints">} state
 * @returns {Format[]}
 */
export function boardCurrentFormats(state) {
  const p = state.checkpoints.storyboard?.payload;
  if (p?.checkpoint !== "storyboard") return [];
  return canonical([p.primaryFormat, ...p.sheets.map((s) => s.format)]);
}

/**
 * Чи є на ЧП3 незастосована чернетка форматів (відмінна від поточних).
 * @param {Pick<UiState, "ui" | "checkpoints">} state
 */
export function boardFormatsDirty(state) {
  const draft = state.ui.pendingFormats;
  return draft !== null && !sameFormats(draft, boardCurrentFormats(state));
}

/** @param {unknown} err */
const messageOf = (err) => (err instanceof Error && err.message ? err.message : "Щось пішло не так.");

/**
 * Бекенд над HTTP API і SSE.
 * @param {Store} store
 * @param {{ EventSource?: EventSourceCtor, batchMs?: number }} deps
 * @returns {Backend}
 */
export function createApiBackend(store, deps = {}) {
  const batchMs = deps.batchMs ?? BATCH_MS;
  /** @type {{ close(): void } | null} */
  let events = null;
  /** @type {{ id: string, event: ChatEvent }[]} */
  let pending = [];
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let batchTimer;
  let session = 0;

  function flush() {
    clearTimeout(batchTimer);
    batchTimer = undefined;
    const list = pending;
    pending = [];
    if (list.length > 0) store.setState((s) => reduceAll(s, list));
  }

  /** @param {string} id @param {ChatEvent} event */
  function push(id, event) {
    pending.push({ id, event });
    if (batchMs <= 0) flush();
    else if (batchTimer === undefined) batchTimer = setTimeout(flush, batchMs);
  }

  function stop() {
    session++;
    events?.close();
    events = null;
    clearTimeout(batchTimer);
    batchTimer = undefined;
    pending = [];
  }

  return {
    stop,
    async start(projectId) {
      stop();
      const my = ++session;
      const info = api.getProject(projectId).then(
        (data) => {
          if (my !== session) return;
          const site = api.hostOf(data?.project?.input.url ?? data?.intake?.input.url);
          store.setState({ projectCredits: data?.credits ?? null, ...(site ? { site } : {}) });
        },
        (err) => {
          if (my !== session) return;
          // 401 уже обробив setUnauthorizedHandler (форма входу в сцені).
          if (api.isStatus(err, 401)) return;
          // Немає або чужий (бекенд не розрізняє) — екран «Проєкт не знайдено» (B12).
          if (api.isStatus(err, 404) && err.code === "not_found") {
            stop();
            store.setState({ session: "404" });
            return;
          }
          store.setState((s) => ({ ui: { ...s.ui, notice: messageOf(err) } }));
        },
      );
      try {
        events = connectEvents({
          projectId,
          ...(deps.EventSource ? { EventSource: deps.EventSource } : {}),
          onEvent: push,
          onConn: (conn) => {
            if (my === session) store.setState({ conn });
          },
        });
      } catch (err) {
        store.setState((s) => ({ conn: "lost", ui: { ...s.ui, notice: messageOf(err) } }));
      }
      await info;
    },
    async createProject(form) {
      const res = await api.createProject(form);
      if (!res || typeof res.id !== "string") throw new Error("Сервер не повернув ID проєкту.");
      return res.id;
    },
    async sendMessage(projectId, text) {
      await api.sendMessage(projectId, text);
    },
    async sendCommand(projectId, body) {
      await api.sendCommand(projectId, body);
    },
    async uploadPhotos(projectId, files) {
      await api.uploadPhotos(projectId, files);
    },
  };
}

/**
 * Джерело даних для параметрів сторінки: mock при `?mock=1`, інакше HTTP API + SSE.
 * @param {Store} store
 * @param {DataOptions & DataDeps} opts
 * @returns {Backend}
 */
export function createBackend(store, opts) {
  if (opts.backend) return opts.backend;
  if (opts.params.get("mock") === "1") return createMockBackend(store, { params: opts.params });
  return createApiBackend(store, {
    ...(opts.EventSource ? { EventSource: opts.EventSource } : {}),
    ...(opts.batchMs !== undefined ? { batchMs: opts.batchMs } : {}),
  });
}

/**
 * `openStream(id)` — скинути гілки проєкту, перейти на нього і запустити потік даних (для
 * `navigate` з data/account.js; URL міняє викликач).
 * @param {Store} store
 * @param {DataOptions & DataDeps} opts
 * @returns {ProjectActions & { readonly ready: Promise<void>, dispose(): void, openStream(id: string): Promise<void> }}
 */
export function createActions(store, opts) {
  const params = opts.params;
  const mock = params.get("mock") === "1";
  const backend = createBackend(store, opts);

  /** Поточний запуск потоку даних (тести чекають на нього). */
  let ready = Promise.resolve();
  let inflight = 0;

  /** @param {Partial<UiFlags>} patch */
  const ui = (patch) => store.setState((s) => ({ ui: { ...s.ui, ...patch } }));
  const projectId = () => store.getState().projectId;

  /**
   * URL сторінки: `/?project=<id>` або `/`; у mock-режимі зберігає `mock`, `speed` тощо.
   * @param {string | null} id
   */
  function pageUrl(id) {
    if (!mock) return id ? `/?project=${encodeURIComponent(id)}` : "/";
    const q = new URLSearchParams(params);
    q.delete("jump");
    q.delete("project");
    if (id) q.set("project", id);
    return `/?${q.toString()}`;
  }

  /** @param {string} url */
  function replaceUrl(url) {
    try {
      globalThis.history?.replaceState(null, "", url);
    } catch (err) {
      console.warn("[actions] history.replaceState", err);
    }
  }

  /**
   * @param {unknown} text
   * @param {boolean} fromComposer скинути чернетку й режим правки після успіху
   */
  async function send(text, fromComposer) {
    const value = String(text ?? "").trim();
    const id = projectId();
    if (!value || !id) return false;
    inflight++;
    ui({ sending: true });
    try {
      await backend.sendMessage(id, value);
      inflight--;
      ui({
        sending: inflight > 0,
        notice: null,
        ...(fromComposer ? { draft: "", editing: false } : {}),
      });
      return true;
    } catch (err) {
      inflight--;
      ui({ sending: inflight > 0, notice: messageOf(err) });
      return false;
    }
  }

  /**
   * @param {CommandBody} body
   * @returns {Promise<boolean>} команду прийнято
   */
  async function command(body) {
    const id = projectId();
    if (!id) return false;
    ui({ notice: null });
    try {
      await backend.sendCommand(id, body);
      return true;
    } catch (err) {
      ui({ notice: messageOf(err) });
      return false;
    }
  }

  /** Затвердження з чернеткою вибору: ЧП1 — `choices`, ЧП3 — лише без незастосованих форматів. */
  async function approve() {
    const state = store.getState();
    if (state.status === CHECKPOINT_STATUS.storyboard && boardFormatsDirty(state)) {
      ui({ notice: APPLY_FORMATS_FIRST });
      return;
    }
    const atBrand = state.status === CHECKPOINT_STATUS.brand;
    const choices = atBrand ? brandChoices(state) : null;
    if (choices === "empty") {
      ui({ notice: NEED_FORMAT });
      return;
    }
    const { pendingFormats, pendingLanguage } = state.ui;
    // `CommandBody` у data/api.js ще без `choices` (Крок 0 додав його лише в API) — звідси приведення.
    const body = /** @type {CommandBody} */ ({
      type: "approve",
      rev: state.rev,
      ...(choices ? { choices } : {}),
    });
    const ok = await command(body);
    if (!ok || !atBrand) return;
    // Чернетку, змінену під час запиту, не скидаємо.
    const now = store.getState().ui;
    ui({
      ...(now.pendingFormats === pendingFormats ? { pendingFormats: null } : {}),
      ...(now.pendingLanguage === pendingLanguage ? { pendingLanguage: null } : {}),
    });
  }

  // Потік даних для маршруту, з яким відкрито сторінку.
  if (mock) {
    const id = params.get("project");
    if (id || params.get("jump")) {
      store.setState({ route: "project", projectId: id ?? store.getState().projectId });
      ready = backend.start(id ?? "");
    }
  } else {
    const id = params.get("project");
    if (id) ready = backend.start(id);
  }

  return {
    get ready() {
      return ready;
    },

    dispose() {
      backend.stop();
    },

    openStream(id) {
      backend.stop();
      store.setState({ ...projectState(id), route: "project" });
      ready = backend.start(id);
      return ready;
    },

    async createProject(form) {
      ui({ sending: true, startError: null, startShortage: null });
      try {
        const id = await backend.createProject(form);
        replaceUrl(pageUrl(id));
        store.setState({ ...projectState(id), route: "project", site: api.hostOf(form.get("url")) });
        ready = backend.start(id);
        void opts.refreshMe?.();
      } catch (err) {
        if (api.isStatus(err, 402)) {
          const body = err instanceof api.ApiError ? err.body : null;
          ui({
            sending: false,
            startShortage: { need: Number(body?.required) || 0, have: Number(body?.available) || 0 },
          });
          return;
        }
        ui({ sending: false, startError: messageOf(err) });
      }
    },

    newProject() {
      backend.stop();
      replaceUrl(pageUrl(null));
      store.setState({ ...projectState(null), route: "start" });
    },

    sendMessage: (text) => send(text, true),

    approve,
    retry: () => command({ type: "retry" }).then(() => {}),
    setLogo: (assetId) => command({ type: "set_logo", assetId }).then(() => {}),
    // Без window.confirm: підтвердженням є сама кнопка «Так, почати заново» в повідомленні.
    confirmRestart: () => command({ type: "restart_confirmed" }).then(() => {}),

    async uploadPhotos(files) {
      const list = Array.from(files ?? []);
      const id = projectId();
      if (!id) return;
      if (list.length === 0) {
        ui({ notice: "Оберіть фото." });
        return;
      }
      ui({ notice: null });
      try {
        await backend.uploadPhotos(id, list);
      } catch (err) {
        ui({ notice: messageOf(err) });
      }
    },

    setFormats(formats) {
      ui({ pendingFormats: canonical(formats) });
    },

    setLanguage(lang) {
      ui({ pendingLanguage: /** @type {Language} */ (lang) });
    },

    async applyFormats() {
      const chosen = store.getState().ui.pendingFormats;
      if (!chosen) return;
      if (chosen.length === 0) {
        ui({ notice: NEED_FORMAT });
        return;
      }
      const ok = await send(`Формати: ${chosen.map((f) => FORMAT_LABELS[f]).join(", ")}`, false);
      // Новіший вибір, зроблений під час надсилання, не скидаємо.
      if (ok && store.getState().ui.pendingFormats === chosen) ui({ pendingFormats: null });
    },

    startEdit() {
      ui({ editing: true });
    },

    setDraft(text) {
      ui({ draft: text });
    },

    setDoneFormat(f) {
      ui({ doneFormat: f });
    },
  };
}
