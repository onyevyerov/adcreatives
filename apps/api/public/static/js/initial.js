// @ts-check
/** @typedef {import("./contracts.js").UiState} UiState */
/** @typedef {import("./contracts.js").AccountState} AccountState */
/** @typedef {import("./contracts.js").AuthState} AuthState */
/** @typedef {import("./contracts.js").AuthView} AuthView */
/** @typedef {import("./contracts.js").CabinetState} CabinetState */
/** @typedef {import("./contracts.js").CheckoutState} CheckoutState */
/** @typedef {import("./contracts.js").AdminState} AdminState */

/**
 * Порожній стан UI для маршруту.
 * @param {UiState["route"]} route
 * @param {string | null} projectId
 * @returns {UiState}
 */
export function initialState(route, projectId) {
  return {
    ...projectState(projectId),
    route,
    account: initialAccount(),
    auth: null,
    cabinet: initialCabinet(),
    checkout: null,
    admin: initialAdmin(),
  };
}

/**
 * Гілки, які належать відкритому проєкту: скидаються при вході в проєкт і поверненні на старт,
 * не чіпаючи акаунт, модалку входу, кабінет, чек і адмінку. `route` — окремо, у викликача.
 * @param {string | null} projectId
 * @returns {Omit<UiState, "route" | "account" | "auth" | "cabinet" | "checkout" | "admin">}
 */
export function projectState(projectId) {
  return {
    projectId,
    site: null,
    status: "intake",
    prevStatus: null,
    rev: null,
    conn: "idle",
    totalUsd: 0,
    breakdown: null,
    feed: [],
    progress: null,
    stageLog: [],
    checkpoints: { brand: null, script: null, storyboard: null },
    artifacts: { videos: [], poster: null, music: null },
    error: null,
    busyMs: 0,
    busySince: null,
    session: null,
    projectCredits: null,
    ui: {
      editing: false,
      draft: "",
      pendingFormats: null,
      doneFormat: null,
      notice: null,
      startError: null,
      sending: false,
      startShortage: null,
      retry: null,
    },
  };
}

/** @returns {AccountState} */
export function initialAccount() {
  return {
    me: null,
    meStatus: "loading",
    delta: null,
    flash: null,
    pending: null,
    autostart: null,
    projectCount: null,
    prices: null,
  };
}

/**
 * Відкрита модалка входу з порожніми полями.
 * @param {AuthView} view
 * @param {NonNullable<AuthState>["context"]} [context]
 * @param {Partial<NonNullable<AuthState>>} [patch]
 * @returns {NonNullable<AuthState>}
 */
export function authState(view, context = null, patch = {}) {
  return {
    view,
    context,
    name: "",
    email: "",
    password: "",
    showPassword: false,
    token: null,
    busy: false,
    error: null,
    message: null,
    resent: false,
    cooldownUntil: null,
    bonus: 0,
    fails: 0,
    ...patch,
  };
}

/** @returns {CabinetState} */
export function initialCabinet() {
  return {
    section: "balance",
    loading: false,
    backTo: null,
    topup: { mode: "package", packageId: null, custom: "", error: false, busy: false },
    pendingTopups: [],
    history: { entries: [], nextBefore: null, loading: false, more: false },
    projects: { rows: null, loading: false, open: null },
    profile: {
      nameDraft: "",
      saving: false,
      saved: false,
      nameError: false,
      current: "",
      next: "",
      pwBusy: false,
      pwError: null,
      pwDone: false,
    },
  };
}

/**
 * Чек, що вантажиться (B8 заповнює `topup`, `status`, `returnTo`).
 * @param {string} id
 * @returns {CheckoutState}
 */
export function checkoutState(id) {
  return { status: "loading", id, topup: null, returnTo: { kind: "cabinet" }, revisit: false };
}

/** @returns {AdminState} */
export function initialAdmin() {
  return {
    tab: "users",
    loading: false,
    forbidden: false,
    users: [],
    q: "",
    selectedId: null,
    selected: null,
    adjust: { credits: "", note: "", busy: false, confirm: false, error: null, done: null },
    outbox: [],
    copied: null,
    allProjects: [],
  };
}
