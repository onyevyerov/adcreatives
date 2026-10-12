// @ts-check
/**
 * B4 · Діалог: заголовок з індикатором з'єднання, стрічка (C4, X1) і композер (C5).
 * Композер монтує сам chat.js — app.js про нього не знає.
 *
 * Стрічка інкрементальна: рядки ключуються за `item.id`, `update` дописує нові й патчить змінені
 * (прогрес, стан карток чекпоінтів, живість кнопок), не перебудовуючи список і не скидаючи скрол.
 *
 * Тексти повідомлень: асистент/система можуть містити `**жирний**` — він стає `<strong>` через
 * text-вузли (без розбору HTML); решта розмітки лишається як є. Текст клієнта — дослівно.
 *
 * Живість кнопок: кожну дію (approve/edit/retry/restart_confirm) показує щонайбільше один елемент
 * стрічки — її «власник»; на решті кнопки сховані (історія лишається чистою, як у C4):
 * - approve/edit — лише в статусі awaiting_*; власник — активна картка чекпоінта, інакше
 *   останнє повідомлення з цією кнопкою;
 * - retry — лише в статусі failed; власник — остання помилка, якщо вона retryable, інакше
 *   останнє повідомлення з retry;
 * - restart_confirm — поза busy-статусами, лише якщо це останнє повідомлення з кнопками.
 */
import { AWAITING, BUSY, CHECKPOINT_STATUS, CHECKPOINT_TITLES, ROLE_LABELS } from "../contracts.js";
import { clear, h, text } from "../dom.js";
import * as composer from "./composer.js";

/** @typedef {import("../contracts.js").UiState} UiState */
/** @typedef {import("../contracts.js").Button} Button */
/** @typedef {import("../contracts.js").Actions} Actions */
/** @typedef {import("../contracts.js").Checkpoint} Checkpoint */
/**
 * Локальна копія `FeedItem` з contracts.js: там багаторядковий `@typedef {` + `| …` tsc
 * розбирає як `any`, тож варіанти звужуємо тут (форма — та сама, заморожена).
 * @typedef {{ kind: "message", id: string, at: string, role: "user" | "assistant" | "system", text: string, buttons: Button[] }} MessageItem
 * @typedef {{ kind: "progress", id: string, at: string, stage: string, label: string, done: number | null, total: number | null, running: boolean }} ProgressItem
 * @typedef {{ kind: "checkpoint", id: string, at: string, checkpoint: Checkpoint, rev: number }} CheckpointItem
 * @typedef {{ kind: "error", id: string, at: string, stage: string | null, message: string, retryable: boolean }} ErrorItem
 * @typedef {MessageItem | ProgressItem | CheckpointItem | ErrorItem} FeedItem
 */
/** @typedef {"active" | "approved" | "superseded" | "idle"} CardState */
/** Власники живих дій: id елемента стрічки або null. @typedef {Record<Button, string | null>} Owners */
/** @typedef {{ node: HTMLElement, item: FeedItem, update(item: FeedItem, state: UiState, owners: Owners): void }} Row */

/** Поріг «користувач унизу» для автоскролу, px. */
export const STICK_PX = 80;

/** @type {Record<Button, { label: string, cls: string }>} */
export const BUTTONS = {
  approve: { label: "Затвердити", cls: "btn btn--sm btn--primary" },
  edit: { label: "Правки", cls: "btn btn--sm btn--ghost" },
  retry: { label: "Спробувати ще раз", cls: "btn btn--sm btn--primary" },
  restart_confirm: { label: "Так, почати заново", cls: "btn btn--sm btn--ghost btn--ghost-ink" },
};

/** @type {Record<UiState["conn"], { label: string, dot: string } | null>} */
const CONN = {
  idle: null,
  online: { label: "на зв'язку", dot: "dot--ok" },
  reconnecting: { label: "перепідключаюсь…", dot: "dot--accent dot--pulse" },
  lost: { label: "з'єднання втрачено", dot: "dot--danger" },
};

/** Підказка активної картки (C4). @type {Record<Checkpoint, string>} */
const CHECKPOINT_HINTS = {
  brand: "Палітра, шрифти, лого, факти й питання — праворуч.",
  script: "Тексти сцен і музика — праворуч.",
  storyboard: "Кадри кожної сцени і музика — праворуч.",
};

/**
 * Стан картки чекпоінта: активна — лише поточна ревізія відкритого чекпоінта в його статусі.
 * @param {CheckpointItem} item
 * @param {Pick<UiState, "status" | "checkpoints">} state
 * @returns {CardState}
 */
export function cardState(item, state) {
  const entry = state.checkpoints[item.checkpoint];
  if (!entry) return "idle";
  if (entry.rev > item.rev) return "superseded";
  if (entry.rev !== item.rev) return "idle";
  if (entry.state === "superseded") return "superseded";
  if (entry.state === "approved") return "approved";
  return state.status === CHECKPOINT_STATUS[item.checkpoint] ? "active" : "idle";
}

/**
 * Хто з елементів стрічки показує кожну дію (див. шапку файлу).
 * @param {Pick<UiState, "status" | "checkpoints" | "feed">} state
 * @returns {Owners}
 */
export function liveOwners(state) {
  /** @type {Owners} */
  const owners = { approve: null, edit: null, retry: null, restart_confirm: null };
  const { status } = state;
  const feed = /** @type {FeedItem[]} */ (state.feed);
  /** @param {Button} b @param {number} [from] шукати лише з цього індексу @returns {string | null} */
  const lastMessageWith = (b, from = 0) => {
    for (let i = feed.length - 1; i >= from; i--) {
      const it = feed[i];
      if (it?.kind === "message" && it.buttons.includes(b)) return it.id;
    }
    return null;
  };

  if (AWAITING.includes(status)) {
    const card = feed.findLast((it) => it.kind === "checkpoint" && cardState(it, state) === "active");
    owners.approve = card ? card.id : lastMessageWith("approve");
    owners.edit = card ? card.id : lastMessageWith("edit");
  }
  if (status === "failed") {
    const i = feed.findLastIndex((it) => it.kind === "error");
    const err = feed[i];
    owners.retry = err?.kind === "error" && err.retryable ? err.id : lastMessageWith("retry", Math.max(i, 0));
  }
  if (!BUSY.includes(status)) {
    const last = feed.findLast((it) => it.kind === "message" && it.buttons.length > 0);
    if (last?.kind === "message" && last.buttons.includes("restart_confirm"))
      owners.restart_confirm = last.id;
  }
  return owners;
}

/** @param {string} at @returns {string} HH:MM за місцевим часом або "" */
export function clock(at) {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * Текст повідомлення: рядки через `<br>`, `**…**` → `<strong>` (лише text-вузли).
 * @param {string} value
 * @param {boolean} rich
 * @returns {Node[]}
 */
export function richText(value, rich) {
  /** @type {Node[]} */
  const out = [];
  String(value)
    .split("\n")
    .forEach((line, i) => {
      if (i > 0) out.push(h("br"));
      if (!rich) {
        out.push(document.createTextNode(line));
        return;
      }
      const parts = line.split(/\*\*(\S(?:.*?\S)?)\*\*/);
      parts.forEach((part, j) => {
        if (!part) return;
        out.push(j % 2 ? h("strong", null, part) : document.createTextNode(part));
      });
    });
  return out;
}

/**
 * Кнопка дії з `buttons[]`; поки дія виконується — неактивна (захист від подвійного натискання).
 * @param {Button} b
 * @param {Actions} actions
 */
function actionButton(b, actions) {
  const spec = BUTTONS[b];
  const btn = h("button", { type: "button", class: spec.cls, "data-action": b, text: spec.label });
  btn.addEventListener("click", async () => {
    if (btn.disabled) return;
    btn.disabled = true;
    try {
      if (b === "approve") await actions.approve();
      else if (b === "edit") actions.startEdit();
      else if (b === "retry") await actions.retry();
      else await actions.confirmRestart();
    } catch (err) {
      console.error(`[chat] ${b}`, err);
    } finally {
      btn.disabled = false;
    }
  });
  return btn;
}

/**
 * Ряд кнопок: показує лише ті, власник яких — цей елемент.
 * @param {Button[]} list
 * @param {Actions} actions
 */
function buttonRow(list, actions) {
  const btns = list.filter((b) => b in BUTTONS).map((b) => actionButton(b, actions));
  const node = h("div", { class: "ch-actions", hidden: true }, btns);
  return {
    node,
    /** @param {string} id @param {Owners} owners */
    update(id, owners) {
      let any = false;
      for (const btn of btns) {
        const live = owners[/** @type {Button} */ (btn.dataset.action)] === id;
        if (btn.hidden === live) btn.hidden = !live;
        any ||= live;
      }
      if (node.hidden === any) node.hidden = !any;
    },
  };
}

/** @param {MessageItem} item @param {Actions} actions @returns {Row} */
function messageRow(item, actions) {
  const isUser = item.role === "user";
  const body = h("div", { class: isUser ? "ch-bubble" : "ch-msg__text" });
  const meta = isUser ? null : h("div", { class: "ch-msg__meta" });
  const row = buttonRow(item.buttons, actions);
  const node = h(
    "div",
    {
      class: `ch-item ch-msg ch-msg--${item.role}`,
      "data-id": item.id,
      "data-kind": "message",
      "data-role": item.role,
      "aria-label": isUser ? ROLE_LABELS.user : null,
    },
    meta,
    body,
    row.node,
  );
  /** @type {MessageItem | null} */
  let shown = null;
  /** @type {Row} */
  const r = {
    node,
    item,
    update(next, _state, owners) {
      const msg = /** @type {MessageItem} */ (next);
      if (!shown || shown.text !== msg.text) {
        clear(body);
        body.append(...richText(msg.text, !isUser));
      }
      if (meta && (!shown || shown.at !== msg.at || shown.role !== msg.role)) {
        const time = clock(msg.at);
        text(meta, `${ROLE_LABELS[msg.role] ?? msg.role}${time ? ` · ${time}` : ""}`);
      }
      if (isUser) node.title = clock(msg.at);
      row.update(msg.id, owners);
      shown = msg;
      r.item = msg;
    },
  };
  return r;
}

/** @param {ProgressItem} item @returns {string} лічильник, якщо мітка його ще не містить */
function progressCount(item) {
  if (item.total === null || item.total === undefined) return "";
  if (/\d\s*\/\s*\d|%/.test(item.label)) return "";
  return `${item.done ?? 0}/${item.total}`;
}

/** @param {ProgressItem} item @returns {Row} */
function progressRow(item) {
  const mark = h("span", { class: "ch-progress__mark", "aria-hidden": "true" });
  const label = h("span", { class: "ch-progress__label" });
  const count = h("span", { class: "ch-progress__count" });
  const node = h(
    "div",
    { class: "ch-item ch-progress", "data-id": item.id, "data-kind": "progress" },
    mark,
    label,
    count,
  );
  /** @type {boolean | null} */
  let running = null;
  /** @type {Row} */
  const r = {
    node,
    item,
    update(next) {
      const p = /** @type {ProgressItem} */ (next);
      if (running !== p.running) {
        running = p.running;
        clear(mark);
        if (p.running) mark.append(h("span", { class: "spinner" }));
        else mark.append("✓");
        node.classList.toggle("is-running", p.running);
        node.dataset.state = p.running ? "running" : "done";
      }
      text(label, p.label);
      const c = progressCount(p);
      text(count, c);
      count.hidden = !c;
      r.item = p;
    },
  };
  return r;
}

/** @param {CheckpointItem} item @param {Actions} actions @returns {Row} */
function checkpointRow(item, actions) {
  const diamond = h("span", { class: "diamond diamond--sm", "aria-hidden": "true" });
  const title = h("span", { class: "ch-card__title" });
  const rev = h("span", { class: "ch-card__rev" });
  const hint = h("div", { class: "ch-card__hint", hidden: true });
  const status = h("div", { class: "ch-card__status", hidden: true });
  const row = buttonRow(["approve", "edit"], actions);
  const node = h(
    "div",
    { class: "ch-item ch-card", "data-id": item.id, "data-kind": "checkpoint" },
    h("div", { class: "ch-card__head" }, diamond, title, rev),
    hint,
    status,
    row.node,
  );
  /** @type {CardState | null} */
  let shown = null;
  /** @type {Row} */
  const r = {
    node,
    item,
    update(next, state, owners) {
      const cp = /** @type {CheckpointItem} */ (next);
      text(title, CHECKPOINT_TITLES[cp.checkpoint] ?? cp.checkpoint);
      text(rev, `· рев. ${cp.rev}`);
      const st = cardState(cp, state);
      if (st !== shown) {
        shown = st;
        node.dataset.state = st;
        node.classList.toggle("ch-card--active", st === "active");
        diamond.classList.toggle("diamond--open", st === "active");
        diamond.classList.toggle("diamond--done", st === "approved");
        diamond.classList.toggle("diamond--stale", st === "superseded");
        text(hint, CHECKPOINT_HINTS[cp.checkpoint] ?? "");
        hint.hidden = st !== "active";
        text(
          status,
          st === "approved" ? "✓ Затверджено" : st === "superseded" ? "Замінено новою ревізією" : "",
        );
        status.hidden = st !== "approved" && st !== "superseded";
        status.classList.toggle("ch-card__status--stale", st === "superseded");
      }
      row.update(cp.id, owners);
      r.item = cp;
    },
  };
  return r;
}

/** @param {ErrorItem} item @param {Actions} actions @returns {Row} */
function errorRow(item, actions) {
  const eyebrow = h("span");
  const msg = h("div", { class: "ch-error__text" });
  const row = buttonRow(["retry"], actions);
  const node = h(
    "div",
    { class: "ch-item ch-error", "data-id": item.id, "data-kind": "error", role: "alert" },
    h(
      "div",
      { class: "ch-error__head" },
      h("span", { class: "dot dot--danger", "aria-hidden": "true" }),
      eyebrow,
    ),
    msg,
    row.node,
  );
  /** @type {Row} */
  const r = {
    node,
    item,
    update(next, _state, owners) {
      const e = /** @type {ErrorItem} */ (next);
      text(eyebrow, e.stage ? `Помилка · ${e.stage}` : "Помилка");
      text(
        msg,
        e.stage ? `Щось пішло не так на етапі «${e.stage}»: ${e.message}` : `Щось пішло не так: ${e.message}`,
      );
      row.update(e.id, owners);
      r.item = e;
    },
  };
  return r;
}

/** @param {FeedItem} item @param {Actions} actions @returns {Row} */
function createRow(item, actions) {
  switch (item.kind) {
    case "message":
      return messageRow(item, actions);
    case "progress":
      return progressRow(item);
    case "checkpoint":
      return checkpointRow(item, actions);
    default:
      return errorRow(item, actions);
  }
}

/** @type {import("../contracts.js").MountFn} */
export function mount(el, ctx) {
  const { actions } = ctx;
  const connDot = h("span", { class: "dot dot--sm", "aria-hidden": "true" });
  const connLabel = h("span");
  const conn = h("span", { class: "ch-conn", role: "status", "aria-live": "polite" }, connDot, connLabel);
  const head = h(
    "header",
    { class: "ch-head" },
    h("h2", { class: "display-s ch-title", text: "Діалог" }),
    conn,
  );
  const list = h("div", { class: "ch-list", role: "log", "aria-label": "Стрічка діалогу" });
  const feed = h("div", { class: "ch-feed" }, list);
  const slot = h("div", { class: "ch-composer-slot", "data-slot": "composer" });
  const root = h("div", { class: "ch" }, head, feed, slot);
  el.append(root);

  /** @type {Map<string, Row>} */
  const rows = new Map();

  /** @param {UiState["conn"]} c */
  function renderConn(c) {
    const spec = CONN[c] ?? null;
    conn.hidden = !spec;
    conn.dataset.conn = c;
    connDot.className = `dot dot--sm ${spec?.dot ?? ""}`.trim();
    text(connLabel, spec?.label ?? "");
  }

  function atBottom() {
    return feed.scrollHeight - feed.scrollTop - feed.clientHeight <= STICK_PX;
  }

  /** @param {UiState} state @param {boolean} animate @returns {boolean} чи додано нові рядки */
  function renderFeed(state, animate) {
    const owners = liveOwners(state);
    const seen = new Set();
    let added = false;
    /** @type {ChildNode | null} */
    let cursor = list.firstChild;
    for (const item of /** @type {FeedItem[]} */ (state.feed)) {
      seen.add(item.id);
      let row = rows.get(item.id);
      if (!row || row.item.kind !== item.kind) {
        row?.node.remove();
        row = createRow(item, actions);
        if (animate) row.node.classList.add("ch-enter");
        rows.set(item.id, row);
        added = true;
      }
      row.update(item, state, owners);
      if (row.node === cursor) cursor = cursor.nextSibling;
      else list.insertBefore(row.node, cursor);
    }
    for (const [id, row] of rows) {
      if (!seen.has(id)) {
        row.node.remove();
        rows.delete(id);
      }
    }
    return added;
  }

  // «Прилипання» до низу між оновленнями стану: шрифти, що довантажились, і зміна висоти
  // композера міняють розміри без нових елементів — тоді тримаємо низ, якщо користувач там був.
  let stuck = true;
  const toBottom = () => {
    feed.scrollTop = feed.scrollHeight;
    stuck = true;
  };
  feed.addEventListener("scroll", () => {
    stuck = atBottom();
  });
  const resize =
    typeof ResizeObserver === "function"
      ? new ResizeObserver(() => {
          if (stuck) feed.scrollTop = feed.scrollHeight;
        })
      : null;
  resize?.observe(list);
  resize?.observe(feed);

  const initial = ctx.store.getState();
  renderConn(initial.conn);
  renderFeed(initial, false);
  const composerView = composer.mount(slot, ctx);
  toBottom();

  return {
    update(state, prev) {
      if (state.conn !== prev.conn) renderConn(state.conn);
      if (
        state.feed !== prev.feed ||
        state.status !== prev.status ||
        state.checkpoints !== prev.checkpoints
      ) {
        const stick = atBottom();
        const added = renderFeed(state, true);
        if (added && stick) toBottom();
      }
      composerView.update(state, prev);
    },
    destroy() {
      resize?.disconnect();
      composerView.destroy();
      rows.clear();
      root.remove();
    },
  };
}
