// @ts-check
/**
 * B2 · Дії і запуск потоку даних.
 *
 * `createActions(store, { params })` повертає `Actions` і сам запускає потік даних для поточного
 * маршруту: `?project=<id>` → GET проєкту + SSE; `?mock=1` → mock-бекенд (data/mock.js), який
 * програє фікстуру подій (з `&jump=…` або `&project=…` — одразу робочий простір).
 * Переходи createProject → project і newProject → start теж робить шар даних.
 *
 * Дії, що шлють повідомлення не з композера (`setFormats`, `setLanguage`, `answer`), не чіпають
 * чернетку `ui.draft` і режим правки — їх скидає лише `sendMessage`.
 */
import { FORMAT_LABELS, FORMATS, FORMATS_DEBOUNCE_MS } from "../contracts.js";
import { initialState } from "../initial.js";
import * as api from "./api.js";
import { createMockBackend } from "./mock.js";
import { reduceAll } from "./reduce.js";
import { connectEvents } from "./sse.js";

/** @typedef {import("../contracts.js").Store} Store */
/** @typedef {import("../contracts.js").Actions} Actions */
/** @typedef {import("../contracts.js").DataOptions} DataOptions */
/** @typedef {import("../contracts.js").UiFlags} UiFlags */
/** @typedef {import("../contracts.js").ChatEvent} ChatEvent */
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
          if (site) store.setState({ site });
        },
        (err) => {
          if (my === session) store.setState((s) => ({ ui: { ...s.ui, notice: messageOf(err) } }));
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
 * @param {Store} store
 * @param {DataOptions & DataDeps} opts
 * @returns {Actions & { readonly ready: Promise<void>, dispose(): void }}
 */
export function createActions(store, opts) {
  const params = opts.params;
  const mock = params.get("mock") === "1";
  /** @type {Backend} */
  const backend =
    opts.backend ??
    (mock
      ? createMockBackend(store, { params })
      : createApiBackend(store, {
          ...(opts.EventSource ? { EventSource: opts.EventSource } : {}),
          ...(opts.batchMs !== undefined ? { batchMs: opts.batchMs } : {}),
        }));

  /** Поточний запуск потоку даних (тести чекають на нього). */
  let ready = Promise.resolve();
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let formatsTimer;
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

  /** @param {CommandBody} body */
  async function command(body) {
    const id = projectId();
    if (!id) return;
    ui({ notice: null });
    try {
      await backend.sendCommand(id, body);
    } catch (err) {
      ui({ notice: messageOf(err) });
    }
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
      clearTimeout(formatsTimer);
      backend.stop();
    },

    async createProject(form) {
      ui({ sending: true, startError: null });
      try {
        const id = await backend.createProject(form);
        replaceUrl(pageUrl(id));
        const base = initialState("project", id);
        store.setState({ ...base, site: api.hostOf(form.get("url")) });
        ready = backend.start(id);
      } catch (err) {
        ui({ sending: false, startError: messageOf(err) });
      }
    },

    newProject() {
      clearTimeout(formatsTimer);
      formatsTimer = undefined;
      backend.stop();
      replaceUrl(pageUrl(null));
      store.setState(initialState("start", null));
    },

    sendMessage: (text) => send(text, true),

    approve: () => command({ type: "approve", rev: store.getState().rev }),
    retry: () => command({ type: "retry" }),
    setLogo: (assetId) => command({ type: "set_logo", assetId }),
    // Без window.confirm: підтвердженням є сама кнопка «Так, почати заново» в повідомленні.
    confirmRestart: () => command({ type: "restart_confirmed" }),

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
      const chosen = FORMATS.filter((f) => formats.includes(f));
      ui({ pendingFormats: chosen });
      clearTimeout(formatsTimer);
      formatsTimer = setTimeout(async () => {
        formatsTimer = undefined;
        if (chosen.length === 0) {
          ui({ notice: "Оберіть хоча б один формат." });
          return;
        }
        await send(`Формати: ${chosen.map((f) => FORMAT_LABELS[f]).join(", ")}`, false);
        // Новіший вибір, зроблений під час надсилання, не скидаємо.
        if (store.getState().ui.pendingFormats === chosen) ui({ pendingFormats: null });
      }, FORMATS_DEBOUNCE_MS);
    },

    setLanguage(lang) {
      void send(`Мова відео: ${lang}`, false);
    },

    answer(text) {
      void send(text, false);
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
