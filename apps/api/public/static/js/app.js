// @ts-check
/**
 * Точка входу сторінки (Крок 0; блоки цей файл не правлять).
 *
 * - маршрут — з адреси (router.js): старт, `?project=<id>` → робочий простір, `?cabinet=…`,
 *   `?checkout=<id>`, `?admin=…`; `?auth=activate|reset&token=…` — старт + модалка входу;
 * - `?mock=1[&jump=…][&speed=…]` → шар даних програє фікстуру подій (data/mock.js), акаунт — фейковий;
 * - `?fixture=<стан>` → статичний стан з dev/fixture-states.js і dev-дії, без шару даних.
 *
 * Монтує view в точки з index.html: на кожен маршрут — свій корінь з областями; у робочому
 * просторі перемикає екран сцени за `viewFor(state)`; модалка входу (`#overlay`) змонтована завжди.
 */
import { createAccountActions, stateForUrl } from "./data/account.js";
import { clear } from "./dom.js";
import { createStore } from "./store.js";
import { viewFor } from "./view.js";
import * as admin from "./views/admin.js";
import * as auth from "./views/auth.js";
import * as cabinet from "./views/cabinet.js";
import * as chat from "./views/chat.js";
import * as checkout from "./views/checkout.js";
import * as cpBoard from "./views/cp-board.js";
import * as cpBrand from "./views/cp-brand.js";
import * as cpScript from "./views/cp-script.js";
import * as done from "./views/done.js";
import * as failed from "./views/failed.js";
import * as session from "./views/session.js";
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
/** @typedef {UiState["route"]} RouteName */

/** Екрани сцени. @type {Record<StageView, MountFn>} */
export const STAGE_VIEWS = {
  progress: stageProgress.mount,
  brand: cpBrand.mount,
  script: cpScript.mount,
  board: cpBoard.mount,
  done: done.mount,
  failed: failed.mount,
  session: session.mount,
  notfound: session.mount,
};

/**
 * Екрани маршрутів: корінь з index.html (видимий лише на своєму маршруті) і його області —
 * id точки монтування → view. Сцена робочого простору (`#stage`) — окремо, за `viewFor`.
 * @type {Record<RouteName, { root: string, areas: [string, MountFn][] }>}
 */
export const SCREENS = {
  start: { root: "start", areas: [["start", start.mount]] },
  project: {
    root: "workspace",
    areas: [
      ["topbar", topbar.mount],
      ["timeline", timeline.mount],
      ["chat", chat.mount],
    ],
  },
  cabinet: {
    root: "cabinet",
    areas: [
      ["cab-topbar", topbar.mount],
      ["cab-main", cabinet.mount],
    ],
  },
  checkout: { root: "checkout", areas: [["checkout", checkout.mount]] },
  admin: {
    root: "admin",
    areas: [
      ["admin-topbar", topbar.mount],
      ["admin-main", admin.mount],
    ],
  },
};

/** @type {readonly RouteName[]} */
const ROUTES = /** @type {RouteName[]} */ (Object.keys(SCREENS));

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
  const fixture = params.get("fixture");

  let state = opts.state ?? stateForUrl(params);
  /** @type {(store: Store) => Actions} */
  let makeActions = opts.actions ?? ((s) => createAccountActions(s, { params }));
  if (!opts.state && fixture) {
    const [{ fixtureStates, LEGACY_FIXTURES }, { createDevActions }, { ME, PROJECTS }] = await Promise.all([
      import("../dev/fixture-states.js"),
      import("../dev/dev-actions.js"),
      import("../dev/fixtures/_base.js"),
    ]);
    const preset = fixtureStates[fixture];
    if (preset) state = preset;
    else console.warn(`[app] немає фікстури «${fixture}»: ${Object.keys(fixtureStates).join(", ")}`);
    // Старі стани проєкту (до Кроку 0, без акаунта) — з фейковим me (Олена, 12); фікстури блоків
    // (dev/fixtures/*) не чіпаємо: їхній акаунт, зокрема «loading», — частина стану.
    if (!preset || LEGACY_FIXTURES.includes(fixture))
      state = {
        ...state,
        account: { ...state.account, me: ME, meStatus: "ready", projectCount: PROJECTS.length },
      };
    if (!opts.actions) makeActions = createDevActions;
  }

  const store = createStore(state);
  const actions = makeActions(store);
  /** @type {Ctx} */
  const ctx = { store, actions };

  const app = byId(doc, "app");
  const roots = Object.fromEntries(ROUTES.map((r) => [r, byId(doc, SCREENS[r].root)]));
  const stageEl = byId(doc, "stage");
  const overlayEl = byId(doc, "overlay");

  /** @type {{ route: RouteName, areas: { name: string, el: HTMLElement, view: ViewHandle | null }[] } | null} */
  let screen = null;
  /** @type {{ kind: StageView, view: ViewHandle | null } | null} */
  let stage = null;
  /** @type {ViewHandle | null} */
  let overlay = null;

  function leaveStage() {
    if (stage) destroyView(stage.view, `stage:${stage.kind}`);
    stage = null;
    clear(stageEl);
  }

  function leaveScreen() {
    if (!screen) return;
    if (screen.route === "project") leaveStage();
    for (const area of screen.areas) {
      destroyView(area.view, area.name);
      clear(area.el);
    }
    screen = null;
  }

  /** @param {UiState} next @param {UiState} prev */
  function renderStage(next, prev) {
    const kind = viewFor(next);
    if (stage?.kind === kind) {
      const view = stage.view;
      if (view) guard(`update stage:${kind}`, () => view.update(next, prev));
      return;
    }
    leaveStage();
    stageEl.scrollTop = 0;
    stage = { kind, view: mountView(stageEl, STAGE_VIEWS[kind], ctx, `stage:${kind}`) };
  }

  /** @param {UiState} next @param {UiState} prev */
  function render(next, prev) {
    const route = SCREENS[next.route] ? next.route : "start";
    app.dataset.route = route;
    for (const r of ROUTES) {
      const el = roots[r];
      if (el) el.hidden = r !== route;
    }

    if (screen && screen.route !== route) leaveScreen();
    if (screen) {
      for (const { name, view } of screen.areas)
        if (view) guard(`update ${name}`, () => view.update(next, prev));
    } else {
      screen = {
        route,
        areas: SCREENS[route].areas.map(([name, mount]) => {
          const el = byId(doc, name);
          return { name, el, view: mountView(el, mount, ctx, name) };
        }),
      };
    }
    if (route === "project") renderStage(next, prev);

    if (overlay) {
      const view = overlay;
      guard("update overlay", () => view.update(next, prev));
    } else overlay = mountView(overlayEl, auth.mount, ctx, "overlay");
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
      leaveScreen();
      destroyView(overlay, "overlay");
      overlay = null;
      clear(overlayEl);
      const dispose = /** @type {{ dispose?: () => void }} */ (actions).dispose;
      if (typeof dispose === "function") guard("dispose", () => dispose.call(actions));
    },
  };
}

// Автозапуск у браузері; тести імпортують модуль без #app і викликають boot() самі.
if (typeof document !== "undefined" && document.getElementById("app")) {
  boot().catch((err) => console.error("[app] boot", err));
}
