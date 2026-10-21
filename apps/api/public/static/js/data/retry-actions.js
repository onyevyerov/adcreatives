// @ts-check
/**
 * B6 · «Повторити» після поповнення (N6-A).
 *
 * `ui.retry` кладе B8, коли клієнт повертається з оплати в проєкт (після `navigate`, бо вхід у
 * проєкт скидає гілки проєкту). Картку «Баланс поповнено» малює chat.js; кнопка «Повторити»
 * викликає `retryAfterTopup()`: cp3 → `approve()`, rev → `sendMessage(текст правки)`. Після
 * успіху `ui.retry = null`; якщо сервер знову відмовить, під новою відмовою з'явиться K3.
 *
 * Part-файл експортує рівно одну фабрику; фолбек тексту правки — приватний.
 */
import { parseCreditMessage } from "../lib/credit-messages.js";

/** @typedef {import("../contracts.js").PartFactory<"retryAfterTopup">} Factory */
/** @typedef {import("../contracts.js").FeedItem} FeedItem */

/**
 * Текст правки, якщо його не донесли з оплати: останнє повідомлення клієнта перед останньою
 * відмовою білінгу (та сама логіка, що `lastRefusedText` у views/chat.js).
 * @param {readonly FeedItem[]} feed
 * @returns {string | null}
 */
function refusedText(feed) {
  /** @param {number} i */
  const at = (i) => /** @type {{ kind: string, role?: string, text?: string }} */ (feed[i]);
  for (let i = feed.length - 1; i >= 0; i--) {
    const it = at(i);
    if (it?.kind !== "message" || it.role === "user") continue;
    const kind = parseCreditMessage(it.text ?? "")?.kind;
    if (kind !== "insufficient" && kind !== "insufficientFormats") continue;
    for (let j = i - 1; j >= 0; j--) {
      const prev = at(j);
      if (prev?.kind === "message" && prev.role === "user" && prev.text) return prev.text;
    }
    return null;
  }
  return null;
}

/** @type {Factory} */
export const retryActions = (store, deps) => {
  let busy = false;
  return {
    async retryAfterTopup() {
      const retry = store.getState().ui.retry;
      if (!retry || busy) return;
      busy = true;
      try {
        const actions = deps.actions();
        let ok = false;
        if (retry.ctx === "cp3") {
          await actions.approve();
          // approve() не кидає: збій команди він кладе в `ui.notice`.
          ok = store.getState().ui.notice === null;
        } else {
          const text = retry.text ?? refusedText(store.getState().feed);
          if (!text) return;
          ok = await actions.sendMessage(text);
        }
        if (ok && store.getState().ui.retry === retry)
          store.setState((s) => ({ ui: { ...s.ui, retry: null } }));
      } finally {
        busy = false;
      }
    },
  };
};
