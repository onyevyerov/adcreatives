// @ts-check
/**
 * Дії-заглушки для режиму `?fixture=<стан>` і для заглушки data/actions.js: мережі немає,
 * виклики пишуться в консоль і в `ui.notice`, а суто UI-дії змінюють стан як справжні.
 * Дії акаунтів (`AccountActions`) — no-op із `console.info` (і в `calls`).
 */
import { projectState } from "../js/initial.js";

/** @typedef {import("../js/contracts.js").Actions} Actions */
/** @typedef {import("../js/contracts.js").Store} Store */
/** @typedef {import("../js/contracts.js").UiFlags} UiFlags */
/** @typedef {import("../js/contracts.js").AccountActions} AccountActions */

/**
 * @param {Store} store
 * @returns {Actions & { calls: { name: string, args: unknown[] }[] }}
 */
export function createDevActions(store) {
  /** @type {{ name: string, args: unknown[] }[]} */
  const calls = [];
  /** @param {Partial<UiFlags>} patch */
  const ui = (patch) => store.setState((s) => ({ ui: { ...s.ui, ...patch } }));
  /** @param {string} name @param {unknown[]} args */
  const log = (name, args) => {
    calls.push({ name, args });
    console.info(`[dev] ${name}`, ...args);
    ui({ notice: `dev: ${name}()` });
  };
  /** @param {string} name @param {unknown[]} args */
  const info = (name, args) => {
    calls.push({ name, args });
    console.info(`[dev] ${name}`, ...args);
  };
  /** @type {AccountActions} */
  const account = {
    refreshMe: async () => info("refreshMe", []),
    navigate: (to) => info("navigate", [to]),
    logout: async () => info("logout", []),
    openAuth: (view, context) => info("openAuth", [view, context]),
    closeAuth: () => info("closeAuth", []),
    setAuthField: (key, value) => info("setAuthField", [key, value]),
    submitAuth: async () => info("submitAuth", []),
    resendAuthMail: async () => info("resendAuthMail", []),
    authGoogle: async () => info("authGoogle", []),
    submitStart: async (form) => info("submitStart", [Object.fromEntries(form.entries())]),
    startPending: async () => info("startPending", []),
    dismissFlash: () => info("dismissFlash", []),
    retryAfterTopup: async () => info("retryAfterTopup", []),
    openTopup: (o) => info("openTopup", [o]),
    selectPackage: (id) => info("selectPackage", [id]),
    setCustom: (value) => info("setCustom", [value]),
    submitTopup: async () => info("submitTopup", []),
    continueTopup: (id) => info("continueTopup", [id]),
    confirmCheckout: async (outcome) => info("confirmCheckout", [outcome]),
    checkoutAgain: async () => info("checkoutAgain", []),
    checkoutReturn: () => info("checkoutReturn", []),
    loadHistory: async (more) => info("loadHistory", [more]),
    loadProjects: async () => info("loadProjects", []),
    toggleProjectCredits: (id) => info("toggleProjectCredits", [id]),
    openProject: (id) => info("openProject", [id]),
    setProfileField: (key, value) => info("setProfileField", [key, value]),
    saveName: async () => info("saveName", []),
    changePassword: async () => info("changePassword", []),
    adminTab: (tab) => info("adminTab", [tab]),
    adminSearch: (q) => info("adminSearch", [q]),
    adminSelect: async (id) => info("adminSelect", [id]),
    adminField: (key, value) => info("adminField", [key, value]),
    adminAdjust: async (confirmed) => info("adminAdjust", [confirmed]),
    adminCancelConfirm: () => info("adminCancelConfirm", []),
    adminCopy: async (mailId) => info("adminCopy", [mailId]),
    usagePreset: async (preset) => info("usagePreset", [preset]),
    usageRange: async (range) => info("usageRange", [range]),
    usageSource: async (source) => info("usageSource", [source]),
    usageSortUsers: async (key) => info("usageSortUsers", [key]),
    usageToggleUser: async (id) => info("usageToggleUser", [id]),
    usageProjects: async (table, patch) => info("usageProjects", [table, patch]),
    usageToggleProject: (id) => info("usageToggleProject", [id]),
    usageReload: async () => info("usageReload", []),
  };
  return {
    calls,
    ...account,
    async createProject(form) {
      log("createProject", [Object.fromEntries(form.entries())]);
    },
    newProject() {
      log("newProject", []);
      store.setState({ ...projectState(null), route: "start" });
    },
    async sendMessage(text) {
      log("sendMessage", [text]);
      ui({ draft: "", editing: false });
      return true;
    },
    async approve() {
      log("approve", [store.getState().rev]);
    },
    async retry() {
      log("retry", []);
    },
    async setLogo(assetId) {
      log("setLogo", [assetId]);
    },
    async confirmRestart() {
      log("confirmRestart", []);
    },
    async uploadPhotos(files) {
      log("uploadPhotos", [Array.from(files, (f) => f.name)]);
    },
    setFormats(formats) {
      log("setFormats", [formats]);
      ui({ pendingFormats: [...formats] });
    },
    setLanguage(lang) {
      log("setLanguage", [lang]);
    },
    startEdit() {
      calls.push({ name: "startEdit", args: [] });
      ui({ editing: true });
    },
    setDraft(text) {
      calls.push({ name: "setDraft", args: [text] });
      ui({ draft: text });
    },
    setDoneFormat(f) {
      calls.push({ name: "setDoneFormat", args: [f] });
      ui({ doneFormat: f });
    },
  };
}
