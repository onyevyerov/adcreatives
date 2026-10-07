// @ts-check
/**
 * Дії-заглушки для режиму `?fixture=<стан>` і для заглушки data/actions.js: мережі немає,
 * виклики пишуться в консоль і в `ui.notice`, а суто UI-дії змінюють стан як справжні.
 */
import { initialState } from "../js/initial.js";

/** @typedef {import("../js/contracts.js").Actions} Actions */
/** @typedef {import("../js/contracts.js").Store} Store */
/** @typedef {import("../js/contracts.js").UiFlags} UiFlags */

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
  return {
    calls,
    async createProject(form) {
      log("createProject", [Object.fromEntries(form.entries())]);
    },
    newProject() {
      log("newProject", []);
      store.setState(initialState("start", null));
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
    answer(text) {
      log("answer", [text]);
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
