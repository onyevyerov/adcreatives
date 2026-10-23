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
 *
 * B6 · кредити в чаті (N6-A, N7-A). Повідомлення білінгу (`parseCreditMessage`) показуються
 * дослівно, як звичайні. Під живою відмовою — K3 (`shortageCard`, size chat) у рядку того ж
 * повідомлення; жива — лише остання відмова, після якої не було ні іншого повідомлення білінгу,
 * ні нової картки чекпоінта, і проєкт досі там, де відмовили (ЧП3 з доплатою / «готово»).
 * `ui.retry` (кладе B8 після оплати) → картка «Баланс поповнено» з «Повторити» в кінці стрічки.
 * Активна картка ЧП3 з доплатою за формати — «Затвердити · N кредитів»; до першої видачі під
 * кнопками активної картки — «правки до видачі — безкоштовно» (Референс показує на кожній).
 * Ціни — лише `account.prices`, оплачені формати — `paidFormats(projectCredits)`.
 *
 * Прогрес (`chatFeed`): рядки progress поспіль — один busy-відрізок — у чаті один рядок з id
 * першого: поточний крок зі спінером, після завершення — ✓ з підсумком чекпоінта, що за ним
 * («Сценарій написано»), або з останньою міткою. Детальний чекліст підкроків — у центральній
 * панелі (stage-progress.js), вона читає `state.feed` як є.
 */
import {
  AWAITING,
  BUSY,
  CHECKPOINT_STATUS,
  CHECKPOINT_TITLES,
  FORMAT_LABELS,
  FORMATS,
  ROLE_LABELS,
} from "../contracts.js";
import { clear, h, text } from "../dom.js";
import { parseCreditMessage } from "../lib/credit-messages.js";
import {
  closingPackage,
  customFor,
  extraFormatsCharge,
  formatCredits,
  formatNumber,
  paidFormats,
} from "../lib/credits.js";
import * as composer from "./composer.js";
import { emptyChatText } from "./session.js";
import { shortageCard } from "./shortage.js";

/** @typedef {import("../contracts.js").UiState} UiState */
/** @typedef {import("../contracts.js").Button} Button */
/** @typedef {import("../contracts.js").Actions} Actions */
/** @typedef {import("../contracts.js").Checkpoint} Checkpoint */
/**
 * Локальна копія `FeedItem` з contracts.js: там багаторядковий `@typedef {` + `| …` tsc
 * розбирає як `any`, тож варіанти звужуємо тут (форма — та сама, заморожена).
 * @typedef {{ kind: "message", id: string, at: string, role: "user" | "assistant" | "system", text: string, buttons: Button[] }} MessageItem
 * @typedef {{ kind: "progress", id: string, at: string, stage: string, label: string, done: number | null, total: number | null, running: boolean, step?: string }} ProgressItem
 * @typedef {{ kind: "checkpoint", id: string, at: string, checkpoint: Checkpoint, rev: number }} CheckpointItem
 * @typedef {{ kind: "error", id: string, at: string, stage: string | null, message: string, retryable: boolean }} ErrorItem
 * @typedef {MessageItem | ProgressItem | CheckpointItem | ErrorItem} FeedItem
 */
/** @typedef {"active" | "approved" | "superseded" | "idle"} CardState */
/** Власники живих дій: id елемента стрічки або null. @typedef {Record<Button, string | null>} Owners */
/** @typedef {import("../contracts.js").Format} Format */
/**
 * Жива відмова білінгу: під нею K3. `text` — правка, на яку відмовили (лише rev);
 * `formats` — поточні формати ЧП3 (для «Лишити один формат»).
 * @typedef {{ id: string, ctx: "cp3" | "rev", need: number, have: number, text: string | null, formats: Format[] }} Refusal
 */
/** @typedef {{ need: number, extra: Format[], paid: Format[] }} Charge */
/**
 * Те, що рядки беруть зі стану стрічки цілком (рахується раз на рендер).
 * @typedef {{ owners: Owners, refusal: Refusal | null, charge: Charge, beforeDelivery: boolean }} Live
 */
/** @typedef {{ node: HTMLElement, item: FeedItem, update(item: FeedItem, state: UiState, live: Live): void }} Row */

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

/** Підпис завершеного прогресу, за яким іде картка чекпоінта. @type {Record<Checkpoint, string>} */
export const PROGRESS_DONE = {
  brand: "Бренд-кіт готовий",
  script: "Сценарій написано",
  storyboard: "Розкадровку зібрано",
};

/**
 * Підсумок завершеного відрізка: картка чекпоінта, що йде за ним (повідомлення між ними — текст
 * чекпоінта), інакше null — лишається остання мітка (збій, видача, кінець стрічки).
 * @param {readonly FeedItem[]} feed
 * @param {number} from індекс першого елемента після відрізка
 * @returns {string | null}
 */
function progressDoneLabel(feed, from) {
  for (let i = from; i < feed.length; i++) {
    const it = feed[i];
    if (it?.kind === "message") continue;
    return it?.kind === "checkpoint" ? (PROGRESS_DONE[it.checkpoint] ?? null) : null;
  }
  return null;
}

/**
 * Стрічка для чату: кожен busy-відрізок (рядки progress поспіль) — один рядок progress з id
 * першого (вузол не перебудовується, коли приходять нові кроки) і даними останнього.
 * @param {readonly FeedItem[]} feed
 * @returns {FeedItem[]}
 */
export function chatFeed(feed) {
  /** @type {FeedItem[]} */
  const out = [];
  for (let i = 0; i < feed.length; i++) {
    const first = feed[i];
    if (!first) continue;
    if (first.kind !== "progress") {
      out.push(first);
      continue;
    }
    let end = i;
    let running = first.running;
    for (let next = feed[end + 1]; next?.kind === "progress"; next = feed[end + 1]) {
      running ||= next.running;
      end++;
    }
    const last = /** @type {ProgressItem} */ (feed[end]);
    const done = running ? null : progressDoneLabel(feed, end + 1);
    out.push(
      done
        ? { ...last, id: first.id, label: done, done: null, total: null, running }
        : end === i
          ? first
          : { ...last, id: first.id, running },
    );
    i = end;
  }
  return out;
}

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

/**
 * Текст останнього повідомлення клієнта перед елементом стрічки `before` (не включно) — правка,
 * на яку відмовив білінг. Без `before` — шукати з кінця.
 * @param {readonly FeedItem[]} feed
 * @param {number} [before]
 * @returns {string | null}
 */
export function userTextBefore(feed, before = feed.length) {
  for (let i = Math.min(before, feed.length) - 1; i >= 0; i--) {
    const it = feed[i];
    if (it?.kind === "message" && it.role === "user" && it.text) return it.text;
  }
  return null;
}

/**
 * Текст правки для повтору, якщо його не донесли з оплати: останнє повідомлення клієнта перед
 * останньою відмовою білінгу.
 * @param {readonly FeedItem[]} feed
 * @returns {string | null}
 */
export function lastRefusedText(feed) {
  for (let i = feed.length - 1; i >= 0; i--) {
    const it = feed[i];
    if (it?.kind !== "message" || it.role === "user") continue;
    const kind = parseCreditMessage(it.text)?.kind;
    if (kind === "insufficient" || kind === "insufficientFormats") return userTextBefore(feed, i);
  }
  return null;
}

/**
 * Формати ЧП3: незавершений вибір клієнта («Лишити один формат») або формати розкадровки
 * (основний + аркуші інших), у канонічному порядку — перший у ціні ролика, як на бекенді.
 * @param {Pick<UiState, "ui" | "checkpoints">} state
 * @returns {Format[]}
 */
export function storyboardFormats(state) {
  if (state.ui.pendingFormats) return FORMATS.filter((f) => state.ui.pendingFormats?.includes(f));
  const payload = state.checkpoints.storyboard?.payload;
  if (payload?.checkpoint !== "storyboard") return [];
  const list = [payload.primaryFormat, ...(payload.sheets ?? []).map((s) => s.format)];
  return FORMATS.filter((f) => list.includes(f));
}

/**
 * Доплата за формати на ЧП3. Списують лише до першої видачі (потім формати вже оплачені) і лише
 * за відомими цінами.
 * @param {Pick<UiState, "ui" | "checkpoints" | "account" | "projectCredits" | "artifacts">} state
 * @returns {Charge}
 */
export function storyboardCharge(state) {
  const prices = state.account.prices;
  if (!prices || state.artifacts.videos.length > 0) return { need: 0, extra: [], paid: [] };
  return extraFormatsCharge(storyboardFormats(state), paidFormats(state.projectCredits), prices);
}

/**
 * Відмова, під якою K3: остання відмова білінгу у стрічці, якщо після неї не було іншого
 * повідомлення білінгу (успішного списання чи нової відмови) і нової картки чекпоінта, а проєкт
 * досі там, де відмовили: формати — ЧП3 з доплатою, правка — «готово».
 * @param {Pick<UiState, "feed" | "status" | "ui" | "checkpoints" | "account" | "projectCredits" | "artifacts">} state
 * @returns {Refusal | null}
 */
export function liveRefusal(state) {
  const feed = /** @type {FeedItem[]} */ (state.feed);
  for (let i = feed.length - 1; i >= 0; i--) {
    const it = feed[i];
    if (it?.kind === "checkpoint") return null;
    if (it?.kind !== "message" || it.role === "user") continue;
    const msg = parseCreditMessage(it.text);
    if (!msg) continue;
    if (msg.kind !== "insufficient" && msg.kind !== "insufficientFormats") return null;
    // `insufficient` на ЧП3 — гонка списання формату в драйвері: та сама відмова за формати.
    const ctx = msg.kind === "insufficientFormats" || state.status === "awaiting_storyboard" ? "cp3" : "rev";
    if (ctx === "cp3") {
      if (state.status !== "awaiting_storyboard") return null;
      if (state.account.prices && storyboardCharge(state).need === 0) return null;
    } else if (state.status !== "delivered") return null;
    return {
      id: it.id,
      ctx,
      need: msg.need,
      have: msg.have,
      text: ctx === "rev" ? userTextBefore(feed, i) : null,
      formats: ctx === "cp3" ? storyboardFormats(state) : [],
    };
  }
  return null;
}

/**
 * Опис дії в картці «Баланс поповнено».
 * @param {NonNullable<UiState["ui"]["retry"]>} retry
 * @param {UiState} state
 * @returns {string}
 */
export function retryText(retry, state) {
  const prices = state.account.prices;
  if (retry.ctx === "cp3") {
    const { need, extra } = storyboardCharge(state);
    if (need <= 0) return "Затверджу розкадровку ще раз.";
    return `Затверджу розкадровку ще раз — спишу ${formatCredits(need)} за ${extra.map((f) => FORMAT_LABELS[f]).join(", ")}.`;
  }
  const edit = retry.text ?? lastRefusedText(/** @type {FeedItem[]} */ (state.feed));
  const price = prices ? ` — ${formatCredits(prices.revision)}` : "";
  return edit ? `Надішлю правку ще раз: «${edit}»${price}.` : `Надішлю правку ще раз${price}.`;
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
    /** Підпис кнопки дії (сума в «Затвердити» на ЧП3). @param {Button} b @param {string} label */
    label(b, label) {
      const btn = btns.find((x) => x.dataset.action === b);
      if (btn && btn.textContent !== label) btn.textContent = label;
    },
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
  /** K3 під відмовою і ключ його вмісту. @type {{ node: HTMLElement, key: string } | null} */
  let shortage = null;
  /** @type {Row} */
  const r = {
    node,
    item,
    update(next, state, live) {
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
      row.update(msg.id, live.owners);
      const refusal = live.refusal?.id === msg.id ? live.refusal : null;
      const spec = refusal ? shortageSpec(refusal, state) : null;
      if (shortage && shortage.key !== spec?.key) {
        shortage.node.remove();
        shortage = null;
      }
      if (refusal && spec && !shortage) {
        shortage = { node: refusalCard(refusal, spec, actions), key: spec.key };
        node.append(shortage.node);
      }
      shown = msg;
      r.item = msg;
    },
  };
  return r;
}

/**
 * Пакет і своя сума, що закривають нестачу (з `me`; без `me` — лише порада про повернення).
 * @param {Refusal} refusal
 * @param {UiState} state
 */
function shortageSpec(refusal, state) {
  const me = state.account.me;
  const short = Math.max(0, refusal.need - refusal.have);
  const pkg = me?.packages?.length ? closingPackage(me.packages, short) : null;
  const custom = me?.custom ? customFor(short, me.custom) : null;
  const key = [
    refusal.ctx,
    refusal.need,
    refusal.have,
    refusal.text,
    refusal.formats.join(","),
    pkg?.id,
    pkg?.credits,
    custom,
  ].join("|");
  return { pkg, custom, key };
}

/**
 * K3 у чаті: «Поповнити» → кабінет з поверненням сюди; для форматів — ще «Лишити один формат».
 * @param {Refusal} refusal
 * @param {ReturnType<typeof shortageSpec>} spec
 * @param {Actions} actions
 */
function refusalCard(refusal, { pkg, custom }, actions) {
  const closes = pkg
    ? `Різницю закриє пакет «${pkg.label}» — ${formatCredits(pkg.credits)}${custom !== null ? ` або своя сума від ${formatNumber(custom)}` : ""}. `
    : "";
  const card = shortageCard({
    title: refusal.ctx === "cp3" ? "Не вистачає на формати" : "Не вистачає на правку",
    need: refusal.need,
    have: refusal.have,
    size: "chat",
    advice: `${closes}Після оплати поверну сюди — натисніть «Повторити».`,
    primary: {
      label: "Поповнити",
      onClick: () =>
        actions.openTopup({
          from: "ws",
          ctx: refusal.ctx,
          text: refusal.text,
          ...(pkg ? { packageId: pkg.id } : {}),
        }),
    },
    secondary:
      refusal.ctx === "cp3" && refusal.formats.length > 1
        ? {
            label: "Лишити один формат",
            onClick: () => actions.setFormats(refusal.formats.slice(0, 1)),
          }
        : undefined,
  });
  card.classList.add("ch-shortage");
  return card;
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
  const free = h("div", { class: "ch-card__free", hidden: true, text: "правки до видачі — безкоштовно" });
  const node = h(
    "div",
    { class: "ch-item ch-card", "data-id": item.id, "data-kind": "checkpoint" },
    h("div", { class: "ch-card__head" }, diamond, title, rev),
    hint,
    status,
    row.node,
    free,
  );
  /** @type {CardState | null} */
  let shown = null;
  /** @type {Row} */
  const r = {
    node,
    item,
    update(next, state, live) {
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
      row.update(cp.id, live.owners);
      const need = cp.checkpoint === "storyboard" && st === "active" ? live.charge.need : 0;
      row.label(
        "approve",
        need > 0 ? `${BUTTONS.approve.label} · ${formatCredits(need)}` : BUTTONS.approve.label,
      );
      const showFree = live.owners.approve === cp.id && live.beforeDelivery;
      if (free.hidden === showFree) free.hidden = !showFree;
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
    update(next, _state, live) {
      const e = /** @type {ErrorItem} */ (next);
      text(eyebrow, e.stage ? `Помилка · ${e.stage}` : "Помилка");
      text(
        msg,
        e.stage ? `Щось пішло не так на етапі «${e.stage}»: ${e.message}` : `Щось пішло не так: ${e.message}`,
      );
      row.update(e.id, live.owners);
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

/**
 * Картка «Баланс поповнено · +N · тепер M» з «Повторити» (`ui.retry` після оплати, N6-A).
 * @param {Actions} actions
 */
function retryCard(actions) {
  const head = h("span");
  const desc = h("div", { class: "ch-retry__text" });
  const btn = h("button", {
    type: "button",
    class: "btn btn--sm btn--primary ch-retry__btn",
    text: "Повторити",
  });
  btn.addEventListener("click", async () => {
    if (btn.disabled) return;
    btn.disabled = true;
    try {
      await actions.retryAfterTopup();
    } catch (err) {
      console.error("[chat] retryAfterTopup", err);
    } finally {
      btn.disabled = false;
    }
  });
  const node = h(
    "div",
    { class: "ch-retry" },
    h(
      "div",
      { class: "ch-retry__head" },
      h("span", { class: "ch-retry__diamond", "aria-hidden": "true" }),
      head,
    ),
    desc,
    btn,
  );
  return {
    node,
    /** @param {NonNullable<UiState["ui"]["retry"]>} retry @param {UiState} state */
    update(retry, state) {
      const balance = state.account.me?.balance;
      text(
        head,
        `Баланс поповнено · +${formatNumber(retry.plus)}${typeof balance === "number" ? ` · тепер ${formatNumber(balance)}` : ""}`,
      );
      text(desc, retryText(retry, state));
    },
  };
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
  const empty = h("p", { class: "ch-empty", hidden: true });
  const feed = h("div", { class: "ch-feed" }, empty, list);
  const slot = h("div", { class: "ch-composer-slot", "data-slot": "composer" });
  const root = h("div", { class: "ch" }, head, feed, slot);
  el.append(root);

  /** @type {Map<string, Row>} */
  const rows = new Map();
  /** @type {ReturnType<typeof retryCard> | null} */
  let retry = null;

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
    const charge = storyboardCharge(state);
    /** @type {Live} */
    const live = {
      owners: liveOwners(state),
      refusal: liveRefusal(state),
      charge,
      beforeDelivery: state.artifacts.videos.length === 0,
    };
    const seen = new Set();
    let added = false;
    /** @type {ChildNode | null} */
    let cursor = list.firstChild;
    for (const item of chatFeed(/** @type {FeedItem[]} */ (state.feed))) {
      seen.add(item.id);
      let row = rows.get(item.id);
      if (!row || row.item.kind !== item.kind) {
        row?.node.remove();
        row = createRow(item, actions);
        if (animate) row.node.classList.add("ch-enter");
        rows.set(item.id, row);
        added = true;
      }
      row.update(item, state, live);
      if (row.node === cursor) cursor = cursor.nextSibling;
      else list.insertBefore(row.node, cursor);
    }
    for (const [id, row] of rows) {
      if (!seen.has(id)) {
        row.node.remove();
        rows.delete(id);
      }
    }
    const emptyText = state.feed.length === 0 ? emptyChatText(state) : null;
    text(empty, emptyText ?? "");
    if (empty.hidden === Boolean(emptyText)) empty.hidden = !emptyText;
    // «Повторити» — завжди останнім у стрічці.
    const r = state.ui.retry;
    if (!r && retry) {
      retry.node.remove();
      retry = null;
    } else if (r) {
      if (!retry) {
        retry = retryCard(actions);
        if (animate) retry.node.classList.add("ch-enter");
        added = true;
      }
      retry.update(r, state);
      if (list.lastChild !== retry.node) list.append(retry.node);
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
        state.checkpoints !== prev.checkpoints ||
        state.ui.retry !== prev.ui.retry ||
        state.ui.pendingFormats !== prev.ui.pendingFormats ||
        state.account.me !== prev.account.me ||
        state.account.prices !== prev.account.prices ||
        state.projectCredits !== prev.projectCredits ||
        state.artifacts !== prev.artifacts ||
        state.session !== prev.session
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
      retry = null;
      root.remove();
    },
  };
}
