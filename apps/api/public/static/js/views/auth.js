// @ts-check
/**
 * B1 · Модалка входу в `#overlay` (N1–N2, Референс `#N1`: контейнер A, поля B).
 *
 * `mount` — модалка: підкладка `--scrim`, картка 560 · padding 44 · радіус 20 (до 599px —
 * повноекранна). Пастка фокусу, Esc і клік по підкладці = «Закрити» (не в `activating`, не в
 * контексті `session`; закриття під час запиту — відповідь відкидається); фокус — на перше поле, після закриття — на тригер.
 * Модалку не показує, коли `route === "project" && session === "401"`: ту саму форму малює сцена
 * (B12) через `mountAuthForm(el, ctx, { layout: "stage" })` за тим самим станом.
 *
 * Форма — один набір вузлів на всі перегляди (`authModel` → `apply`): поля не перестворюються,
 * тож введення, фокус і курсор не губляться. Тексти — з кадрів Референсу дослівно; помилка сервера —
 * його `message` (`auth.message`), без нього — копірайт UI.
 */

import { hostOf } from "../data/api.js";
import { clear, h, text } from "../dom.js";
import { authState } from "../initial.js";
import { creditWord, formatCredits, formatNumber, plural } from "../lib/credits.js";

/** @typedef {import("../contracts.js").UiState} UiState */
/** @typedef {import("../contracts.js").Ctx} Ctx */
/** @typedef {import("../contracts.js").ViewHandle} ViewHandle */
/** @typedef {import("../contracts.js").AuthView} AuthView */
/** @typedef {import("../contracts.js").AuthError} AuthError */
/** @typedef {NonNullable<import("../contracts.js").AuthState>} Auth */
/** @typedef {"name" | "email" | "password"} Field */
/** @typedef {"forgot" | "login" | "back" | "resend" | "cabinet" | "start"} LinkKey */

/** Копірайт UI для помилок (тексти сервера ті самі; показується його `message`, якщо він є). @type {Record<Exclude<AuthError, "google">, string>} */
export const ERROR_TEXT = {
  invalid_credentials: "Невірний e-mail або пароль.",
  not_activated: "Акаунт ще не активовано — перевірте пошту.",
  rate_limited: "Забагато спроб. Спробуйте за 15 хвилин.",
  weak_password: "Пароль — від 8 до 128 символів.",
  network: "Немає з’єднання. Перевірте інтернет — дані у формі збережені.",
  empty: "Заповніть e-mail і пароль.",
  bad_email: "Схоже, в адресі помилка.",
  empty_name: "Вкажіть ім’я — до 80 символів.",
  invalid_token: "Посилання недійсне або застаріло.",
};
export const GOOGLE_TEXT = "Вхід через Google ще не підключено.";

/** Перегляди, у яких форма модалки закривається (Esc, підкладка, «Закрити»). */
const STUCK_VIEWS = /** @type {readonly AuthView[]} */ (["activating"]);

/**
 * @typedef {{ eyebrow: string, title: string, danger?: boolean, dot?: boolean, lead?: string,
 *   fields?: Field[], submit?: string, busyLabel?: string, seg?: boolean, google?: boolean,
 *   links?: [LinkKey, string][], check?: boolean, spinner?: string, balance?: boolean, newPassword?: boolean }} ViewCopy
 */
/** @type {Record<AuthView, ViewCopy>} */
const VIEWS = {
  login: {
    eyebrow: "Вхід",
    title: "Вхід",
    fields: ["email", "password"],
    submit: "Увійти",
    busyLabel: "Входжу…",
    seg: true,
    google: true,
    links: [["forgot", "Забули пароль?"]],
  },
  register: {
    eyebrow: "Реєстрація",
    title: "Новий акаунт",
    lead: "Після реєстрації надішлю лист з посиланням для активації.",
    fields: ["name", "email", "password"],
    newPassword: true,
    submit: "Створити акаунт",
    busyLabel: "Створюю…",
    seg: true,
    google: true,
  },
  check: {
    eyebrow: "Лист надіслано",
    title: "Перевірте пошту",
    dot: true,
    lead: "Якщо адреса вільна, ми надіслали лист для активації.",
    check: true,
  },
  activating: { eyebrow: "Активація", title: "Перевіряю посилання", spinner: "Активую акаунт…" },
  activated: {
    eyebrow: "Акаунт активовано",
    title: "Вхід виконано",
    balance: true,
    links: [["cabinet", "До кабінету"]],
  },
  activateInvalid: {
    eyebrow: "Активація",
    danger: true,
    title: "Посилання недійсне або застаріло",
    lead: "Вкажіть адресу — надішлю нове посилання для активації.",
    fields: ["email"],
    submit: "Надіслати лист ще раз",
    busyLabel: "Надсилаю…",
    links: [["login", "До входу"]],
  },
  forgot: {
    eyebrow: "Скидання пароля",
    title: "Забули пароль?",
    lead: "Надішлю лист з посиланням для нового пароля.",
    fields: ["email"],
    submit: "Надіслати посилання",
    busyLabel: "Надсилаю…",
    links: [["back", "← До входу"]],
  },
  forgotSent: {
    eyebrow: "Лист надіслано",
    title: "Перевірте пошту",
    dot: true,
    lead: "Якщо акаунт існує, ми надіслали лист для скидання пароля.",
    check: true,
  },
  reset: {
    eyebrow: "Скидання пароля",
    title: "Новий пароль",
    lead: "Після збереження я завершу всі інші сесії цього акаунта.",
    fields: ["password"],
    newPassword: true,
    submit: "Зберегти й увійти",
    busyLabel: "Зберігаю…",
  },
  resetInvalid: {
    eyebrow: "Скидання пароля",
    danger: true,
    title: "Посилання недійсне або застаріло",
    lead: "Посилання для скидання діє 1 годину і лише один раз.",
    submit: "Надіслати нове посилання",
  },
  resetDone: {
    eyebrow: "Пароль змінено",
    title: "Вхід виконано",
    lead: "Новий пароль збережено. Інші сесії завершено.",
    submit: "До кабінету",
    links: [["start", "На старт"]],
  },
};

const EMAIL_ERRORS = /** @type {readonly AuthError[]} */ (["invalid_credentials", "bad_email", "empty"]);
const PASSWORD_ERRORS = /** @type {readonly AuthError[]} */ ([
  "invalid_credentials",
  "weak_password",
  "empty",
]);

/**
 * Секунди кулдауну → «0:42».
 * @param {number} sec
 */
export const clock = (sec) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;

/**
 * Підказка довжини нового пароля праворуч від label.
 * @param {number} len
 * @returns {{ text: string, ok: boolean }}
 */
export function passwordHint(len) {
  if (len === 0) return { text: "від 8 до 128 символів", ok: false };
  if (len < 8)
    return { text: `ще ${8 - len} ${plural(8 - len, ["символ", "символи", "символів"])}`, ok: false };
  return { text: "✓ достатньо", ok: true };
}

/** Можна закрити модалку (Esc, підкладка, «Закрити»). @param {Auth} a */
export const closable = (a) => a.context !== "session" && (!STUCK_VIEWS.includes(a.view) || a.error !== null);

/** Модалка видима: є стан входу і це не сцена 401 у проєкті (там форму малює B12). @param {UiState} s */
export const modalOpen = (s) => s.auth !== null && !(s.route === "project" && s.session === "401");

/**
 * Опис форми для стану (чиста функція; її ж перевіряють тести).
 * @param {UiState} s
 * @param {number} [now]
 */
export function authModel(s, now = Date.now()) {
  const a = s.auth ?? authState("login", "session");
  const v = a.view;
  const c = VIEWS[v] ?? VIEWS.login;
  const session = a.context === "session" && v === "login";
  const pending = s.account.pending;
  const pendingHost = pending ? hostOf(pending.url) : null;
  const me = s.account.me;
  const balance = me?.balance ?? 0;
  // Ціна ролика — account.prices (єдине джерело для view); невідома — картки нестачі немає.
  const need = s.account.prices?.video ?? null;
  const short = v === "activated" && pending !== null && need !== null && balance < need;

  /** @type {{ before: string, host: string, after: string } | null} */
  let context = null;
  if (session && s.route === "project")
    context = { before: "Після входу відкрию ", host: s.site ?? "проєкт", after: " на тому ж місці." };
  else if (a.context === "checkout" && (v === "login" || v === "register") && s.checkout)
    context = { before: "Після входу відкрию оплату ", host: s.checkout.id, after: "." };
  else if (pendingHost && (v === "login" || v === "register"))
    context = { before: "Ролик для ", host: pendingHost, after: " почнеться після входу." };
  else if (pendingHost && v === "check")
    context = { before: "Після активації почну ролик для ", host: pendingHost, after: "." };

  const err = a.error;
  const errorText = err && err !== "google" ? (a.message ?? ERROR_TEXT[err]) : null;

  let info = null;
  if (a.resent) {
    if (v === "activateInvalid") info = "Якщо адреса чекає на активацію, новий лист уже в дорозі.";
    else if (v === "login" && err === "not_activated") info = "Лист надіслано ще раз — перевірте пошту.";
    else info = "Лист надіслано ще раз.";
  }

  /** @type {[LinkKey, string][]} */
  const links = [...(c.links ?? [])];
  if (v === "login" && err === "not_activated" && !a.resent)
    links.unshift(["resend", "Надіслати лист ще раз"]);

  let submit = c.submit ?? null;
  if (v === "activated") submit = short ? "Поповнити" : pending ? "Почати ролик" : "На старт";
  if (submit && a.busy && c.busyLabel) submit = c.busyLabel;

  const cooldown =
    v === "check" && a.cooldownUntil !== null ? Math.max(0, Math.ceil((a.cooldownUntil - now) / 1000)) : 0;
  const hint = c.newPassword ? passwordHint(a.password.length) : null;
  const fields = c.fields ?? [];

  return {
    view: v,
    eyebrow: session ? "Сесія завершилась" : c.eyebrow,
    danger: Boolean(c.danger),
    title: session ? "Увійдіть ще раз" : c.title,
    dot: Boolean(c.dot),
    lead: c.lead ?? null,
    context,
    seg: Boolean(c.seg) && !session,
    fields,
    name: a.name,
    email: a.email,
    password: a.password,
    showPassword: a.showPassword,
    emailAutocomplete: v === "register" ? "email" : "username",
    passwordLabel: v === "reset" ? "Новий пароль" : "Пароль",
    passwordAutocomplete: c.newPassword ? "new-password" : "current-password",
    passwordPlaceholder: c.newPassword ? "від 8 символів" : "",
    hint,
    emailInvalid: err !== null && EMAIL_ERRORS.includes(err),
    passwordInvalid: err !== null && PASSWORD_ERRORS.includes(err),
    errorText,
    info,
    check: c.check
      ? {
          email: a.email,
          resend:
            v === "check" && cooldown > 0 ? `Надіслати ще раз · ${clock(cooldown)}` : "Надіслати ще раз",
          resendDisabled: a.busy || (v === "check" && cooldown > 0),
        }
      : null,
    cooldown,
    spinner: c.spinner && !err ? c.spinner : null,
    balance: c.balance
      ? {
          num: formatNumber(balance),
          word: creditWord(balance),
          bonus: a.bonus > 0 ? `+${a.bonus} · вітальний бонус нараховано` : null,
        }
      : null,
    shortage:
      short && need !== null
        ? { host: pendingHost, need: formatCredits(need), have: formatCredits(balance) }
        : null,
    submit: submit ? { label: submit, busy: a.busy, disabled: a.busy || err === "rate_limited" } : null,
    links,
    google: c.google ? { message: err === "google" ? (a.message ?? GOOGLE_TEXT) : null } : null,
    closable: closable(a),
  };
}

/** @typedef {ReturnType<typeof authModel>} AuthModel */

/** @param {HTMLElement} node @param {boolean} on */
const show = (node, on) => {
  if (node.hidden === on) node.hidden = !on;
};

/** @param {Element} node @param {string} name @param {string | null} value */
function attr(node, name, value) {
  if (value === null) {
    if (node.hasAttribute(name)) node.removeAttribute(name);
  } else if (node.getAttribute(name) !== value) node.setAttribute(name, value);
}

let uid = 0;

/**
 * Форма входу (спільна для модалки й сцени).
 * @param {Ctx} ctx
 * @param {"modal" | "stage"} layout
 * @param {{ onClose?: () => void }} [o]
 */
function createForm(ctx, layout, o = {}) {
  const id = `au-${++uid}`;
  const { actions } = ctx;

  const eyebrowDot = h("span", { class: "dot au-eyebrow__dot", "aria-hidden": "true" });
  const eyebrowText = h("span");
  const eyebrow = h("span", { class: "eyebrow au-eyebrow" }, eyebrowDot, eyebrowText);
  const close = h("button", {
    type: "button",
    class: "au-link au-close",
    text: "Закрити",
    onclick: () => o.onClose?.(),
  });
  const titleText = h("span");
  const titleDot = h("span", { class: "accent-dot", text: "." });
  const title = h("h1", { class: "au-title", id: `${id}-title` }, titleText, titleDot);
  const lead = h("p", { class: "au-lead" });
  const ctxBefore = document.createTextNode("");
  const ctxHost = h("span", { class: "au-context__host" });
  const ctxAfter = document.createTextNode("");
  const context = h(
    "p",
    { class: "au-context" },
    h("span", { class: "dot au-context__dot", "aria-hidden": "true" }),
    h("span", null, ctxBefore, ctxHost, ctxAfter),
  );

  /** @param {"login" | "register"} view @param {string} label */
  const segOpt = (view, label) =>
    h("button", {
      type: "button",
      role: "tab",
      class: "seg__opt au-seg__opt",
      "data-view": view,
      text: label,
      onclick: () => actions.openAuth(view),
    });
  const segLogin = segOpt("login", "Вхід");
  const segRegister = segOpt("register", "Реєстрація");
  const seg = h(
    "div",
    { class: "seg au-seg", role: "tablist", "aria-label": "Вхід або реєстрація" },
    segLogin,
    segRegister,
  );

  const errId = `${id}-err`;
  /**
   * @param {Field} name
   * @param {Record<string, unknown>} attrs
   */
  const input = (name, attrs) =>
    h("input", {
      name,
      class: "au-input",
      "aria-describedby": errId,
      oninput: (/** @type {Event} */ e) =>
        actions.setAuthField(name, /** @type {HTMLInputElement} */ (e.target).value),
      ...attrs,
    });
  const nameInput = input("name", {
    type: "text",
    autocomplete: "name",
    maxlength: "80",
    placeholder: "Олена Коваль",
  });
  const emailInput = input("email", {
    type: "email",
    inputmode: "email",
    autocapitalize: "off",
    spellcheck: "false",
    placeholder: "you@business.ua",
  });
  const passwordInput = input("password", { type: "password", minlength: "8", maxlength: "128" });
  passwordInput.classList.add("au-input--pw");
  const pwToggle = h("button", {
    type: "button",
    class: "au-pw-toggle",
    onclick: () => actions.setAuthField("showPassword", passwordInput.type === "password"),
  });
  const pwLabel = h("span");
  const pwHint = h("span", { class: "au-hint" });

  const nameField = h(
    "label",
    { class: "au-field" },
    h("span", { class: "label-s", text: "Ім’я" }),
    nameInput,
  );
  const emailField = h(
    "label",
    { class: "au-field" },
    h("span", { class: "label-s", text: "E-mail" }),
    emailInput,
  );
  const passwordField = h(
    "label",
    { class: "au-field" },
    h("span", { class: "label-s au-field__label" }, pwLabel, pwHint),
    h("span", { class: "au-pw" }, passwordInput, pwToggle),
  );
  const fields = h("div", { class: "au-fields" }, nameField, emailField, passwordField);

  const error = h("p", { class: "au-error", id: errId, role: "alert" });
  const info = h("p", { class: "au-info", role: "status" });

  const checkEmail = h("span", { class: "au-check__email" });
  const resend = h("button", {
    type: "button",
    class: "btn btn--ghost btn--sm",
    onclick: () => actions.resendAuthMail(),
  });
  const otherEmail = h("button", {
    type: "button",
    class: "au-link",
    text: "Інша адреса",
    onclick: () => actions.openAuth(ctx.store.getState().auth?.view === "forgotSent" ? "forgot" : "register"),
  });
  const check = h(
    "div",
    { class: "au-check" },
    h("span", { class: "label-s", text: "Адреса" }),
    checkEmail,
    h("div", { class: "au-check__actions" }, resend, otherEmail),
  );

  const spinnerText = h("span");
  const spinner = h(
    "div",
    { class: "au-spinner", role: "status" },
    h("span", { class: "spinner", "aria-hidden": "true" }),
    spinnerText,
  );

  const balNum = h("span", { class: "au-balance__num" });
  const balWord = h("span", { class: "au-balance__word" });
  const bonus = h("span", { class: "au-balance__bonus" });
  const balance = h(
    "div",
    { class: "au-balance" },
    h("span", { class: "label-s", text: "Баланс" }),
    h("span", { class: "au-balance__row" }, balNum, balWord),
    bonus,
  );

  const shortHost = h("span", { class: "au-short__host" });
  const shortBefore = document.createTextNode("");
  const shortAfter = document.createTextNode("");
  const shortage = h(
    "div",
    { class: "au-short", role: "alert" },
    h(
      "span",
      { class: "au-short__head" },
      h("span", { class: "diamond diamond--sm diamond--open", "aria-hidden": "true" }),
      "Не вистачає на ролик",
    ),
    h("span", { class: "au-short__text" }, "Для ролика ", shortHost, shortBefore, shortAfter),
  );

  const submitSpin = h("span", { class: "au-submit__spin", "aria-hidden": "true" });
  const submitLabel = h("span");
  const submitArrow = h("span", { "aria-hidden": "true", text: "→" });
  const submit = h(
    "button",
    { type: "submit", class: "btn btn--primary btn--lg au-submit" },
    submitSpin,
    submitLabel,
    submitArrow,
  );
  const linksBox = h("span", { class: "au-links" });
  const actionsRow = h("div", { class: "au-actions" }, submit, linksBox);

  const googleMsgText = h("span");
  const googleMsg = h(
    "p",
    { class: "au-google__msg", role: "status" },
    h("span", { class: "dot au-google__dot", "aria-hidden": "true" }),
    googleMsgText,
  );
  const google = h(
    "div",
    { class: "au-google" },
    h(
      "div",
      { class: "au-or", "aria-hidden": "true" },
      h("span", { class: "au-or__line" }),
      "або",
      h("span", { class: "au-or__line" }),
    ),
    h("button", {
      type: "button",
      class: "btn btn--ghost au-google__btn",
      text: "Увійти через Google",
      onclick: () => actions.authGoogle(),
    }),
    googleMsg,
  );

  const form = h(
    "form",
    {
      class: `au-form au-form--${layout}`,
      novalidate: true,
      "aria-labelledby": `${id}-title`,
      onsubmit: (/** @type {Event} */ e) => {
        e.preventDefault();
        void actions.submitAuth();
      },
    },
    h("div", { class: "au-head" }, h("div", { class: "au-head__row" }, eyebrow, close), title, lead, context),
    seg,
    fields,
    error,
    info,
    check,
    spinner,
    balance,
    shortage,
    actionsRow,
    google,
  );

  /** @param {LinkKey} key */
  function onLink(key) {
    const s = ctx.store.getState();
    switch (key) {
      case "forgot":
        return actions.openAuth("forgot");
      case "login":
      case "back":
        return actions.openAuth("login");
      case "resend":
        return void actions.resendAuthMail();
      case "cabinet":
        actions.closeAuth();
        return actions.navigate({ route: "cabinet", section: "balance" });
      case "start":
        actions.closeAuth();
        if (s.route !== "start") actions.navigate({ route: "start" });
        return;
    }
  }

  let linksKey = "";

  /** @param {HTMLInputElement} el @param {string} value */
  const value = (el, value) => {
    if (el.value !== value) el.value = value;
  };

  /** @param {AuthModel} m */
  function apply(m) {
    form.dataset.view = m.view;
    show(eyebrowDot, m.danger);
    eyebrow.classList.toggle("au-eyebrow--danger", m.danger);
    text(eyebrowText, m.eyebrow);
    show(close, layout === "modal" && m.closable);
    text(titleText, m.title);
    show(titleDot, m.dot);
    show(lead, m.lead !== null);
    text(lead, m.lead);
    show(context, m.context !== null);
    if (m.context) {
      ctxBefore.data = m.context.before;
      text(ctxHost, m.context.host);
      ctxAfter.data = m.context.after;
    }

    show(seg, m.seg);
    for (const [opt, on] of /** @type {const} */ ([
      [segLogin, m.view === "login"],
      [segRegister, m.view === "register"],
    ])) {
      opt.classList.toggle("is-on", on);
      attr(opt, "aria-selected", on ? "true" : "false");
    }

    show(fields, m.fields.length > 0);
    show(nameField, m.fields.includes("name"));
    show(emailField, m.fields.includes("email"));
    show(passwordField, m.fields.includes("password"));
    value(nameInput, m.name);
    value(emailInput, m.email);
    value(passwordInput, m.password);
    attr(emailInput, "autocomplete", m.emailAutocomplete);
    attr(emailInput, "aria-invalid", m.emailInvalid ? "true" : "false");
    emailField.classList.toggle("is-invalid", m.emailInvalid);
    attr(passwordInput, "autocomplete", m.passwordAutocomplete);
    attr(passwordInput, "placeholder", m.passwordPlaceholder || null);
    attr(passwordInput, "aria-invalid", m.passwordInvalid ? "true" : "false");
    passwordField.classList.toggle("is-invalid", m.passwordInvalid);
    const type = m.showPassword ? "text" : "password";
    if (passwordInput.type !== type) passwordInput.type = type;
    attr(pwToggle, "aria-pressed", m.showPassword ? "true" : "false");
    text(pwToggle, m.showPassword ? "Сховати" : "Показати");
    text(pwLabel, m.passwordLabel);
    show(pwHint, m.hint !== null);
    text(pwHint, m.hint?.text);
    pwHint.classList.toggle("is-ok", Boolean(m.hint?.ok));

    show(error, m.errorText !== null);
    text(error, m.errorText);
    show(info, m.info !== null);
    text(info, m.info);

    show(check, m.check !== null);
    if (m.check) {
      text(checkEmail, m.check.email);
      text(resend, m.check.resend);
      resend.disabled = m.check.resendDisabled;
    }

    show(spinner, m.spinner !== null);
    text(spinnerText, m.spinner);

    show(balance, m.balance !== null);
    if (m.balance) {
      text(balNum, m.balance.num);
      text(balWord, m.balance.word);
      show(bonus, m.balance.bonus !== null);
      text(bonus, m.balance.bonus);
    }

    show(shortage, m.shortage !== null);
    if (m.shortage) {
      show(shortHost, m.shortage.host !== null);
      text(shortHost, m.shortage.host);
      shortBefore.data = `${m.shortage.host ? " " : ""}потрібно ${m.shortage.need}, у вас ${m.shortage.have}.`;
      shortAfter.data = " Поповніть — і ролик почнеться сам.";
    }

    show(actionsRow, m.submit !== null || m.links.length > 0);
    show(submit, m.submit !== null);
    if (m.submit) {
      text(submitLabel, m.submit.label);
      show(submitSpin, m.submit.busy);
      show(submitArrow, !m.submit.busy);
      submit.disabled = m.submit.disabled;
      attr(submit, "aria-busy", m.submit.busy ? "true" : null);
    }
    const key = m.links.map(([k, l]) => `${k}:${l}`).join("|");
    if (key !== linksKey) {
      linksKey = key;
      clear(linksBox);
      for (const [k, label] of m.links)
        linksBox.append(
          h("button", {
            type: "button",
            class: "au-link",
            "data-link": k,
            text: label,
            onclick: () => onLink(k),
          }),
        );
    }

    show(google, m.google !== null);
    show(googleMsg, Boolean(m.google?.message));
    text(googleMsgText, m.google?.message);
  }

  /** Перше видиме поле — сюди ставиться фокус (без полів — на діалог, Tab веде далі). */
  function firstFocus() {
    for (const el of [nameInput, emailInput, passwordInput]) {
      const field = /** @type {HTMLElement} */ (el.closest(".au-field"));
      if (!field.hidden && !fields.hidden) return el;
    }
    return null;
  }

  return { el: form, apply, firstFocus };
}

/**
 * Кулдаун «Надіслати ще раз · 0:42» щосекунди перемальовується, поки йде відлік.
 * @param {() => void} tick
 */
function cooldownTimer(tick) {
  /** @type {ReturnType<typeof setInterval> | null} */
  let timer = null;
  return {
    /** @param {boolean} on */
    set(on) {
      if (on && !timer) timer = setInterval(tick, 1000);
      else if (!on && timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}

/** Елементи, між якими ходить Tab усередині модалки. @param {HTMLElement} root */
function focusables(root) {
  return /** @type {HTMLElement[]} */ (
    Array.from(root.querySelectorAll("button, input, a[href], [tabindex]:not([tabindex='-1'])"))
  ).filter((el) => !(/** @type {HTMLButtonElement} */ (el).disabled) && !el.closest("[hidden]"));
}

/** @type {import("../contracts.js").MountFn} */
export function mount(el, ctx) {
  const { store, actions } = ctx;
  const scrim = h("div", { class: "au-scrim", "aria-hidden": "true" });
  const dialog = h("div", { class: "au-dialog", role: "dialog", "aria-modal": "true", tabindex: "-1" });
  const root = h("div", { class: "au-overlay", hidden: true }, scrim, dialog);
  el.append(root);

  const tryClose = () => {
    const a = store.getState().auth;
    if (a && closable(a)) actions.closeAuth();
  };
  const form = createForm(ctx, "modal", { onClose: tryClose });
  dialog.append(form.el);
  dialog.setAttribute("aria-labelledby", /** @type {string} */ (form.el.getAttribute("aria-labelledby")));
  scrim.addEventListener("click", tryClose);

  /** Звідки відкрили модалку — туди повертається фокус. @type {HTMLElement | null} */
  let trigger = null;
  let open = false;
  /** @type {AuthView | null} */
  let shownView = null;

  /** @param {KeyboardEvent} e */
  const onKey = (e) => {
    if (!open) return;
    if (e.key === "Escape") {
      e.preventDefault();
      tryClose();
      return;
    }
    if (e.key !== "Tab") return;
    const list = focusables(dialog);
    if (list.length === 0) {
      e.preventDefault();
      dialog.focus();
      return;
    }
    const first = /** @type {HTMLElement} */ (list[0]);
    const last = /** @type {HTMLElement} */ (list[list.length - 1]);
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !dialog.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !dialog.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  };
  document.addEventListener("keydown", onKey);

  const focusFirst = () => (form.firstFocus() ?? dialog).focus();

  const timer = cooldownTimer(() => render(store.getState()));

  /** @param {UiState} s */
  function render(s) {
    const visible = modalOpen(s);
    if (visible) {
      const m = authModel(s);
      form.apply(m);
      timer.set(m.cooldown > 0);
    } else timer.set(false);
    show(root, visible);
    // Під модалкою сторінка не прокручується.
    document.documentElement.classList.toggle("au-lock", visible);
    if (visible && !open) {
      const active = document.activeElement;
      trigger =
        active instanceof HTMLElement && active !== document.body && !root.contains(active) ? active : null;
      open = true;
      shownView = s.auth?.view ?? null;
      focusFirst();
    } else if (visible && s.auth?.view !== shownView) {
      // Новий перегляд у тій самій модалці — фокус на його перше поле.
      shownView = s.auth?.view ?? null;
      focusFirst();
    } else if (!visible && open) {
      open = false;
      shownView = null;
      const back = trigger;
      trigger = null;
      if (back?.isConnected) back.focus();
    }
  }

  render(store.getState());
  return {
    update: (s) => render(s),
    destroy() {
      timer.set(false);
      document.removeEventListener("keydown", onKey);
      document.documentElement.classList.remove("au-lock");
      root.remove();
    },
  };
}

/**
 * Та сама форма входу без картки модалки — для сцени 401 (B12, `layout: "stage"`): без «Закрити»,
 * без підкладки й пастки фокусу; стан — той самий `auth` (context `session`).
 * @param {HTMLElement} el
 * @param {Ctx} ctx
 * @param {{ layout: "modal" | "stage" }} o
 * @returns {ViewHandle}
 */
export function mountAuthForm(el, ctx, o) {
  const { store } = ctx;
  const form = createForm(ctx, o.layout, { onClose: () => ctx.actions.closeAuth() });
  el.append(form.el);
  const timer = cooldownTimer(() => render(store.getState()));
  /** @type {AuthView | null} */
  let shownView = null;
  /** @param {UiState} s */
  function render(s) {
    const m = authModel(s);
    form.apply(m);
    timer.set(m.cooldown > 0);
    if (shownView !== null && shownView !== m.view && form.el.contains(document.activeElement))
      form.firstFocus()?.focus();
    shownView = m.view;
  }
  render(store.getState());
  return {
    update: (s) => render(s),
    destroy() {
      timer.set(false);
      form.el.remove();
    },
  };
}
