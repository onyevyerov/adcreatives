// @ts-check
/**
 * B2 · SSE подій чату з відновленням (логіка перенесена з попереднього index.html без змін):
 * - браузер сам перепідключається й шле `Last-Event-ID`, поки EventSource у стані CONNECTING;
 * - якщо EventSource закрився (CLOSED) — через 3 с створюємо новий і передаємо останній ID
 *   параметром `?lastEventId=` (заголовок при ручному створенні не відправити);
 * - подія чату `error` теж приходить в `onerror` (той самий тип) — її впізнаємо за рядком у
 *   `data` і ігноруємо, бо її вже обробив слухач подій.
 *
 * Статус з'єднання: `online` — відкрито; `reconnecting` — CONNECTING (авто- або ручне
 * перепідключення); `lost` — CLOSED, чекаємо таймер.
 *
 * Повтори й події не по порядку відсікає `createEventGate` (ID стріму Redis монотонні).
 */
import { EVENT_TYPES } from "../contracts.js";
import { projectPath } from "./api.js";
import { createEventGate } from "./reduce.js";

/** @typedef {import("../contracts.js").ChatEvent} ChatEvent */
/** @typedef {import("../contracts.js").UiState["conn"]} Conn */
/**
 * Мінімум EventSource, який потрібен модулю (тести підставляють фейк).
 * @typedef {{
 *   readonly readyState: number,
 *   onopen: ((ev: Event) => unknown) | null,
 *   onerror: ((ev: Event) => unknown) | null,
 *   addEventListener(type: string, fn: (ev: MessageEvent) => void): void,
 *   close(): void
 * }} EventSourceLike
 * @typedef {{ new (url: string): EventSourceLike, readonly CONNECTING: number, readonly OPEN: number, readonly CLOSED: number }} EventSourceCtor
 */

/** Затримка ручного перепідключення після CLOSED, мс. */
export const RECONNECT_MS = 3000;

/**
 * Підписка на події проєкту.
 * @param {{
 *   projectId: string,
 *   onEvent: (id: string, event: ChatEvent) => void,
 *   onConn?: (conn: Conn) => void,
 *   EventSource?: EventSourceCtor,
 *   lastEventId?: string | null,
 *   reconnectMs?: number
 * }} opts
 * @returns {{ close(): void, readonly lastEventId: string | null }}
 */
export function connectEvents(opts) {
  const MaybeES = opts.EventSource ?? /** @type {EventSourceCtor | undefined} */ (globalThis.EventSource);
  if (!MaybeES) throw new Error("Браузер не підтримує живі оновлення (EventSource).");
  /** @type {EventSourceCtor} */
  const ES = MaybeES;
  const onConn = opts.onConn ?? (() => {});
  const reconnectMs = opts.reconnectMs ?? RECONNECT_MS;
  const gate = createEventGate(opts.lastEventId ?? null);
  /** @type {EventSourceLike | null} */
  let source = null;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let reconnectTimer;
  let closed = false;
  let localSeq = 0;

  /** @param {MessageEvent} e */
  function onMessage(e) {
    if (closed) return;
    const id = e.lastEventId || `local-${++localSeq}`;
    if (!gate.accept(id)) return;
    /** @type {ChatEvent} */
    let event;
    try {
      event = JSON.parse(e.data);
    } catch {
      return;
    }
    if (!event || typeof event !== "object" || !EVENT_TYPES.includes(event.type)) return;
    opts.onEvent(id, event);
  }

  /** @param {boolean} manual */
  function connect(manual) {
    clearTimeout(reconnectTimer);
    if (closed) return;
    if (source) source.close();
    // Браузер сам шле Last-Event-ID при автоперепідключенні; коли перестворюємо EventSource
    // вручну — передаємо його параметром.
    const last = gate.last;
    const url =
      projectPath(opts.projectId, "/events") + (last ? `?lastEventId=${encodeURIComponent(last)}` : "");
    const es = new ES(url);
    source = es;
    if (manual) onConn("reconnecting");
    for (const type of EVENT_TYPES) es.addEventListener(type, onMessage);
    es.onopen = () => {
      if (source === es) onConn("online");
    };
    es.onerror = (e) => {
      if (source !== es || closed) return;
      // Подія чату `error` теж приходить сюди (той самий тип) — її вже обробив onMessage.
      if (typeof (/** @type {MessageEvent} */ (e).data) === "string") return;
      if (es.readyState === ES.OPEN) return;
      if (es.readyState === ES.CLOSED) {
        onConn("lost");
        reconnectTimer = setTimeout(() => connect(true), reconnectMs);
      } else {
        onConn("reconnecting");
      }
    };
  }

  connect(false);

  return {
    close() {
      closed = true;
      clearTimeout(reconnectTimer);
      if (source) source.close();
      source = null;
    },
    get lastEventId() {
      return gate.last;
    },
  };
}
