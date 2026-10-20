// @vitest-environment happy-dom
/**
 * B1 · Вхід, реєстрація, листи (N1–N2): модалка `views/auth.js`, дії `data/auth-actions.js`,
 * фікстури `dev/fixtures/auth.js`. Мережі немає: дії — на фейковому `api`, наскрізний цикл
 * register → check → (токен) → activated — на стабі `globalThis.fetch` зі справжнім ядром акаунта.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ME, meOf, OLENA } from "../../public/static/dev/fixtures/_base.js";
import fixtures from "../../public/static/dev/fixtures/auth.js";
import type {
  AccountApi,
  Actions,
  AuthState,
  Me,
  PartDeps,
  PendingStart,
  UiState,
} from "../../public/static/js/contracts.js";
import { createAccountActions } from "../../public/static/js/data/account.js";
import type { Backend } from "../../public/static/js/data/actions.js";
import { ApiError, setUnauthorizedHandler } from "../../public/static/js/data/api.js";
import { authActions, COOLDOWN_MS } from "../../public/static/js/data/auth-actions.js";
import { authState, initialState } from "../../public/static/js/initial.js";
import { PENDING_KEY, savePending } from "../../public/static/js/lib/pending.js";
import { createStore } from "../../public/static/js/store.js";
import {
  authModel,
  ERROR_TEXT,
  mount,
  mountAuthForm,
  passwordHint,
} from "../../public/static/js/views/auth.js";

type Auth = NonNullable<AuthState>;
type Store = ReturnType<typeof createStore<UiState>>;

// ───────────── хелпери ─────────────

const PENDING: PendingStart = {
  url: "zerno.example.com",
  manualText: null,
  hadPhotos: false,
  at: new Date().toISOString(),
};

/** Старт гостя з відкритою модалкою. */
function guestState(
  view: Auth["view"],
  patch: Partial<Auth> = {},
  context: Auth["context"] = "start",
): UiState {
  const base = initialState("start", null);
  return {
    ...base,
    account: { ...base.account, meStatus: "anon" },
    auth: authState(view, context, patch),
  };
}

const signedIn = (balance = 12) => ({ user: OLENA, balance });
const apiError = (status: number, code: string | null, message = "") =>
  new ApiError(message || `Помилка ${status}`, status, code, code ? { error: code, message } : null);

/** Фейкове `account-api`: кожна функція — `vi.fn`. */
function fakeApi() {
  return {
    login: vi.fn(async (_b: { email: string; password: string }) => signedIn()),
    register: vi.fn(async (_b: { name: string; email: string; password: string }) => ({ message: "ok" })),
    activate: vi.fn(async (_t: string) => signedIn(0)),
    resend: vi.fn(async (_e: string) => ({ message: "ok" })),
    forgot: vi.fn(async (_e: string) => ({ message: "ok" })),
    reset: vi.fn(async (_b: { token: string; password: string }) => signedIn()),
    google: vi.fn(async (): Promise<unknown> => {
      throw apiError(501, "not_implemented", "Вхід через Google ще не підключено.");
    }),
  };
}

/**
 * Дії B1 на справжньому store з фейковими ядром (refreshMe, navigate), B2 (startPending),
 * B7 (openTopup) і потоком проєкту; view підписаний на store, як у app.js.
 */
function harness(state: UiState, o: { me?: Me | null; layout?: "modal" | "stage" | "none" } = {}) {
  const store: Store = createStore<UiState>(state);
  const api = fakeApi();
  const backend = { start: vi.fn(async (_id: string) => {}), stop: vi.fn() };
  const me = o.me === undefined ? ME : o.me;
  const core = {
    refreshMe: vi.fn(async () => {
      store.setState((s) => ({
        account: {
          ...s.account,
          me,
          meStatus: me ? "ready" : "anon",
          prices: me?.prices ?? s.account.prices,
        },
      }));
    }),
    navigate: vi.fn(),
    startPending: vi.fn(async () => {}),
    openTopup: vi.fn(),
  };
  let all = core as unknown as Actions;
  const deps: PartDeps = {
    params: new URLSearchParams(),
    api: api as unknown as AccountApi,
    actions: () => all,
    backend: backend as unknown as Backend,
    offline: false,
    onRoute: () => {},
  };
  all = Object.assign(core, authActions(store, deps)) as unknown as Actions;
  const el = document.createElement("div");
  document.body.append(el);
  const ctx = { store, actions: all };
  const layout = o.layout ?? "modal";
  const view =
    layout === "none" ? null : layout === "modal" ? mount(el, ctx) : mountAuthForm(el, ctx, { layout });
  const unsubscribe = store.subscribe((s, prev) => view?.update(s, prev));
  cleanups.push(() => {
    unsubscribe();
    view?.destroy();
    el.remove();
  });
  return { store, api, backend, core, actions: all, el };
}

let cleanups: (() => void)[] = [];

/** Вузол за селектором (у документі). */
function $<T extends Element = HTMLElement>(selector: string, root: ParentNode = document): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`немає ${selector}`);
  return el;
}

/** Видимий: сам вузол і жоден предок не `hidden`. */
const visible = (el: Element | null) => !!el && !el.closest("[hidden]");

/** Видимий текст вузла: текстові вузли через пробіл, без зайвих пробілів. */
function visibleText(node: Element) {
  const clone = node.cloneNode(true) as HTMLElement;
  for (const hidden of clone.querySelectorAll("[hidden]")) hidden.remove();
  const parts: string[] = [];
  const walk = (n: Node) => {
    if (n.nodeType === Node.TEXT_NODE) parts.push(n.textContent ?? "");
    else for (const c of n.childNodes) walk(c);
  };
  walk(clone);
  return parts
    .join(" ")
    .replace(/\s+/g, " ")
    .replace(/ ([.,])/g, "$1")
    .trim();
}

/** Текст форми (лише видимі частини). */
const formText = (root: ParentNode = document) => visibleText($<HTMLFormElement>(".au-form", root));

function type(name: string, value: string) {
  const input = $<HTMLInputElement>(`.au-form input[name="${name}"]`);
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function submit() {
  $<HTMLFormElement>(".au-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

function key(k: string, shift = false) {
  const e = new KeyboardEvent("keydown", { key: k, shiftKey: shift, bubbles: true, cancelable: true });
  (document.activeElement ?? document.body).dispatchEvent(e);
  return e;
}

/** Дати промісам і setState відпрацювати. */
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

const button = (label: string) => {
  const found = [...document.querySelectorAll<HTMLButtonElement>(".au-form button")].find(
    (b) => visible(b) && (b.textContent ?? "").replace(/\s+/g, " ").trim().startsWith(label),
  );
  if (!found) throw new Error(`немає кнопки «${label}»`);
  return found;
};

const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
const info = vi.spyOn(console, "info").mockImplementation(() => {});

beforeEach(() => {
  history.replaceState(null, "", "/");
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  for (const fn of cleanups) fn();
  cleanups = [];
  document.documentElement.classList.remove("au-lock");
  document.body.replaceChildren();
  setUnauthorizedHandler(null);
  localStorage.clear();
  sessionStorage.clear();
  warn.mockClear();
  info.mockClear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ───────────── фікстури ─────────────

/** Усі 29 станів N1–N2 з карти Референсу (`#M`) і текст, який є лише в цьому стані. */
const STATES: [string, string, string][] = [
  ["n1-login", "Вхід", "Забули пароль?"],
  ["n1-login-filled", "Вхід", "Увійти"],
  ["n1-login-busy", "Вхід", "Входжу…"],
  ["n1-login-invalid", "Вхід", "Невірний e-mail або пароль."],
  ["n1-login-notact", "Вхід", "Надіслати лист ще раз"],
  ["n1-login-notact-sent", "Вхід", "Лист надіслано ще раз — перевірте пошту."],
  ["n1-login-rate", "Вхід", "Забагато спроб. Спробуйте за 15 хвилин."],
  ["n1-login-net", "Вхід", "Немає з’єднання. Перевірте інтернет — дані у формі збережені."],
  ["n1-google", "Вхід", "Вхід через Google ще не підключено."],
  ["n1-register", "Новий акаунт", "від 8 до 128 символів"],
  ["n1-register-hint", "Новий акаунт", "ще 3 символи"],
  ["n1-register-ok", "Новий акаунт", "Сховати"],
  ["n1-register-weak", "Новий акаунт", "Пароль — від 8 до 128 символів."],
  ["n1-register-busy", "Новий акаунт", "Створюю…"],
  ["n2-check", "Перевірте пошту.", "Надіслати ще раз · 0:42"],
  ["n2-check-ready", "Перевірте пошту.", "olena@zerno.example.com Надіслати ще раз Інша адреса"],
  ["n2-check-sent", "Перевірте пошту.", "Лист надіслано ще раз."],
  ["n2-activating", "Перевіряю посилання", "Активую акаунт…"],
  ["n2-activated", "Вхід виконано", "потрібно 10 кредитів, у вас 0 кредитів."],
  ["n2-activated-bonus", "Вхід виконано", "+5 · вітальний бонус нараховано"],
  ["n2-activated-plain", "Вхід виконано", "На старт"],
  [
    "n2-act-invalid",
    "Посилання недійсне або застаріло",
    "Вкажіть адресу — надішлю нове посилання для активації.",
  ],
  ["n2-act-invalid-sent", "Посилання недійсне або застаріло", "новий лист уже в дорозі."],
  ["n2-forgot", "Забули пароль?", "Надіслати посилання"],
  ["n2-forgot-sent", "Перевірте пошту.", "Якщо акаунт існує, ми надіслали лист для скидання пароля."],
  ["n2-reset", "Новий пароль", "Зберегти й увійти"],
  ["n2-reset-weak", "Новий пароль", "Пароль — від 8 до 128 символів."],
  ["n2-reset-invalid", "Посилання недійсне або застаріло", "Надіслати нове посилання"],
  ["n2-reset-done", "Вхід виконано", "Новий пароль збережено. Інші сесії завершено."],
];

describe("фікстури N1–N2", () => {
  it("є всі 29 станів карти Референсу (+ n1-register-filled з F1) і нічого зайвого", () => {
    const names = STATES.map(([n]) => n);
    expect(Object.keys(fixtures).sort()).toEqual([...names, "n1-register-filled"].sort());
  });

  it.each(STATES)("%s — модалка з заголовком і текстом стану", (name, title, mark) => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(Date.now());
    const state = fixtures[name] as UiState;
    harness(state);
    expect(visible($(".au-overlay"))).toBe(true);
    expect($(".au-dialog").getAttribute("role")).toBe("dialog");
    expect($(".au-dialog").getAttribute("aria-modal")).toBe("true");
    expect(visibleText($(".au-title"))).toBe(title);
    expect(formText()).toContain(mark);
    // Анотації прототипу в продукт не потрапляють.
    expect(formText()).not.toMatch(/копірайт UI|прототип/i);
  });
});

// ───────────── модель і view ─────────────

describe("authModel", () => {
  it("контекст-рядок: відкладений старт, оплата, сесія", () => {
    const s = guestState("login");
    const withPending = { ...s, account: { ...s.account, pending: PENDING } };
    expect(authModel(withPending).context).toEqual({
      before: "Ролик для ",
      host: "zerno.example.com",
      after: " почнеться після входу.",
    });
    const check = { ...withPending, auth: authState("check", "start") };
    expect(authModel(check).context?.before).toBe("Після активації почну ролик для ");
    const checkout = {
      ...guestState("login", {}, "checkout"),
      route: "checkout" as const,
      checkout: {
        status: "loading" as const,
        id: "t_9q4m",
        topup: null,
        returnTo: { kind: "cabinet" as const },
        revisit: false,
      },
    };
    expect(authModel(checkout).context).toEqual({
      before: "Після входу відкрию оплату ",
      host: "t_9q4m",
      after: ".",
    });
    const project = {
      ...initialState("project", "p1"),
      route: "project" as const,
      site: "zerno.example.com",
      session: "401" as const,
      auth: authState("login", "session"),
    };
    const m = authModel(project);
    expect(m.eyebrow).toBe("Сесія завершилась");
    expect(m.title).toBe("Увійдіть ще раз");
    expect(m.seg).toBe(false);
    expect(m.closable).toBe(false);
    expect(m.context).toEqual({
      before: "Після входу відкрию ",
      host: "zerno.example.com",
      after: " на тому ж місці.",
    });
  });

  it("помилка сервера — його message; без нього — копірайт UI", () => {
    const s = guestState("login", { error: "invalid_credentials" });
    expect(authModel(s).errorText).toBe(ERROR_TEXT.invalid_credentials);
    const withMessage = guestState("login", { error: "invalid_credentials", message: "Сервер каже інакше." });
    expect(authModel(withMessage).errorText).toBe("Сервер каже інакше.");
    expect(authModel(guestState("login", { error: "google", message: "Google: 501" })).google?.message).toBe(
      "Google: 501",
    );
  });

  it("підказка довжини пароля і кулдаун", () => {
    expect(passwordHint(0)).toEqual({ text: "від 8 до 128 символів", ok: false });
    expect(passwordHint(7).text).toBe("ще 1 символ");
    expect(passwordHint(3).text).toBe("ще 5 символів");
    expect(passwordHint(8)).toEqual({ text: "✓ достатньо", ok: true });
    const now = 1_000_000;
    const m = authModel(guestState("check", { email: "a@b.ua", cooldownUntil: now + 42_000 }), now);
    expect(m.check?.resend).toBe("Надіслати ще раз · 0:42");
    expect(m.check?.resendDisabled).toBe(true);
  });
});

describe("автозаповнення", () => {
  it("login — username/current-password; register — email/new-password; reset — new-password", () => {
    const { actions } = harness(guestState("login"));
    expect($("input[name=email]").getAttribute("autocomplete")).toBe("username");
    expect($("input[name=password]").getAttribute("autocomplete")).toBe("current-password");
    actions.openAuth("register");
    expect($("input[name=email]").getAttribute("autocomplete")).toBe("email");
    expect($("input[name=password]").getAttribute("autocomplete")).toBe("new-password");
    expect($("input[name=name]").getAttribute("autocomplete")).toBe("name");
    actions.openAuth("reset");
    expect($("input[name=password]").getAttribute("autocomplete")).toBe("new-password");
  });
});

// ───────────── клавіатура, фокус, закриття ─────────────

describe("модалка: фокус, Tab, Esc, підкладка", () => {
  it("фокус на перше поле; Tab і Shift+Tab по колу всередині; Esc закриває і повертає фокус на тригер", () => {
    const trigger = document.createElement("button");
    trigger.textContent = "Увійти";
    document.body.append(trigger);
    trigger.focus();
    const { store, actions } = harness({ ...guestState("login"), auth: null });
    expect(visible($(".au-overlay"))).toBe(false);
    actions.openAuth("login", "header");
    expect(document.documentElement.classList.contains("au-lock")).toBe(true);
    const email = $("input[name=email]");
    expect(document.activeElement).toBe(email);

    const google = button("Увійти через Google");
    google.focus();
    expect(key("Tab").defaultPrevented).toBe(true);
    // Перший доступний елемент модалки — «Закрити».
    expect(document.activeElement).toBe($(".au-close"));
    key("Tab", true);
    expect(document.activeElement).toBe(google);

    key("Escape");
    expect(store.getState().auth).toBeNull();
    expect(visible($(".au-overlay"))).toBe(false);
    expect(document.documentElement.classList.contains("au-lock")).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  it("клік по підкладці й «Закрити» = closeAuth", () => {
    const { store, actions } = harness(guestState("login"));
    $<HTMLElement>(".au-scrim").click();
    expect(store.getState().auth).toBeNull();
    actions.openAuth("forgot", "header");
    $<HTMLButtonElement>(".au-close").click();
    expect(store.getState().auth).toBeNull();
  });

  it("activating і контекст session не закриваються (Esc, підкладка), «Закрити» немає", () => {
    const { store } = harness(guestState("activating", { token: "t" }, null));
    expect(visible($(".au-close"))).toBe(false);
    key("Escape");
    $<HTMLElement>(".au-scrim").click();
    expect(store.getState().auth?.view).toBe("activating");
    store.setState({ auth: authState("login", "session"), route: "cabinet" });
    expect(visible($(".au-close"))).toBe(false);
    key("Escape");
    expect(store.getState().auth).toMatchObject({ view: "login", context: "session" });
    expect(formText()).toContain("Увійдіть ще раз");
  });

  it("Enter у формі надсилає (submit → submitAuth); перемикач Вхід | Реєстрація", async () => {
    const { store, api } = harness(guestState("login"));
    type("email", " olena@zerno.example.com ");
    type("password", "kava2026!");
    submit();
    await flush();
    expect(api.login).toHaveBeenCalledWith({ email: "olena@zerno.example.com", password: "kava2026!" });
    expect(store.getState().auth).toBeNull();

    store.setState({ auth: authState("login", "start", { email: "x@y.ua" }) });
    $<HTMLButtonElement>('.au-seg__opt[data-view="register"]').click();
    expect(store.getState().auth).toMatchObject({ view: "register", context: "start", email: "x@y.ua" });
    expect($('.au-seg__opt[data-view="register"]').getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe($("input[name=name]"));
  });

  it("«Показати / Сховати» пароль — aria-pressed і type", () => {
    harness(guestState("login", { password: "secret" }));
    const toggle = $<HTMLButtonElement>(".au-pw-toggle");
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    toggle.click();
    expect($<HTMLInputElement>("input[name=password]").type).toBe("text");
    expect(toggle.textContent).toBe("Сховати");
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
  });

  it("route project + session 401 — модалки немає; сцена малює форму layout stage", () => {
    const state: UiState = {
      ...initialState("project", "p1"),
      route: "project",
      site: "zerno.example.com",
      session: "401",
      auth: authState("login", "session", { email: "olena@zerno.example.com" }),
    };
    const modal = harness(state);
    expect(visible($(".au-overlay", modal.el))).toBe(false);
    expect(document.documentElement.classList.contains("au-lock")).toBe(false);
    const stage = harness(state, { layout: "stage" });
    const form = $<HTMLFormElement>(".au-form", stage.el);
    expect(form.classList.contains("au-form--stage")).toBe(true);
    expect(formText(stage.el)).toContain("Увійдіть ще раз");
    expect(formText(stage.el)).toContain("Після входу відкрию zerno.example.com на тому ж місці.");
    expect(visible($(".au-close", stage.el))).toBe(false);
    expect($<HTMLInputElement>("input[name=email]", stage.el).value).toBe("olena@zerno.example.com");
  });
});

// ───────────── дії ─────────────

describe("вхід", () => {
  it("порожні поля — empty без запиту", async () => {
    const { store, api } = harness(guestState("login"));
    submit();
    await flush();
    expect(api.login).not.toHaveBeenCalled();
    expect(store.getState().auth?.error).toBe("empty");
    expect(formText()).toContain("Заповніть e-mail і пароль.");
  });

  it("busy: «Входжу…», кнопка disabled; успіх → refreshMe, модалка закрита", async () => {
    let release: (v: unknown) => void = () => {};
    const { store, api, core } = harness(guestState("login", { email: "a@b.ua", password: "12345678" }));
    api.login.mockImplementationOnce(() => new Promise((r) => (release = r)) as never);
    submit();
    await flush();
    expect(store.getState().auth?.busy).toBe(true);
    const btn = $<HTMLButtonElement>(".au-submit");
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toContain("Входжу…");
    release(signedIn());
    await flush();
    expect(core.refreshMe).toHaveBeenCalledOnce();
    expect(store.getState().auth).toBeNull();
    expect(core.startPending).not.toHaveBeenCalled();
  });

  it("401 / 403 / 429 — текст сервера; not_activated → «Надіслати лист ще раз» → resend", async () => {
    const { store, api } = harness(guestState("login", { email: "a@b.ua", password: "12345678" }));
    api.login.mockRejectedValueOnce(
      apiError(401, "invalid_credentials", "Невірний e-mail або пароль (сервер)."),
    );
    submit();
    await flush();
    expect(store.getState().auth).toMatchObject({ error: "invalid_credentials", fails: 1, busy: false });
    expect($(".au-error").textContent).toBe("Невірний e-mail або пароль (сервер).");
    expect($("input[name=email]").getAttribute("aria-invalid")).toBe("true");
    expect($(".au-error").getAttribute("role")).toBe("alert");

    expect(store.getState().auth?.message).toBe("Невірний e-mail або пароль (сервер).");
    // Правка поля знімає помилку разом із текстом сервера.
    type("password", "123456789");
    expect(store.getState().auth).toMatchObject({ error: null, message: null });

    api.login.mockRejectedValueOnce(apiError(403, "not_activated", "Ще не активовано (сервер)."));
    submit();
    await flush();
    expect($(".au-error").textContent).toBe("Ще не активовано (сервер).");
    button("Надіслати лист ще раз").click();
    await flush();
    expect(api.resend).toHaveBeenCalledWith("a@b.ua");
    expect(store.getState().auth).toMatchObject({ error: "not_activated", resent: true });
    expect($(".au-error").textContent).toBe("Ще не активовано (сервер).");
    expect(formText()).toContain("Лист надіслано ще раз — перевірте пошту.");
    // Зміна перегляду скидає помилку і текст сервера.
    button("Забули пароль?").click();
    expect(store.getState().auth).toMatchObject({ view: "forgot", error: null, message: null });
    button("← До входу").click();

    api.login.mockRejectedValueOnce(apiError(429, "rate_limited", "Забагато спроб (сервер)."));
    type("password", "1234567890");
    submit();
    await flush();
    expect($(".au-error").textContent).toBe("Забагато спроб (сервер).");
    expect($<HTMLButtonElement>(".au-submit").disabled).toBe(true);
    // rate_limited тримається і після правки поля; повторного запиту немає.
    type("password", "x1234567890");
    submit();
    await flush();
    expect(api.login).toHaveBeenCalledTimes(3);
    expect($<HTMLButtonElement>(".au-submit").disabled).toBe(true);
  });

  it("невідома відмова (500) — рядок помилки з текстом сервера; 501 Google — рядок-статус", async () => {
    const { store, api } = harness(guestState("login", { email: "a@b.ua", password: "12345678" }));
    api.login.mockRejectedValueOnce(apiError(500, "internal", "Збій сервера."));
    submit();
    await flush();
    expect(store.getState().auth?.error).toBe("network");
    expect($(".au-error").textContent).toBe("Збій сервера.");
    api.google.mockRejectedValueOnce(apiError(501, "not_implemented", "Google: ще ні."));
    button("Увійти через Google").click();
    await flush();
    expect(store.getState().auth?.error).toBe("google");
    expect($(".au-google__msg").textContent).toContain("Google: ще ні.");
  });

  it("мережа — копірайт UI, дані у формі лишаються", async () => {
    const { store, api } = harness(guestState("login", { email: "a@b.ua", password: "12345678" }));
    api.login.mockRejectedValueOnce(new ApiError("x", 0, "network", null));
    submit();
    await flush();
    expect($(".au-error").textContent).toBe(ERROR_TEXT.network);
    expect(store.getState().auth).toMatchObject({ email: "a@b.ua", password: "12345678" });
  });

  it("є відкладений старт на старті → startPending() після входу", async () => {
    savePending(PENDING, []);
    const { core } = harness(guestState("login", { email: "a@b.ua", password: "12345678" }));
    submit();
    await flush();
    expect(core.refreshMe).toHaveBeenCalled();
    expect(core.startPending).toHaveBeenCalledOnce();
  });

  it("checkout: лише refreshMe (чек перезавантажує ядро через onRoute), без startPending", async () => {
    savePending(PENDING, []);
    const state = {
      ...guestState("login", { email: "a@b.ua", password: "12345678" }, "checkout"),
      route: "checkout" as const,
    };
    const { core, backend, store } = harness(state);
    submit();
    await flush();
    expect(core.refreshMe).toHaveBeenCalledOnce();
    expect(core.startPending).not.toHaveBeenCalled();
    expect(backend.start).not.toHaveBeenCalled();
    expect(store.getState().auth).toBeNull();
  });

  it("сесія 401 на project: після входу session null і перезапуск потоку проєкту", async () => {
    const state: UiState = {
      ...initialState("project", "p1"),
      route: "project",
      session: "401",
      auth: authState("login", "session", { email: "a@b.ua", password: "12345678" }),
    };
    const { store, backend, core } = harness(state, { layout: "stage" });
    submit();
    await flush();
    expect(core.refreshMe).toHaveBeenCalled();
    expect(store.getState().session).toBeNull();
    expect(store.getState().auth).toBeNull();
    expect(backend.start).toHaveBeenCalledWith("p1");
  });

  it("відповідь після закриття модалки відкидається, але вхід (cookie) оновлює me", async () => {
    let release: (v: unknown) => void = () => {};
    const { store, api, actions, core } = harness(
      guestState("login", { email: "a@b.ua", password: "12345678" }),
    );
    api.login.mockImplementationOnce(() => new Promise((r) => (release = r)) as never);
    submit();
    await flush();
    actions.closeAuth();
    release(signedIn());
    await flush();
    expect(store.getState().auth).toBeNull();
    expect(core.refreshMe).toHaveBeenCalledOnce();
  });

  it("Google → 501 → рядок-статус з текстом сервера", async () => {
    const { store, api } = harness(guestState("login"));
    button("Увійти через Google").click();
    await flush();
    expect(api.google).toHaveBeenCalledOnce();
    expect(store.getState().auth?.error).toBe("google");
    expect($(".au-google__msg").textContent).toContain("Вхід через Google ще не підключено.");
    expect($(".au-google__msg").getAttribute("role")).toBe("status");
    expect(visible($(".au-error"))).toBe(false);
  });

  it("«Забули пароль?» → forgot з тим самим e-mail → forgotSent → «Надіслати ще раз»", async () => {
    const { store, api } = harness(guestState("login", { email: "a@b.ua" }));
    button("Забули пароль?").click();
    expect(store.getState().auth).toMatchObject({ view: "forgot", email: "a@b.ua" });
    submit();
    await flush();
    expect(api.forgot).toHaveBeenCalledWith("a@b.ua");
    expect(store.getState().auth?.view).toBe("forgotSent");
    button("Надіслати ще раз").click();
    await flush();
    expect(api.forgot).toHaveBeenCalledTimes(2);
    expect(formText()).toContain("Лист надіслано ще раз.");
    button("Інша адреса").click();
    expect(store.getState().auth?.view).toBe("forgot");
  });
});

describe("реєстрація і лист", () => {
  it("клієнтська перевірка не робить запиту: empty_name, bad_email, weak_password", async () => {
    const { store, api } = harness(guestState("register"));
    submit();
    await flush();
    expect(store.getState().auth?.error).toBe("empty_name");
    expect(formText()).toContain("Вкажіть ім’я — до 80 символів.");
    type("name", "Олена");
    type("email", "olena@");
    submit();
    await flush();
    expect(store.getState().auth?.error).toBe("bad_email");
    expect(formText()).toContain("Схоже, в адресі помилка.");
    type("email", "olena@zerno.example.com");
    type("password", "kava");
    expect(formText()).toContain("ще 4 символи");
    submit();
    await flush();
    expect(store.getState().auth?.error).toBe("weak_password");
    expect($("input[name=password]").getAttribute("aria-invalid")).toBe("true");
    expect(api.register).not.toHaveBeenCalled();
  });

  it("400 weak_password від сервера — його текст", async () => {
    const { api } = harness(guestState("register", { name: "О", email: "a@b.ua", password: "12345678" }));
    api.register.mockRejectedValueOnce(apiError(400, "weak_password", "Слабкий (сервер)."));
    submit();
    await flush();
    expect($(".au-error").textContent).toBe("Слабкий (сервер).");
  });

  it("202 → check; кулдаун 60 с «0:42» щосекунди; потім «Надіслати ще раз» → resent і новий кулдаун", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    savePending(PENDING, []);
    const { store, api } = harness(
      guestState("register", { name: "Олена", email: "olena@zerno.example.com", password: "kava2026!" }),
    );
    submit();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.register).toHaveBeenCalledWith({
      name: "Олена",
      email: "olena@zerno.example.com",
      password: "kava2026!",
    });
    expect(store.getState().auth).toMatchObject({ view: "check", password: "", busy: false });
    expect(store.getState().auth?.cooldownUntil).toBe(Date.now() + COOLDOWN_MS);
    expect(formText()).toContain("Після активації почну ролик для zerno.example.com.");
    expect(formText()).toContain("olena@zerno.example.com");
    const resend = () => button("Надіслати ще раз");
    expect(resend().textContent).toBe("Надіслати ще раз · 1:00");
    expect(resend().disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(18_000);
    expect(resend().textContent).toBe("Надіслати ще раз · 0:42");
    resend().click();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.resend).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(42_000);
    expect(resend().textContent).toBe("Надіслати ще раз");
    expect(resend().disabled).toBe(false);
    resend().click();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.resend).toHaveBeenCalledWith("olena@zerno.example.com");
    expect(store.getState().auth?.resent).toBe(true);
    expect(formText()).toContain("Лист надіслано ще раз.");
    expect(resend().textContent).toBe("Надіслати ще раз · 1:00");
    // «Інша адреса» → назад до реєстрації.
    button("Інша адреса").click();
    expect(store.getState().auth?.view).toBe("register");
  });
});

describe("посилання з листа", () => {
  it("activating → POST activate → refreshMe → activated без старту («На старт» / «До кабінету»)", async () => {
    const { store, api, actions, core } = harness(guestState("activating", { token: "tok1" }, null), {
      me: meOf(OLENA, 5),
    });
    api.activate.mockResolvedValueOnce(signedIn(5));
    expect(formText()).toContain("Активую акаунт…");
    await actions.submitAuth();
    await flush();
    expect(api.activate).toHaveBeenCalledWith("tok1");
    expect(core.refreshMe).toHaveBeenCalled();
    expect(store.getState().auth).toMatchObject({ view: "activated", bonus: 5, token: null });
    expect(formText()).toContain("+5 · вітальний бонус нараховано");
    expect($(".au-balance__num").textContent).toBe("5");
    expect($(".au-balance__word").textContent).toBe("кредитів");
    button("До кабінету").click();
    expect(store.getState().auth).toBeNull();
    expect(core.navigate).toHaveBeenCalledWith({ route: "cabinet", section: "balance" });
  });

  it("є відкладений старт і вистачає на ролик → closeAuth + startPending", async () => {
    savePending(PENDING, []);
    const { store, actions, core } = harness(guestState("activating", { token: "t" }, null), {
      me: meOf(OLENA, 25),
    });
    await actions.submitAuth();
    await flush();
    expect(store.getState().auth).toBeNull();
    expect(core.startPending).toHaveBeenCalledOnce();
  });

  it("є відкладений старт, але не вистачає → activated з карткою і «Поповнити» → openTopup(start)", async () => {
    savePending(PENDING, []);
    const { store, actions, core } = harness(guestState("activating", { token: "t" }, null), {
      me: meOf(OLENA, 0),
    });
    await actions.submitAuth();
    await flush();
    expect(store.getState().auth?.view).toBe("activated");
    expect(core.startPending).not.toHaveBeenCalled();
    expect(formText()).toContain(
      "Для ролика zerno.example.com потрібно 10 кредитів, у вас 0 кредитів. Поповніть — і ролик почнеться сам.",
    );
    expect($(".au-short").getAttribute("role")).toBe("alert");
    button("Поповнити").click();
    expect(store.getState().auth).toBeNull();
    expect(core.openTopup).toHaveBeenCalledWith({ from: "start" });
  });

  it("ціни невідомі (account.prices null) → без картки нестачі; «Почати ролик» → startPending", async () => {
    savePending(PENDING, []);
    const { store, actions, core } = harness(guestState("activating", { token: "t" }, null), { me: null });
    await actions.submitAuth();
    await flush();
    expect(store.getState().account.prices).toBeNull();
    expect(store.getState().auth?.view).toBe("activated");
    expect(visible($(".au-short"))).toBe(false);
    button("Почати ролик").click();
    await flush();
    expect(store.getState().auth).toBeNull();
    expect(core.startPending).toHaveBeenCalledOnce();
    expect(core.openTopup).not.toHaveBeenCalled();
  });

  it("invalid_token → activateInvalid → e-mail → resend", async () => {
    const { store, api, actions } = harness(guestState("activating", { token: "bad" }, null));
    api.activate.mockRejectedValueOnce(apiError(400, "invalid_token", "Посилання недійсне або застаріло."));
    await actions.submitAuth();
    await flush();
    expect(store.getState().auth).toMatchObject({ view: "activateInvalid", error: null, token: null });
    expect(visible($(".au-error"))).toBe(false);
    type("email", "a@b.ua");
    submit();
    await flush();
    expect(api.resend).toHaveBeenCalledWith("a@b.ua");
    expect(formText()).toContain("Якщо адреса чекає на активацію, новий лист уже в дорозі.");
    button("До входу").click();
    expect(store.getState().auth?.view).toBe("login");
  });

  it("reset: weak — без запиту; успіх → refreshMe → resetDone; invalid_token → resetInvalid → forgot", async () => {
    const { store, api, core } = harness(guestState("reset", { token: "rt", password: "kava" }, null));
    submit();
    await flush();
    expect(api.reset).not.toHaveBeenCalled();
    expect(store.getState().auth?.error).toBe("weak_password");
    type("password", "Zerno-ranok");
    submit();
    await flush();
    expect(api.reset).toHaveBeenCalledWith({ token: "rt", password: "Zerno-ranok" });
    expect(core.refreshMe).toHaveBeenCalled();
    expect(store.getState().auth).toMatchObject({ view: "resetDone", password: "" });
    button("На старт").click();
    expect(store.getState().auth).toBeNull();

    store.setState({ auth: authState("reset", null, { token: "old", password: "Zerno-ranok" }) });
    api.reset.mockRejectedValueOnce(apiError(400, "invalid_token", "Посилання недійсне або застаріло."));
    submit();
    await flush();
    expect(store.getState().auth?.view).toBe("resetInvalid");
    button("Надіслати нове посилання").click();
    expect(store.getState().auth?.view).toBe("forgot");
  });
});

// ───────────── наскрізно: справжнє ядро + стаб fetch ─────────────

type Route = { status: number; body?: unknown };
type Body = Record<string, unknown>;

/** Стаб `fetch`: `METHOD /path` → відповідь (функція — з тілом запиту). */
function stubFetch(routes: Record<string, Route | ((body: Body) => Route)>) {
  const calls: { method: string; path: string; body: Body | null }[] = [];
  const fetch = vi.fn(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Body) : null;
    calls.push({ method, path, body });
    const route = routes[`${method} ${path}`];
    const reply =
      typeof route === "function"
        ? route(body ?? {})
        : (route ?? { status: 404, body: { error: "not_found" } });
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      json: async () => reply.body ?? null,
    };
  });
  vi.stubGlobal("fetch", fetch);
  return calls;
}

const UNAUTH = { status: 401, body: { error: "unauthorized", message: "Потрібен вхід." } };

/** Справжнє ядро акаунта + view модалки. */
function realApp(query: string) {
  const store = createStore<UiState>(initialState("start", null));
  const backend = { start: vi.fn(async () => {}), stop: vi.fn() } as unknown as Backend;
  const actions = createAccountActions(store, { params: new URLSearchParams(query), backend });
  const el = document.createElement("div");
  document.body.append(el);
  const view = mount(el, { store, actions });
  const unsubscribe = store.subscribe((s, prev) => view.update(s, prev));
  cleanups.push(() => {
    unsubscribe();
    view.destroy();
    actions.dispose();
    el.remove();
  });
  return { store, actions };
}

describe("наскрізний цикл на стабі fetch", () => {
  it("register → check → посилання з листа (токен прибрано з URL) → activated з нестачею", async () => {
    let me: Route = UNAUTH;
    const calls = stubFetch({
      "GET /api/auth/me": () => me,
      "POST /api/auth/register": {
        status: 202,
        body: { message: "Якщо адреса вільна, ми надіслали лист для активації." },
      },
      "POST /api/auth/activate": (b) =>
        b.token === "Qm4xT9vLr2nW8sYp"
          ? { status: 200, body: { user: OLENA, balance: 0 } }
          : { status: 400, body: { error: "invalid_token", message: "Посилання недійсне або застаріло." } },
      "GET /api/projects": { status: 200, body: { projects: [] } },
    });

    // 1. Гість на старті: відкладений старт і реєстрація.
    const a = realApp("");
    await a.actions.meReady;
    expect(a.store.getState().account.meStatus).toBe("anon");
    savePending(PENDING, []);
    a.actions.openAuth("register", "start");
    expect(formText()).toContain("Ролик для zerno.example.com почнеться після входу.");
    type("name", "Олена Коваль");
    type("email", "olena@zerno.example.com");
    type("password", "kava2026!");
    submit();
    await flush();
    expect(calls.find((c) => c.path === "/api/auth/register")?.body).toEqual({
      name: "Олена Коваль",
      email: "olena@zerno.example.com",
      password: "kava2026!",
    });
    expect(a.store.getState().auth?.view).toBe("check");
    expect(localStorage.getItem(PENDING_KEY)).not.toBeNull();
    for (const fn of cleanups.splice(0)) fn();

    // 2. Посилання з листа в новій вкладці.
    history.replaceState(null, "", "/?auth=activate&token=Qm4xT9vLr2nW8sYp");
    me = { status: 200, body: meOf(OLENA, 0) };
    const b = realApp("auth=activate&token=Qm4xT9vLr2nW8sYp");
    expect(location.search).toBe("");
    await flush();
    await flush();
    expect(calls.filter((c) => c.path === "/api/auth/activate").map((c) => c.body)).toEqual([
      { token: "Qm4xT9vLr2nW8sYp" },
    ]);
    expect(b.store.getState().account).toMatchObject({ meStatus: "ready", me: { balance: 0 } });
    expect(b.store.getState().auth?.view).toBe("activated");
    expect(formText()).toContain("Вхід виконано");
    expect(formText()).toContain("потрібно 10 кредитів, у вас 0 кредитів.");
  });

  it("login: 401 invalid_credentials з тексту сервера (не unauthorized-хендлер); успіх → me ready", async () => {
    let me: Route = UNAUTH;
    stubFetch({
      "GET /api/auth/me": () => me,
      "POST /api/auth/login": (b) =>
        b.password === "kava2026!"
          ? { status: 200, body: { user: OLENA, balance: 12 } }
          : { status: 401, body: { error: "invalid_credentials", message: "Невірний e-mail або пароль." } },
      "GET /api/projects": { status: 200, body: { projects: [] } },
    });
    const { store, actions } = realApp("");
    await actions.meReady;
    actions.openAuth("login", "header");
    type("email", "olena@zerno.example.com");
    type("password", "kava2025");
    submit();
    await flush();
    expect(store.getState().auth?.error).toBe("invalid_credentials");
    expect($(".au-error").textContent).toBe("Невірний e-mail або пароль.");
    type("password", "kava2026!");
    me = { status: 200, body: meOf(OLENA, 12) };
    submit();
    await flush();
    await flush();
    expect(store.getState().auth).toBeNull();
    expect(store.getState().account).toMatchObject({ meStatus: "ready", me: { balance: 12 } });
  });
});
