// @ts-check
/**
 * B10 · Кабінет · профіль і пароль (N13-A, одна форма). Розділ монтує views/cabinet.js (B7).
 *
 * Усе видно одразу: ім'я з «Зберегти» (поле-картка 48 + ghost 40), e-mail і «З нами з» лише для
 * читання (адміну — ознака ролі), зміна пароля двома полями з прихованим username для
 * автозаповнення, «Змінити пароль» і «Вийти з акаунта». Тексти — дослівно з кадрів `sheet-n13`.
 * DOM будується один раз, `update` патчить змінене (значення полів — лише якщо відрізняються,
 * щоб не збивати курсор).
 */
import { h, text } from "../dom.js";

/** @typedef {import("../contracts.js").UiState} UiState */
/** @typedef {import("../contracts.js").MountFn} MountFn */
/** @typedef {import("../contracts.js").CabinetState["profile"]} ProfileState */

/** Мінімальна довжина нового пароля (сервер: PASSWORD_MIN) — для підказки під полем. */
export const PASSWORD_MIN = 8;

export const NAME_ERROR = "Ім’я — від 1 до 80 символів.";
export const SAVED = "✓ Збережено";
export const PW_DONE = "✓ Пароль змінено. Інші сесії завершено.";
export const ADMIN_ROLE = "роль · адміністратор (ADMIN_EMAILS)";

/**
 * Тексти помилок пароля: `invalid_credentials` — копірайт UI; `weak_password` — текст сервера
 * (`profile.pwMessage`), а цей — лише запасний, з кадру.
 */
export const PW_ERRORS = {
  invalid_credentials: "Поточний пароль невірний.",
  weak_password: "Пароль — від 8 до 128 символів.",
};

/**
 * Текст під полями пароля: `weak_password` — текст сервера, якщо є.
 * @param {ProfileState} p
 */
export function pwErrorText(p) {
  if (p.pwError === "weak_password") return p.pwMessage ?? PW_ERRORS.weak_password;
  return p.pwError ? PW_ERRORS[p.pwError] : "";
}

/**
 * Підказка довжини під «Новий пароль»: «від 8 символів» → «ще N» → «✓».
 * @param {string} next
 */
export function nextHint(next) {
  if (next.length === 0) return `від ${PASSWORD_MIN} символів`;
  if (next.length < PASSWORD_MIN) return `ще ${PASSWORD_MIN - next.length}`;
  return "✓";
}

/**
 * «З нами з» — локальна дата реєстрації «ДД.ММ.РРРР».
 * @param {string | null | undefined} iso
 */
export function sinceDate(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return "";
  const pad = (/** @type {number} */ n) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
}

/**
 * @param {HTMLInputElement} input
 * @param {string} value
 */
function setValue(input, value) {
  if (input.value !== value) input.value = value;
}

/**
 * @param {HTMLElement} node
 * @param {boolean} on
 */
function setInvalid(node, on) {
  node.setAttribute("aria-invalid", on ? "true" : "false");
}

/** @type {MountFn} */
export function mount(el, ctx) {
  const { actions } = ctx;

  // ───── Ім'я ─────
  const nameInput = h("input", {
    class: "cab-prof__input",
    name: "name",
    autocomplete: "name",
    maxlength: "81",
    "aria-describedby": "cab-prof-name-error",
    oninput: (/** @type {Event} */ e) =>
      actions.setProfileField("nameDraft", /** @type {HTMLInputElement} */ (e.target).value),
  });
  const nameSpinner = h("span", { class: "spinner", "aria-hidden": "true" });
  const nameLabel = h("span");
  const nameSave = h(
    "button",
    { type: "submit", class: "btn btn--ghost cab-prof__save" },
    nameSpinner,
    nameLabel,
  );
  const nameError = h("p", { class: "cab-prof__error", id: "cab-prof-name-error", role: "alert" });
  const nameSaved = h("p", { class: "cab-prof__saved", role: "status" });
  const nameForm = h(
    "form",
    {
      class: "cab-prof__name",
      novalidate: true,
      onsubmit: (/** @type {Event} */ e) => {
        e.preventDefault();
        void actions.saveName();
      },
    },
    h(
      "label",
      { class: "cab-prof__field" },
      h("span", { class: "label-s", text: "Ім’я" }),
      h("span", { class: "cab-prof__row" }, nameInput, nameSave),
    ),
    nameError,
    nameSaved,
  );

  // ───── Лише читання ─────
  const email = h("span", { class: "cab-prof__value" });
  const since = h("span", { class: "cab-prof__value" });
  const role = h("span", { class: "label-s cab-prof__role", text: ADMIN_ROLE });
  const info = h(
    "div",
    { class: "cab-prof__info" },
    h("span", { class: "cab-prof__cell" }, h("span", { class: "label-s", text: "E-mail" }), email),
    h("span", { class: "cab-prof__cell" }, h("span", { class: "label-s", text: "З нами з" }), since),
    role,
  );

  // ───── Пароль ─────
  const username = h("input", {
    type: "text",
    name: "username",
    autocomplete: "username",
    readonly: true,
    hidden: true,
    tabindex: "-1",
    "aria-hidden": "true",
  });
  /** @param {"current" | "next"} key @param {string} autocomplete */
  const pwInput = (key, autocomplete) =>
    h("input", {
      class: "cab-prof__input",
      type: "password",
      name: key,
      autocomplete,
      "aria-describedby": "cab-prof-pw-error",
      oninput: (/** @type {Event} */ e) =>
        actions.setProfileField(key, /** @type {HTMLInputElement} */ (e.target).value),
    });
  const current = pwInput("current", "current-password");
  const next = pwInput("next", "new-password");
  const hint = h("span", { class: "cab-prof__hint" });
  const pwError = h("p", { class: "cab-prof__error", id: "cab-prof-pw-error", role: "alert" });
  const pwDone = h("p", { class: "cab-prof__done", role: "status" });
  const pwSpinner = h("span", { class: "spinner", "aria-hidden": "true" });
  const pwSubmit = h(
    "button",
    { type: "submit", class: "btn btn--primary cab-prof__submit" },
    pwSpinner,
    "Змінити пароль",
  );
  const pwForm = h(
    "form",
    {
      class: "cab-prof__pw",
      novalidate: true,
      onsubmit: (/** @type {Event} */ e) => {
        e.preventDefault();
        void actions.changePassword();
      },
    },
    h("span", { class: "cab-prof__pw-title", text: "Зміна пароля" }),
    username,
    h(
      "div",
      { class: "cab-prof__grid" },
      h(
        "label",
        { class: "cab-prof__field" },
        h("span", { class: "label-s", text: "Поточний пароль" }),
        current,
      ),
      h(
        "label",
        { class: "cab-prof__field" },
        h("span", { class: "label-s cab-prof__label" }, "Новий пароль", hint),
        next,
      ),
    ),
    pwError,
    pwDone,
    h(
      "div",
      { class: "cab-prof__actions" },
      pwSubmit,
      h("button", {
        type: "button",
        class: "btn btn--ghost",
        text: "Вийти з акаунта",
        onclick: () => void actions.logout(),
      }),
    ),
  );

  const root = h(
    "section",
    { class: "cab-prof", "aria-labelledby": "cab-prof-title" },
    h(
      "div",
      { class: "cab-prof__body" },
      h("h1", { class: "display-m cab-prof__title", id: "cab-prof-title", text: "Профіль" }),
      nameForm,
      info,
      pwForm,
    ),
  );
  el.append(root);

  /** @param {UiState} s */
  function render(s) {
    const p = s.cabinet.profile;
    const user = s.account.me?.user ?? null;

    setValue(nameInput, p.nameDraft);
    setInvalid(nameInput, p.nameError);
    nameSave.disabled = p.saving;
    nameSpinner.hidden = !p.saving;
    text(nameLabel, p.saving ? "Зберігаю…" : "Зберегти");
    nameError.hidden = !p.nameError;
    text(nameError, p.nameError ? NAME_ERROR : "");
    nameSaved.hidden = !p.saved;
    text(nameSaved, p.saved ? SAVED : "");

    text(email, user?.email ?? "");
    text(since, sinceDate(user?.createdAt));
    role.hidden = !user?.isAdmin;
    setValue(username, user?.email ?? "");

    setValue(current, p.current);
    setValue(next, p.next);
    setInvalid(current, p.pwError === "invalid_credentials");
    setInvalid(next, p.pwError === "weak_password");
    text(hint, nextHint(p.next));
    pwSubmit.disabled = p.pwBusy;
    pwSpinner.hidden = !p.pwBusy;
    pwError.hidden = !p.pwError;
    text(pwError, pwErrorText(p));
    pwDone.hidden = !p.pwDone;
    text(pwDone, p.pwDone ? PW_DONE : "");
  }

  render(ctx.store.getState());

  return {
    update: (s) => render(s),
    destroy: () => root.remove(),
  };
}
