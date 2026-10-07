// @ts-check
/**
 * B4 · Діалог: стрічка (C4, X1) + композер (C5). Заглушка Кроку 0: B4 замінює вміст файлу,
 * сигнатуру `mount` зберігає. Композер монтує сам chat.js — app.js про нього не знає.
 */
import { stubView } from "../../dev/stub.js";
import { h } from "../dom.js";
import * as composer from "./composer.js";

/** @type {import("../contracts.js").MountFn} */
export function mount(el, ctx) {
  const feedView = stubView("chat", "B4", el, ctx, (s) => `стрічка: ${s.feed.length} · ${s.conn}`);
  const slot = h("div", { "data-slot": "composer" });
  el.append(slot);
  const composerView = composer.mount(slot, ctx);
  return {
    update(state, prev) {
      feedView.update(state, prev);
      composerView.update(state, prev);
    },
    destroy() {
      composerView.destroy();
      feedView.destroy();
      slot.remove();
    },
  };
}
