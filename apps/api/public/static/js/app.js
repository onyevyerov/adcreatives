// @ts-check
/**
 * Точка входу сторінки чату (Крок 0; блоки цей файл не правлять).
 *
 * - `?project=<id>` → робочий простір, інакше — старт;
 * - `?mock=1[&jump=…][&speed=…]` → шар даних програє фікстуру подій (B2, data/mock.js);
 * - `?fixture=<стан>` → статичний стан з dev/fixture-states.js і dev-дії, без шару даних.
 *
 * Монтує view в точки з index.html і перемикає екран сцени за `viewFor(state)`.
 */
import { createActions } from "./data/actions.js";
import { clear } from "./dom.js";
import { initialState } from "./initial.js";
import { createStore } from "./store.js";
import { viewFor } from "./view.js";
import * as chat from "./views/chat.js";
import * as cpBoard from "./views/cp-board.js";
import * as cpBrand from "./views/cp-brand.js";
import * as cpScript from "./views/cp-script.js";
import * as done from "./views/done.js";
import * as failed from "./views/failed.js";
import * as stageProgress from "./views/stage-progress.js";
import * as start from "./views/start.js";
import * as timeline from "./views/timeline.js";
import * as topbar from "./views/topbar.js";

/** @typedef {import("./contracts.js").UiState} UiState */
/** @typedef {import("./contracts.js").Actions} Actions */
/** @typedef {import("./contracts.js").Store} Store */
/** @typedef {import("./contracts.js").Ctx} Ctx */
/** @typedef {import("./contracts.js").MountFn} MountFn */
/** @typedef {import("./contracts.js").ViewHandle} ViewHandle */
/** @typedef {import("./contracts.js").StageView} StageView */

/** Екрани сцени. @type {Record<StageView, MountFn>} */
export const STAGE_VIEWS = {
  progress: stageProgress.mount,
  brand: cpBrand.mount,
  script: cpScript.mount,
  board: cpBoard.mount,
  done: done.mount,
  failed: failed.mount,
};

/** Постійні області робочого простору: id точки монтування → view. @type {[string, MountFn][]} */
const WORKSPACE_VIEWS = [
  ["topbar", topbar.mount],
  ["timeline", timeline.mount],
  ["chat", chat.mount],
];

/**
 * Помилка одного view не валить решту сторінки.
 * @template T
 * @param {string} where
 * @param {() => T} fn
 * @returns {T | null}
 */
function guard(where, fn) {
  try {
    return fn();
  } catch (err) {
    console.error(`[app] ${where}`, err);
    return null;
  }
}

/** @param {HTMLElement} el @param {MountFn} mount @param {Ctx} ctx @param {string} name */
function mountView(el, mount, ctx, name) {
  return guard(`mount ${name}`, () => mount(el, ctx));
}

/** @param {ViewHandle | null} view @param {string} name */
function destroyView(view, name) {
  if (view) guard(`destroy ${name}`, () => view.destroy());
}

/**
 * @param {Document} doc
 * @param {string} id
 * @returns {HTMLElement}
 */
function byId(doc, id) {
  const el = doc.getElementById(id);
  if (!el) throw new Error(`index.html: немає #${id}`);
  return el;
}

/**
 * Запускає сторінку. Параметри — для тестів і режиму фікстур.
 * @param {{ doc?: Document, params?: URLSearchParams, state?: UiState, actions?: (store: Store) => Actions }} [opts]
 * @returns {Promise<{ store: Store, actions: Actions, destroy(): void }>}
 */
export async function boot(opts = {}) {
  const doc = opts.doc ?? document;
  const params = opts.params ?? new URLSearchParams(doc.location?.search ?? "");
  const projectId = params.get("project");
  const fixture = params.get("fixture");

  let state = opts.state ?? initialState(projectId ? "project" : "start", projectId);
  /** @type {(store: Store) => Actions} */
  let makeActions = opts.actions ?? ((s) => createActions(s, { params }));
  if (!opts.state && fixture) {
    const [{ fixtureStates }, { createDevActions }] = await Promise.all([
      import("../dev/fixture-states.js"),
      import("../dev/dev-actions.js"),
    ]);
    const preset = fixtureStates[fixture];
    if (preset) state = preset;
    else console.warn(`[app] немає фікстури «${fixture}»: ${Object.keys(fixtureStates).join(", ")}`);
    if (!opts.actions) makeActions = createDevActions;
  }

  const store = createStore(state);
  const actions = makeActions(store);
  /** @type {Ctx} */
  const ctx = { store, actions };

  const app = byId(doc, "app");
  const startEl = byId(doc, "start");
  const workspaceEl = byId(doc, "workspace");
  const stageEl = byId(doc, "stage");

  /** @type {ViewHandle | null} */
  let startView = null;
  /** @type {{ name: string, el: HTMLElement, view: ViewHandle | null }[] | null} */
  let workspace = null;
  /** @type {{ kind: StageView, view: ViewHandle | null } | null} */
  let stage = null;

  function leaveWorkspace() {
    if (stage) destroyView(stage.view, `stage:${stage.kind}`);
    stage = null;
    clear(stageEl);
    for (const area of workspace ?? []) {
      destroyView(area.view, area.name);
      clear(area.el);
    }
    workspace = null;
  }

  function leaveStart() {
    destroyView(startView, "start");
    startView = null;
    clear(startEl);
  }

  /** @param {UiState} next @param {UiState} prev */
  function render(next, prev) {
    app.dataset.route = next.route;
    startEl.hidden = next.route !== "start";
    workspaceEl.hidden = next.route !== "project";

    if (next.route === "start") {
      leaveWorkspace();
      if (startView) {
        const view = startView;
        guard("update start", () => view.update(next, prev));
      } else startView = mountView(startEl, start.mount, ctx, "start");
      return;
    }

    leaveStart();
    if (workspace) {
      for (const { name, view } of workspace)
        if (view) guard(`update ${name}`, () => view.update(next, prev));
    } else {
      workspace = WORKSPACE_VIEWS.map(([name, mount]) => {
        const el = byId(doc, name);
        return { name, el, view: mountView(el, mount, ctx, name) };
      });
    }

    const kind = viewFor(next);
    if (stage?.kind === kind) {
      const view = stage.view;
      if (view) guard(`update stage:${kind}`, () => view.update(next, prev));
      return;
    }
    if (stage) destroyView(stage.view, `stage:${stage.kind}`);
    clear(stageEl);
    stageEl.scrollTop = 0;
    stage = { kind, view: mountView(stageEl, STAGE_VIEWS[kind], ctx, `stage:${kind}`) };
  }

  // setState зсередини mount/update не рендерить повторно посеред рендеру: зміни збираються
  // і застосовуються наступним проходом, тож кожен view отримує (state, prev) по порядку.
  let last = store.getState();
  let rendering = false;
  let dirty = false;
  function flush() {
    if (rendering) {
      dirty = true;
      return;
    }
    rendering = true;
    try {
      do {
        dirty = false;
        const next = store.getState();
        const prev = last;
        last = next;
        render(next, prev);
      } while (dirty);
    } finally {
      rendering = false;
    }
  }

  const unsubscribe = store.subscribe(flush);
  flush();

  return {
    store,
    actions,
    destroy() {
      unsubscribe();
      leaveStart();
      leaveWorkspace();
    },
  };
}

// Автозапуск у браузері; тести імпортують модуль без #app і викликають boot() самі.
if (typeof document !== "undefined" && document.getElementById("app")) {
  boot().catch((err) => console.error("[app] boot", err));
}
