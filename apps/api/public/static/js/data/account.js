// @ts-check
/**
 * Крок 0 · Ядро акаунта (ТЗ фронтенду акаунтів, 2.4).
 *
 * `createAccountActions(store, { params, api? })` збирає всі дії сторінки:
 * `Object.assign(base, core, authActions(…), startActions(…), …)` — саме на об'єкт `createActions`,
 * бо spread зламав би геттер `ready`. Ядро:
 * 1. На старті — `GET /api/auth/me` → `account.me`, `meStatus: "ready"`; 401 / мережа → `"anon"`.
 *    У `?mock=1` — фейковий `me` (Олена, 12) з dev/fixtures/_base.js без мережі.
 * 2. `refreshMe()` — повторний `me`; змінився баланс при `meStatus: "ready"` → `account.delta`.
 *    Відповідь застарілого запиту (пізніший `refreshMe` уже пішов) відкидається; 401 після
 *    `ready` (сесія протухла) — як 401 нижче (п. 4). `me` став ready → `account.projectCount`.
 * 3. Нове (не з реплею історії SSE) повідомлення `assistant`, яке розпізнає `parseCreditMessage`,
 *    → `refreshMe()`.
 * 4. 401 `unauthorized` (крім самого `me`): на project — `session: "401"` + форма входу в сцені
 *    (`auth` login/session), потік проєкту зупиняється; на інших маршрутах — `openAuth("login", "session")`.
 * 5. `logout()` → `me: null`, `"anon"`, кабінет / адмінка / чек — до початкових, старт із `flash`.
 * 6. Маршрути: `navigate` — `pushState` + стан; `popstate` — той самий шлях; project → інше —
 *    `backend.stop()`, вхід у project — скидання гілок проєкту і `backend.start()`.
 * 7. Охорона: cabinet / checkout / admin для гостя — маршрут лишається, модалка login (context
 *    `checkout` для оплати, `header` для решти); після входу підписники `onRoute` отримують
 *    маршрут ще раз (перезавантажують дані). admin без `isAdmin` → `session: "403"`, `admin.forbidden`.
 * Посилання з листа (`?auth=activate|reset&token=…`): токен прибирається з URL, `auth` —
 * `activating` (+ `submitAuth()`) або `reset`.
 */
import {
  authState,
  checkoutState,
  initialAdmin,
  initialCabinet,
  initialState,
  projectState,
} from "../initial.js";
import { parseCreditMessage } from "../lib/credit-messages.js";
import { routeFromUrl, urlForRoute } from "../router.js";
import * as accountApi from "./account-api.js";
import { createActions, createBackend } from "./actions.js";
import { adminActions } from "./admin-actions.js";
import { setUnauthorizedHandler } from "./api.js";
import { authActions } from "./auth-actions.js";
import { cabinetActions } from "./cabinet-actions.js";
import { checkoutActions } from "./checkout-actions.js";
import { profileActions } from "./profile-actions.js";
import { retryActions } from "./retry-actions.js";
import { startActions } from "./start-actions.js";
import { topupActions } from "./topup-actions.js";

/** @typedef {import("../contracts.js").Store} Store */
/** @typedef {import("../contracts.js").UiState} UiState */
/** @typedef {import("../contracts.js").Route} Route */
/** @typedef {import("../contracts.js").Actions} Actions */
/** @typedef {import("../contracts.js").AccountActions} AccountActions */
/** @typedef {import("../contracts.js").AccountApi} AccountApi */
/** @typedef {import("../contracts.js").AccountState} AccountState */
/** @typedef {import("../contracts.js").PartDeps} PartDeps */
/** @typedef {import("../contracts.js").DataOptions} DataOptions */
/** @typedef {import("./actions.js").DataDeps} DataDeps */

/** Рядок-статус на старті після виходу. */
export const LOGOUT_FLASH = "Ви вийшли з акаунта. Проєкти збережено — увійдіть, щоб продовжити.";

/**
 * Повідомлення білінгу старше за відкриття потоку на стільки — з реплею історії SSE,
 * `refreshMe` на нього не потрібен (запас на розбіжність годинників клієнта й сервера).
 */
export const REPLAY_MARGIN_MS = 60_000;

/** Маршрути лише для користувача. @type {readonly UiState["route"][]} */
export const GUARDED = ["cabinet", "checkout", "admin"];

/**
 * Патч стану для переходу на маршрут. Вхід у project і повернення на старт скидають гілки
 * проєкту; `session` скидається на кожному переході.
 * @param {UiState} s
 * @param {Route} r
 * @returns {Partial<UiState>}
 */
export function applyRoute(s, r) {
  switch (r.route) {
    case "start":
      return { ...projectState(null), route: "start" };
    case "project":
      return { ...projectState(r.projectId), route: "project" };
    case "cabinet":
      return { route: "cabinet", session: null, cabinet: { ...s.cabinet, section: r.section } };
    case "checkout":
      return {
        route: "checkout",
        session: null,
        checkout: s.checkout?.id === r.id ? s.checkout : checkoutState(r.id),
      };
    case "admin": {
      const selectedId = r.userId ?? null;
      return {
        route: "admin",
        session: null,
        admin: {
          ...s.admin,
          tab: r.tab ?? "users",
          selectedId,
          forbidden: false,
          selected: selectedId === s.admin.selectedId ? s.admin.selected : null,
        },
      };
    }
    default:
      return {};
  }
}

/**
 * Поточний маршрут зі стану (зворотне до `applyRoute`).
 * @param {UiState} s
 * @returns {Route}
 */
export function routeOf(s) {
  switch (s.route) {
    case "project":
      return s.projectId ? { route: "project", projectId: s.projectId } : { route: "start" };
    case "cabinet":
      return { route: "cabinet", section: s.cabinet.section };
    case "checkout":
      return s.checkout ? { route: "checkout", id: s.checkout.id } : { route: "start" };
    case "admin":
      return {
        route: "admin",
        tab: s.admin.tab,
        ...(s.admin.selectedId ? { userId: s.admin.selectedId } : {}),
      };
    default:
      return { route: "start" };
  }
}

/**
 * Стан сторінки для адреси (app.js, перший рендер).
 * @param {URLSearchParams} params
 * @returns {UiState}
 */
export function stateForUrl(params) {
  const r = routeFromUrl(params);
  const base = initialState(r.route, r.route === "project" ? r.projectId : null);
  return { ...base, ...applyRoute(base, r) };
}

/**
 * @param {Store} store
 * @param {Partial<AccountState>} patch
 */
const setAccount = (store, patch) => store.setState((s) => ({ account: { ...s.account, ...patch } }));

/** @param {string} url */
function pushUrl(url) {
  try {
    globalThis.history?.pushState(null, "", url);
  } catch (err) {
    console.warn("[account] history.pushState", err);
  }
}

/** @param {string} url */
function replaceUrl(url) {
  try {
    globalThis.history?.replaceState(null, "", url);
  } catch (err) {
    console.warn("[account] history.replaceState", err);
  }
}

/** @param {unknown} err */
const statusOf = (err) =>
  typeof err === "object" && err !== null && "status" in err && typeof err.status === "number"
    ? err.status
    : 0;

/**
 * @param {Store} store
 * @param {DataOptions & DataDeps & { api?: AccountApi }} opts
 * @returns {Actions & { readonly ready: Promise<void>, readonly meReady: Promise<void>, dispose(): void }}
 */
export function createAccountActions(store, opts) {
  const { params } = opts;
  const api = opts.api ?? accountApi;
  const offline = params.get("mock") === "1";
  const backend = createBackend(store, opts);
  /** @type {Actions} */
  let all;
  const base = createActions(store, {
    params,
    backend,
    // Успішний старт проєкту: баланс і «Мої проєкти · N».
    refreshMe: async () => {
      void loadProjectCount();
      await all.refreshMe();
    },
  });
  const baseDispose = base.dispose;

  /** @type {((route: Route) => void)[]} */
  const routeListeners = [];
  /** @type {PartDeps} */
  const deps = {
    params,
    api,
    actions: () => all,
    backend,
    offline,
    onRoute: (fn) => {
      routeListeners.push(fn);
    },
  };

  // ───────────── me ─────────────

  let deltaKey = 0;
  /** Номер останнього запиту `me`: відповіді старіших відкидаються. */
  let meSeq = 0;

  /**
   * Сесії більше немає (401 на будь-якому запиті після входу): на project — форма входу в сцені
   * і зупинка потоку, на інших маршрутах — модалка login у контексті session.
   */
  function sessionLost() {
    const s = store.getState();
    setAccount(store, { me: null, meStatus: "anon" });
    if (s.route === "project") {
      backend.stop();
      store.setState({ session: "401", auth: authState("login", "session") });
    } else {
      all.openAuth("login", "session");
    }
  }

  async function loadProjectCount() {
    if (offline) return;
    try {
      const { projects } = await api.listProjects();
      if (store.getState().account.meStatus === "ready" && Array.isArray(projects))
        setAccount(store, { projectCount: projects.length });
    } catch (err) {
      // 401 обробив setUnauthorizedHandler; лічильник — не критичний.
      if (statusOf(err) !== 401) console.warn("[account] listProjects", err);
    }
  }

  async function refreshMe() {
    if (offline) return;
    const my = ++meSeq;
    try {
      const me = await api.me();
      if (my !== meSeq) return;
      const s = store.getState().account;
      const old = s.meStatus === "ready" ? s.me?.balance : undefined;
      const changed = old !== undefined && me.balance !== old;
      if (changed) deltaKey = Math.max(Date.now(), deltaKey + 1);
      setAccount(store, {
        me,
        meStatus: "ready",
        ...(changed && old !== undefined ? { delta: { credits: me.balance - old, key: deltaKey } } : {}),
      });
    } catch (err) {
      if (my !== meSeq) return;
      const s = store.getState().account;
      // 401 — гість (або протухла сесія після входу); мережа на першому завантаженні — теж гість
      // (сторінка працює без бекенду).
      if (statusOf(err) === 401) {
        if (s.meStatus === "ready") sessionLost();
        else setAccount(store, { me: null, meStatus: "anon" });
      } else if (s.meStatus === "loading") setAccount(store, { meStatus: "anon" });
      else console.warn("[account] refreshMe", err);
    }
  }

  /** У mock-режимі — фейковий me без мережі. */
  async function fakeMe() {
    try {
      const { ME, PROJECTS } = await import("../../dev/fixtures/_base.js");
      setAccount(store, { me: ME, meStatus: "ready", projectCount: PROJECTS.length });
    } catch (err) {
      console.warn("[account] mock me", err);
      setAccount(store, { meStatus: "anon" });
    }
  }

  // ───────────── маршрути ─────────────

  /** Підписники `onRoute` — після охорони маршруту. */
  function enter() {
    const s = store.getState();
    if (GUARDED.includes(s.route)) {
      const status = s.account.meStatus;
      if (status === "loading") return; // повторимо, коли прийде me
      if (status === "anon") {
        if (!s.auth) all.openAuth("login", s.route === "checkout" ? "checkout" : "header");
        return;
      }
      if (s.route === "admin" && !s.account.me?.user.isAdmin) {
        store.setState((st) => ({ session: "403", admin: { ...st.admin, forbidden: true } }));
        return;
      }
    }
    const r = routeOf(s);
    for (const fn of [...routeListeners]) {
      try {
        fn(r);
      } catch (err) {
        console.error("[account] onRoute", err);
      }
    }
  }

  /** @param {Route} to */
  function go(to) {
    const s = store.getState();
    if (to.route === "project") {
      // openStream сам зупиняє попередній потік і скидає гілки проєкту.
      void base.openStream(to.projectId);
    } else {
      if (s.route === "project") backend.stop();
      store.setState((st) => applyRoute(st, to));
    }
    enter();
  }

  /** @param {Route} to */
  function navigate(to) {
    pushUrl(urlForRoute(to, params));
    go(to);
  }

  const onPopState = () => {
    go(routeFromUrl(new URLSearchParams(globalThis.location?.search ?? "")));
  };

  async function logout() {
    try {
      if (!offline) await api.logout();
    } catch (err) {
      console.warn("[account] logout", err);
    }
    meSeq++; // відповідь me, що ще летить, не поверне користувача
    setAccount(store, { me: null, meStatus: "anon", delta: null, autostart: null, projectCount: null });
    store.setState({ cabinet: initialCabinet(), admin: initialAdmin(), checkout: null });
    navigate({ route: "start" });
    setAccount(store, { flash: LOGOUT_FLASH });
  }

  /** @type {Pick<AccountActions, "refreshMe" | "navigate" | "logout">} */
  const core = { refreshMe, navigate, logout };

  all = Object.assign(
    base,
    core,
    authActions(store, deps),
    startActions(store, deps),
    retryActions(store, deps),
    topupActions(store, deps),
    checkoutActions(store, deps),
    cabinetActions(store, deps),
    profileActions(store, deps),
    adminActions(store, deps),
  );

  // ───────────── підписки ─────────────

  setUnauthorizedHandler((_err, path) => {
    if (path === "/api/auth/me") return; // це обробляє refreshMe
    sessionLost();
  });

  /** Коли востаннє відкрито потік проєкту (порожня стрічка) — межа реплею історії SSE. */
  let streamOpenedAt = Date.now();

  const unsubscribe = store.subscribe((s, prev) => {
    // Охорона маршруту: me прийшов (або гість визначився) — дозволити або відкрити вхід.
    const was = prev.account.meStatus;
    const now = s.account.meStatus;
    if (now !== was && (now === "ready" || (was === "loading" && now === "anon"))) {
      if (now === "ready") void loadProjectCount();
      if (GUARDED.includes(s.route)) enter();
    }
    // Відмови, списання й повернення приходять звичайними повідомленнями assistant. Редьюсер
    // лише дописує в кінець стрічки, тож нові — хвіст; старіші за відкриття потоку — реплей.
    if (s.projectId !== prev.projectId || s.feed.length === 0) streamOpenedAt = Date.now();
    if (s.feed !== prev.feed && s.feed.length > prev.feed.length) {
      const since = streamOpenedAt - REPLAY_MARGIN_MS;
      const billing = s.feed
        .slice(prev.feed.length)
        .some(
          (f) =>
            f.kind === "message" &&
            f.role === "assistant" &&
            !(Date.parse(f.at) < since) &&
            parseCreditMessage(f.text) !== null,
        );
      if (billing) void refreshMe();
    }
  });

  globalThis.addEventListener?.("popstate", onPopState);

  // ───────────── старт сторінки ─────────────

  const fromUrl = routeFromUrl(params);
  // Токен з листа не лишається в адресі за жодного маршруту.
  if (params.has("token") || params.has("auth")) {
    const { auth: _auth, ...route } = fromUrl;
    replaceUrl(urlForRoute(route, params));
  }
  if (fromUrl.auth) {
    const { kind, token } = fromUrl.auth;
    store.setState({ auth: authState(kind === "activate" ? "activating" : "reset", null, { token }) });
    if (kind === "activate") void all.submitAuth();
  }

  const meReady = offline ? fakeMe() : refreshMe();
  enter();

  // `all` — той самий об'єкт, що й `base` (Object.assign), тож геттер `ready` на місці.
  return Object.assign(/** @type {typeof base & Actions} */ (all), {
    get meReady() {
      return meReady;
    },
    dispose() {
      baseDispose();
      unsubscribe();
      setUnauthorizedHandler(null);
      globalThis.removeEventListener?.("popstate", onPopState);
    },
  });
}
