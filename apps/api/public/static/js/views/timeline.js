// @ts-check
/**
 * B3 · Таймлайн (C3): рядок підписів сегментів, шкала тіків, ромби чекпоінтів і плейхед
 * з чипом машинного часу. DOM будується один раз у `mount`, `update` лише патчить змінене.
 */
import { BUSY } from "../contracts.js";
import { h, text } from "../dom.js";
import { formatMachineTime, machineMs, timelinePosition } from "../lib/timeline.js";

/** @typedef {import("../contracts.js").UiState} UiState */
/** @typedef {import("../lib/timeline.js").TimelinePosition} TimelinePosition */

/** Інтервал оновлення чипа машинного часу в busy-стані. */
export const TICK_MS = 1000;

/** CSS-класи ромба за станом (примітиви `.diamond*` з components.css). */
const DIAMOND_CLASS = {
  open: "diamond diamond--lg tl-diamond tl-diamond--idle",
  ring: "diamond diamond--lg diamond--open diamond--ring tl-diamond",
  done: "diamond diamond--lg diamond--done tl-diamond",
};

/** @param {number} n */
const pctCss = (n) => `${Math.round(n * 1000) / 1000}%`;

/** @type {import("../contracts.js").MountFn} */
export function mount(el, ctx) {
  const initial = timelinePosition(ctx.store.getState());

  const labelNodes = initial.labels.map((l) => {
    const num = h("span", { class: "tl-label__num" });
    const node = h(
      "div",
      { class: "tl-label", "data-key": l.key, style: { flex: `${l.weight} 1 0` } },
      num,
      " ",
      l.label,
    );
    return { node, num };
  });

  const passed = h("div", { class: "tl-passed" });
  const diamondNodes = initial.diamonds.map((d) =>
    h("span", { class: DIAMOND_CLASS.open, "data-checkpoint": d.checkpoint, style: { left: pctCss(d.pct) } }),
  );
  const chip = h("div", { class: "tl-chip", title: "Машинний час" });
  const playhead = h("div", { class: "tl-playhead" }, h("div", { class: "tl-playhead__line" }), chip);
  const scale = h("div", { class: "tl-scale" }, passed, diamondNodes, playhead);
  const root = h(
    "div",
    { class: "tl", role: "group", "aria-label": "Етапи проєкту" },
    h(
      "div",
      { class: "tl-labels" },
      labelNodes.map((l) => l.node),
    ),
    scale,
  );
  el.append(root);

  /** @type {UiState} */
  let current = ctx.store.getState();
  /** @type {ReturnType<typeof setInterval> | null} */
  let timer = null;
  /** @type {TimelinePosition | null} */
  let shown = null;

  function renderChip() {
    text(chip, formatMachineTime(machineMs(current)));
  }

  function stopTimer() {
    if (timer !== null) clearInterval(timer);
    timer = null;
  }

  function syncTimer() {
    const busy = BUSY.includes(current.status) && Boolean(current.busySince);
    if (busy && timer === null) timer = setInterval(renderChip, TICK_MS);
    else if (!busy) stopTimer();
  }

  /** @param {TimelinePosition} pos */
  function renderPosition(pos) {
    const prev = shown;
    if (!prev || prev.pct !== pos.pct) {
      const css = pctCss(pos.pct);
      passed.style.width = css;
      playhead.style.left = css;
      playhead.classList.toggle("tl-playhead--end", pos.pct >= 100);
    }
    pos.labels.forEach((l, i) => {
      const was = prev?.labels[i];
      const nodes = labelNodes[i];
      if (!nodes || (was && was.state === l.state)) return;
      nodes.node.className = `tl-label tl-label--${l.state}`;
      text(nodes.num, l.state === "done" ? "✓" : l.num);
    });
    pos.diamonds.forEach((d, i) => {
      const node = diamondNodes[i];
      if (!node || prev?.diamonds[i]?.state === d.state) return;
      node.className = DIAMOND_CLASS[d.state];
      node.dataset.state = d.state;
    });
    shown = pos;
  }

  /** @param {UiState} state */
  function render(state) {
    current = state;
    renderPosition(timelinePosition(state));
    renderChip();
    syncTimer();
  }

  render(current);

  return {
    update(state, prev) {
      if (
        state.status === prev.status &&
        state.prevStatus === prev.prevStatus &&
        state.progress === prev.progress &&
        state.stageLog === prev.stageLog &&
        state.checkpoints === prev.checkpoints &&
        state.artifacts === prev.artifacts &&
        state.ui === prev.ui &&
        state.busyMs === prev.busyMs &&
        state.busySince === prev.busySince
      ) {
        current = state;
        return;
      }
      render(state);
    },
    destroy() {
      stopTimer();
      root.remove();
    },
  };
}
