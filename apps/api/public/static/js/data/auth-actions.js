// @ts-check
/**
 * B1 · Вхід, реєстрація, листи (N1–N2).
 *
 * Стан — `UiState.auth` (`null` — модалка закрита). Перегляди й переходи:
 * - `login` → `POST login` → `refreshMe()`; контекст `session` на project — `session: null` і
 *   перезапуск потоку (`backend.start`); є відкладений старт на старті — `startPending()`.
 *   Перезавантаження даних захищеного маршруту (чек, кабінет) робить ядро: `refreshMe` переводить
 *   `meStatus` у `ready`, і підписники `onRoute` отримують маршрут ще раз.
 * - `register` → `POST register` → завжди `check` (202 enumeration-safe) з кулдауном 60 с.
 * - `activating` (посилання з листа, ставить ядро) → `POST activate` → `refreshMe()` → є pending і
 *   вистачає на ролик — `closeAuth()` + `startPending()`; інакше `activated`. `invalid_token` →
 *   `activateInvalid` (форма e-mail → `resend`).
 * - `forgot` → `POST forgot` → `forgotSent`; `reset` (посилання з листа) → `POST reset` →
 *   `refreshMe()` → `resetDone`; `invalid_token` → `resetInvalid`.
 * Помилки: клієнтська перевірка (`empty`, `bad_email`, `empty_name`, `weak_password`) запиту не
 * робить; помилка сервера — `error` з коду відповіді, текст — `message` сервера (`authMessage`).
 * Відповідь, що прийшла після закриття модалки чи зміни перегляду, відкидається.
 */
import { authState } from "../initial.js";
import { peekPending } from "../lib/pending.js";
import { ApiError } from "./api.js";

/** @typedef {import("../contracts.js").PartFactory<"openAuth" | "closeAuth" | "setAuthField" | "submitAuth" | "resendAuthMail" | "authGoogle">} Factory */
/** @typedef {import("../contracts.js").Store} Store */
/** @typedef {import("../contracts.js").UiState} UiState */
/** @typedef {import("../contracts.js").AuthView} AuthView */
/** @typedef {import("../contracts.js").AuthError} AuthError */
/** @typedef {import("../contracts.js").AccountApi} AccountApi */
/** @typedef {NonNullable<import("../contracts.js").AuthState>} Auth */

/** Пауза перед повторним листом активації (`check`). */
export const COOLDOWN_MS = 60_000;
/** Довжина пароля (= бекенд, `weak_password`). */
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;
/** Довжина імені (`empty_name`). */
export const NAME_MAX = 80;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Коди відповіді сервера, які мають свій стан форми. @type {ReadonlySet<string>} */
const SERVER_ERRORS = new Set([
  "invalid_credentials",
  "not_activated",
  "rate_limited",
  "weak_password",
  "invalid_token",
]);

/** @param {string} email */
export const isEmail = (email) => EMAIL_RE.test(email.trim());

/**
 * Текст помилки сервера для поточної `auth.error` (його `message`); `null` — помилка клієнтська
 * або сервер тексту не дав, тоді view бере копірайт UI.
 * @type {WeakMap<Store, string>}
 */
const messages = new WeakMap();

/**
 * Текст сервера для помилки модалки входу цього store (`null` — копірайт UI).
 * @param {Store} store
 * @returns {string | null}
 */
export function authMessage(store) {
  return store.getState().auth?.error ? (messages.get(store) ?? null) : null;
}

/**
 * Помилка запиту → стан форми і текст сервера.
 * @param {unknown} err
 * @returns {{ error: AuthError, message: string | null }}
 */
export function errorOf(err) {
  const status = err instanceof ApiError ? err.status : 0;
  const code = err instanceof ApiError ? err.code : "network";
  const body = err instanceof ApiError ? err.body : null;
  const message = body && typeof body.message === "string" && body.message ? body.message : null;
  if (status === 0) return { error: "network", message: null };
  if (code && SERVER_ERRORS.has(code)) return { error: /** @type {AuthError} */ (code), message };
  if (status === 429) return { error: "rate_limited", message };
  if (status === 501) return { error: "google", message };
  // Невідома відмова (5xx, invalid_body): рядок помилки з текстом сервера, якщо він є.
  return { error: "network", message: message ?? (err instanceof Error ? err.message : null) };
}

/**
 * `?mock=1`: мережі акаунтів немає — ті самі переходи на стані (вхід — фейковий `me`).
 * @param {Store} store
 * @returns {Pick<AccountApi, "login" | "register" | "activate" | "resend" | "forgot" | "reset" | "google">}
 */
function offlineApi(store) {
  const signedIn = async () => {
    const me = store.getState().account.me;
    if (!me) throw new ApiError("Немає акаунта", 401, "invalid_credentials", null);
    return { user: me.user, balance: me.balance };
  };
  const accepted = async () => ({ message: "" });
  return {
    login: signedIn,
    activate: signedIn,
    reset: signedIn,
    register: accepted,
    resend: accepted,
    forgot: accepted,
    google: async () => {
      throw new ApiError("Вхід через Google ще не підключено.", 501, "not_implemented", null);
    },
  };
}

/** @type {Factory} */
export const authActions = (store, deps) => {
  const api = deps.offline ? offlineApi(store) : deps.api;
  /** Номер «сеансу» модалки: відкриття, закриття, зміна перегляду. Старі відповіді відкидаються. */
  let seq = 0;

  /** @returns {Auth | null} */
  const auth = () => store.getState().auth;

  /** @param {Partial<Auth>} patch */
  const setAuth = (patch) => store.setState((s) => (s.auth ? { auth: { ...s.auth, ...patch } } : {}));

  /** Відкладений старт з localStorage → `account.pending` (його показує модалка). */
  const syncPending = () => store.setState((s) => ({ account: { ...s.account, pending: peekPending() } }));

  /**
   * @param {AuthError} error
   * @param {string | null} [message]
   * @param {Partial<Auth>} [patch]
   */
  function fail(error, message = null, patch = {}) {
    if (message) messages.set(store, message);
    else messages.delete(store);
    setAuth({ busy: false, error, ...patch });
  }

  /** @param {"activateInvalid" | "resetInvalid"} view */
  function toInvalid(view) {
    seq++;
    messages.delete(store);
    setAuth({ view, busy: false, error: null, token: null, password: "", resent: false });
  }

  /**
   * Запит від імені поточного перегляду: busy на час запиту. Відповідь після закриття модалки чи
   * зміни перегляду — `null`; успіх входу при цьому лише оновлює `me` (cookie вже стоїть).
   * @template T
   * @param {() => Promise<T>} call
   * @param {{ signsIn?: boolean }} [o]
   * @returns {Promise<{ ok: true, value: T } | { ok: false, err: unknown } | null>}
   */
  async function request(call, o = {}) {
    const my = seq;
    messages.delete(store);
    setAuth({ busy: true, error: null });
    try {
      const value = await call();
      if (my === seq && auth()) return { ok: true, value };
      if (o.signsIn) await deps.actions().refreshMe();
      return null;
    } catch (err) {
      return my === seq && auth() ? { ok: false, err } : null;
    }
  }

  /**
   * Вхід виконано (login): оновити `me`, закрити модалку і продовжити те, що чекало на вхід.
   * @param {NonNullable<Auth["context"]>} [context]
   */
  async function signedIn(context) {
    await deps.actions().refreshMe();
    seq++;
    messages.delete(store);
    const s = store.getState();
    if (context === "session" && s.route === "project" && s.session === "401" && s.projectId) {
      const id = s.projectId;
      store.setState({ session: null, auth: null });
      void deps.backend.start(id);
      return;
    }
    store.setState({ auth: null });
    if (s.route === "start" && peekPending()) await deps.actions().startPending();
  }

  async function login() {
    const a = auth();
    if (!a) return;
    const email = a.email.trim();
    if (!email || !a.password) return fail("empty");
    const res = await request(() => api.login({ email, password: a.password }), { signsIn: true });
    if (!res) return;
    if (res.ok) return signedIn(a.context ?? undefined);
    const { error, message } = errorOf(res.err);
    fail(error, message, error === "invalid_credentials" ? { fails: a.fails + 1 } : {});
  }

  async function register() {
    const a = auth();
    if (!a) return;
    const name = a.name.trim();
    const email = a.email.trim();
    if (!name || name.length > NAME_MAX) return fail("empty_name");
    if (!isEmail(email)) return fail("bad_email");
    if (a.password.length < PASSWORD_MIN || a.password.length > PASSWORD_MAX) return fail("weak_password");
    const res = await request(() => api.register({ name, email, password: a.password }));
    if (!res) return;
    if (!res.ok) {
      const { error, message } = errorOf(res.err);
      return fail(error, message);
    }
    seq++;
    setAuth({
      view: "check",
      busy: false,
      error: null,
      password: "",
      showPassword: false,
      resent: false,
      cooldownUntil: Date.now() + COOLDOWN_MS,
    });
    syncPending();
  }

  async function activate() {
    const a = auth();
    if (!a?.token) return toInvalid("activateInvalid");
    const token = a.token;
    const my = seq;
    const res = await request(() => api.activate(token), { signsIn: true });
    if (!res) return;
    if (!res.ok) {
      const { error, message } = errorOf(res.err);
      // Заголовок перегляду вже каже «Посилання недійсне або застаріло» — без рядка помилки.
      if (error === "invalid_token") return toInvalid("activateInvalid");
      return fail(error, message);
    }
    const bonus = res.value.balance > 0 ? res.value.balance : 0;
    await deps.actions().refreshMe();
    syncPending();
    const s = store.getState();
    if (!s.auth || my !== seq) return;
    const me = s.account.me;
    if (s.account.pending && me && me.balance >= me.prices.video) {
      seq++;
      store.setState({ auth: null });
      await deps.actions().startPending();
      return;
    }
    seq++;
    setAuth({ view: "activated", busy: false, error: null, token: null, bonus });
  }

  async function resetPassword() {
    const a = auth();
    if (!a) return;
    if (a.password.length < PASSWORD_MIN || a.password.length > PASSWORD_MAX) return fail("weak_password");
    if (!a.token) return toInvalid("resetInvalid");
    const token = a.token;
    const my = seq;
    const res = await request(() => api.reset({ token, password: a.password }), { signsIn: true });
    if (!res) return;
    if (!res.ok) {
      const { error, message } = errorOf(res.err);
      if (error === "invalid_token") return toInvalid("resetInvalid");
      return fail(error, message);
    }
    await deps.actions().refreshMe();
    if (my !== seq) return;
    seq++;
    setAuth({ view: "resetDone", busy: false, error: null, token: null, password: "", showPassword: false });
  }

  /**
   * Лист ще раз (активація або скидання).
   * @param {(email: string) => Promise<unknown>} send
   * @param {Partial<Auth>} [patch] після успіху
   */
  async function mail(send, patch = {}) {
    const a = auth();
    if (!a) return;
    const email = a.email.trim();
    if (!isEmail(email)) return fail("bad_email");
    // «Надіслати лист ще раз» під not_activated: помилка входу лишається видно разом зі статусом.
    const keep = a.view === "login" ? { error: a.error, message: authMessage(store) } : null;
    const res = await request(() => send(email));
    if (!res) return;
    if (!res.ok) {
      const { error, message } = errorOf(res.err);
      return fail(error, message);
    }
    if (keep?.message) messages.set(store, keep.message);
    setAuth({ busy: false, error: keep?.error ?? null, resent: true, ...patch });
  }

  async function forgot() {
    const a = auth();
    if (!a) return;
    if (!isEmail(a.email)) return fail("bad_email");
    const res = await request(() => api.forgot(a.email.trim()));
    if (!res) return;
    if (!res.ok) {
      const { error, message } = errorOf(res.err);
      return fail(error, message);
    }
    seq++;
    setAuth({ view: "forgotSent", busy: false, error: null, resent: false });
  }

  /** Головна дія переглядів без запиту (Enter у формі = кнопка). */
  function primary() {
    const s = store.getState();
    const a = s.auth;
    if (!a) return;
    const all = deps.actions();
    if (a.view === "resetInvalid") return all.openAuth("forgot");
    if (a.view === "resetDone") {
      all.closeAuth();
      return all.navigate({ route: "cabinet", section: "balance" });
    }
    if (a.view === "activated") {
      const me = s.account.me;
      const pending = s.account.pending;
      all.closeAuth();
      if (pending && me && me.balance < me.prices.video) return all.openTopup({ from: "start" });
      if (pending) return void all.startPending();
      if (s.route !== "start") all.navigate({ route: "start" });
    }
  }

  return {
    openAuth(view, context) {
      const a = auth();
      seq++;
      messages.delete(store);
      if (a && context === undefined) {
        // Перемикання всередині модалки: контекст і введені дані лишаються.
        setAuth({
          view,
          busy: false,
          error: null,
          resent: false,
          ...(view === "register" && a.view === "check" ? { password: "" } : {}),
        });
      } else store.setState({ auth: authState(view, context ?? null) });
      syncPending();
    },

    closeAuth() {
      seq++;
      messages.delete(store);
      if (auth()) store.setState({ auth: null });
    },

    setAuthField(key, value) {
      const a = auth();
      if (!a) return;
      if (key === "showPassword") return setAuth({ showPassword: Boolean(value) });
      const text = String(value);
      if (a[key] === text) return;
      // Правка поля знімає помилку; rate_limited тримається (кнопка заблокована до кінця ліміту).
      const keep = a.error === "rate_limited";
      if (!keep) messages.delete(store);
      setAuth({ [key]: text, ...(keep ? {} : { error: null }) });
    },

    async submitAuth() {
      const a = auth();
      if (!a || a.busy) return;
      if (a.error === "rate_limited") return;
      switch (a.view) {
        case "login":
          return login();
        case "register":
          return register();
        case "activating":
          return activate();
        case "activateInvalid":
          return mail((email) => api.resend(email));
        case "check":
        case "forgotSent":
          return deps.actions().resendAuthMail();
        case "forgot":
          return forgot();
        case "reset":
          return resetPassword();
        default:
          return primary();
      }
    },

    async resendAuthMail() {
      const a = auth();
      if (!a || a.busy) return;
      switch (a.view) {
        case "check":
          if (a.cooldownUntil !== null && a.cooldownUntil > Date.now()) return;
          return mail((email) => api.resend(email), { cooldownUntil: Date.now() + COOLDOWN_MS });
        case "forgotSent":
          return mail((email) => api.forgot(email));
        case "login":
        case "activateInvalid":
          return mail((email) => api.resend(email));
        default:
          return;
      }
    },

    async authGoogle() {
      const a = auth();
      if (!a || a.busy) return;
      const res = await request(() => api.google(), { signsIn: true });
      if (!res) return;
      if (res.ok) return signedIn(a.context ?? undefined);
      const { error, message } = errorOf(res.err);
      fail(error === "network" ? "network" : "google", message);
    },
  };
};
