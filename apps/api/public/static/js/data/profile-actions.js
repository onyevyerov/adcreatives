// @ts-check
/**
 * B10 · Профіль і пароль (N13-A).
 *
 * - Вхід у розділ (`onRoute` cabinet/profile) — свіжа форма: `nameDraft` = поточне ім'я, паролі
 *   порожні, позначки знято.
 * - `setProfileField` — поле форми; будь-яка правка знімає помилки й «✓» (як у Референсі).
 * - `saveName` — клієнтська перевірка (1…80 символів після trim, без запиту) → `PATCH /api/account`
 *   → `refreshMe()` → `saved`. 400 від сервера — та сама помилка імені.
 * - `changePassword` — `POST /api/account/password`: 401 `invalid_credentials` / 400 → `pwError`
 *   (400 — ще й `pwMessage`, текст сервера; знімається правкою поля і новою спробою);
 *   успіх → `pwDone`, поля очищено (cookie нової сесії ставить сервер).
 * - Мережа / 5xx — у кадрах N13 стану немає: busy знімається, введене лишається.
 * У `?mock=1` (`offline`) — без мережі, лише стан.
 */
import { initialCabinet } from "../initial.js";

/** @typedef {import("../contracts.js").PartFactory<"setProfileField" | "saveName" | "changePassword">} Factory */
/** @typedef {import("../contracts.js").Store} Store */
/** @typedef {import("../contracts.js").CabinetState["profile"]} ProfileState */

/** Межа довжини імені (сервер: `name` trim, 1…80). */
export const NAME_MAX = 80;

/** @param {string} name */
export const nameValid = (name) => {
  const n = name.trim();
  return n.length >= 1 && n.length <= NAME_MAX;
};

/** @param {unknown} err */
const statusOf = (err) =>
  typeof err === "object" && err !== null && "status" in err && typeof err.status === "number"
    ? err.status
    : 0;

/** @param {unknown} err */
const codeOf = (err) =>
  typeof err === "object" && err !== null && "code" in err && typeof err.code === "string" ? err.code : null;

/** Текст сервера (`message` з тіла відповіді) або null. @param {unknown} err */
const serverMessage = (err) => {
  const body = typeof err === "object" && err !== null && "body" in err ? err.body : null;
  const message = body && typeof body === "object" && "message" in body ? body.message : null;
  return typeof message === "string" && message ? message : null;
};

/**
 * @param {Store} store
 * @param {Partial<ProfileState>} patch
 */
const setProfile = (store, patch) =>
  store.setState((s) => ({ cabinet: { ...s.cabinet, profile: { ...s.cabinet.profile, ...patch } } }));

/** @type {Factory} */
export const profileActions = (store, deps) => {
  const { api, offline } = deps;

  deps.onRoute((r) => {
    if (r.route !== "cabinet" || r.section !== "profile") return;
    const s = store.getState();
    // Збереження, що ще летить, не перериваємо.
    if (s.cabinet.profile.saving || s.cabinet.profile.pwBusy) return;
    setProfile(store, { ...initialCabinet().profile, nameDraft: s.account.me?.user.name ?? "" });
  });

  return {
    setProfileField(key, value) {
      setProfile(store, {
        [key]: value,
        nameError: false,
        saved: false,
        pwError: null,
        pwMessage: null,
        pwDone: false,
      });
    },

    async saveName() {
      const { profile } = store.getState().cabinet;
      if (profile.saving) return;
      const name = profile.nameDraft.trim();
      if (!nameValid(name)) {
        setProfile(store, { nameError: true, saved: false });
        return;
      }
      setProfile(store, { saving: true, nameError: false, saved: false });
      try {
        if (offline) {
          store.setState((s) => {
            const me = s.account.me;
            return me ? { account: { ...s.account, me: { ...me, user: { ...me.user, name } } } } : {};
          });
        } else {
          await api.patchAccount({ name });
          await deps.actions().refreshMe();
        }
        const draft = store.getState().cabinet.profile.nameDraft;
        setProfile(store, {
          saving: false,
          saved: true,
          ...(draft.trim() === name ? { nameDraft: name } : {}),
        });
      } catch (err) {
        if (statusOf(err) === 400) setProfile(store, { saving: false, nameError: true });
        else {
          // 401 обробило ядро (setUnauthorizedHandler); мережа / 5xx — кадру немає.
          if (statusOf(err) !== 401) console.warn("[profile] saveName", err);
          setProfile(store, { saving: false });
        }
      }
    },

    async changePassword() {
      const { profile } = store.getState().cabinet;
      if (profile.pwBusy) return;
      setProfile(store, { pwBusy: true, pwError: null, pwMessage: null, pwDone: false });
      try {
        if (!offline) await api.changePassword({ current: profile.current, next: profile.next });
        setProfile(store, { pwBusy: false, pwDone: true, current: "", next: "" });
      } catch (err) {
        const status = statusOf(err);
        if (status === 401 && codeOf(err) === "invalid_credentials")
          setProfile(store, { pwBusy: false, pwError: "invalid_credentials" });
        else if (status === 400)
          setProfile(store, { pwBusy: false, pwError: "weak_password", pwMessage: serverMessage(err) });
        else {
          if (status !== 401) console.warn("[profile] changePassword", err);
          setProfile(store, { pwBusy: false });
        }
      }
    },
  };
};
