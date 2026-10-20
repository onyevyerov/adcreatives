// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableCSSFileLoading":true,"handleDisabledFileLoadingAsSuccess":true}}
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDevActions } from "../../public/static/dev/dev-actions.js";
import { fixtureStates } from "../../public/static/dev/fixture-states.js";
import { ADMIN_ME, accountFixture, ME, meOf, OLENA } from "../../public/static/dev/fixtures/_base.js";
import profileFixtures from "../../public/static/dev/fixtures/profile.js";
import type { CabinetState, Me, Route, UiState } from "../../public/static/js/contracts.js";
import { createAccountActions } from "../../public/static/js/data/account.js";
import * as accountApi from "../../public/static/js/data/account-api.js";
import type { Backend } from "../../public/static/js/data/actions.js";
import { setUnauthorizedHandler } from "../../public/static/js/data/api.js";
import { nameValid, profileActions } from "../../public/static/js/data/profile-actions.js";
import { createStore } from "../../public/static/js/store.js";
import {
  ADMIN_ROLE,
  mount,
  NAME_ERROR,
  nextHint,
  PW_DONE,
  PW_ERRORS,
  SAVED,
  sinceDate,
} from "../../public/static/js/views/cab-profile.js";

type Profile = CabinetState["profile"];

/** Кабінет на «Профілі» з Оленою (або іншим `me`). */
function state(profile: Partial<Profile> = {}, me: Me = ME): UiState {
  const s = accountFixture({ route: "cabinet" });
  return {
    ...s,
    account: { ...s.account, me },
    cabinet: {
      ...s.cabinet,
      section: "profile",
      profile: { ...s.cabinet.profile, nameDraft: me.user.name, ...profile },
    },
  };
}

const json = (status: number, body: unknown) =>
  new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

type Call = { method: string; path: string; body: unknown };

/** Стаб `fetch`: `routes["PATCH /api/account"]` → Response; решта — 404. */
function stubFetch(routes: Record<string, (body: unknown) => Response | Promise<Response>>) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ method, path: url.pathname, body });
    const route = routes[`${method} ${url.pathname}`];
    return route ? route(body) : json(404, { error: "not_found", message: "Не знайдено." });
  });
  vi.stubGlobal("fetch", fetch);
  return { fetch, calls };
}

const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
vi.spyOn(console, "info").mockImplementation(() => {});

afterEach(() => {
  document.body.textContent = "";
  vi.unstubAllGlobals();
  setUnauthorizedHandler(null);
  localStorage.clear();
  sessionStorage.clear();
  warn.mockClear();
});

// ───────────── view ─────────────

describe("views/cab-profile.js", () => {
  let host: HTMLElement;
  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
  });

  function mountWith(s: UiState) {
    const store = createStore(s);
    const actions = createDevActions(store);
    const view = mount(host, { store, actions });
    store.subscribe((next, prev) => view.update(next, prev));
    const calls = (name: string) => actions.calls.filter((c) => c.name === name);
    return { store, actions, view, calls };
  }

  const q = <T extends HTMLElement = HTMLElement>(sel: string) => host.querySelector<T>(sel) as T;
  const nameInput = () => q<HTMLInputElement>('input[name="name"]');
  const current = () => q<HTMLInputElement>('input[name="current"]');
  const next = () => q<HTMLInputElement>('input[name="next"]');
  const buttons = () => [...host.querySelectorAll("button")];
  const button = (label: string) => buttons().find((b) => b.textContent === label) as HTMLButtonElement;
  const shown = (el: HTMLElement | null) => !!el && !el.hidden;
  const patch = (store: ReturnType<typeof createStore<UiState>>, p: Partial<Profile>) =>
    store.setState((s) => ({ cabinet: { ...s.cabinet, profile: { ...s.cabinet.profile, ...p } } }));

  it("перегляд: заголовок, ім'я в полі, e-mail і «З нами з», без ознаки ролі", () => {
    const { view } = mountWith(state());
    expect(q("h1")?.textContent).toBe("Профіль");
    expect(q("section")?.getAttribute("aria-labelledby")).toBe(q("h1").id);
    expect(nameInput().value).toBe("Олена Коваль");
    expect(nameInput().getAttribute("autocomplete")).toBe("name");
    expect(nameInput().getAttribute("aria-invalid")).toBe("false");
    expect(button("Зберегти").disabled).toBe(false);
    const text = host.textContent ?? "";
    for (const s of ["Ім’я", "E-mail", "З нами з", "Зміна пароля", "Поточний пароль", "Новий пароль"])
      expect(text).toContain(s);
    expect(text).toContain("olena@zerno.example.com");
    expect(text).toContain("14.10.2026");
    expect(shown(q(".cab-prof__role"))).toBe(false);
    expect(shown(q(".cab-prof__error"))).toBe(false);
    expect(shown(q(".cab-prof__saved"))).toBe(false);
    expect(shown(q(".cab-prof__done"))).toBe(false);
    expect(q(".cab-prof__hint").textContent).toBe("від 8 символів");
    expect(button("Змінити пароль").type).toBe("submit");
    expect(button("Вийти з акаунта").type).toBe("button");
    view.destroy();
    expect(host.children.length).toBe(0);
  });

  it("автозаповнення: прихований username з e-mail, current-password / new-password", () => {
    mountWith(state());
    const form = q("form.cab-prof__pw");
    const username = form.querySelector<HTMLInputElement>('input[name="username"]') as HTMLInputElement;
    expect(username.getAttribute("autocomplete")).toBe("username");
    expect(username.type).toBe("text");
    expect(username.value).toBe("olena@zerno.example.com");
    expect(username.readOnly).toBe(true);
    expect(username.hidden).toBe(true);
    expect(current().type).toBe("password");
    expect(current().getAttribute("autocomplete")).toBe("current-password");
    expect(next().type).toBe("password");
    expect(next().getAttribute("autocomplete")).toBe("new-password");
    expect(form.contains(current()) && form.contains(next())).toBe(true);
  });

  it("введення → setProfileField; submit → saveName / changePassword; «Вийти з акаунта» → logout", () => {
    const { calls } = mountWith(state());
    nameInput().value = "Олена К.";
    nameInput().dispatchEvent(new Event("input", { bubbles: true }));
    current().value = "kava2026!";
    current().dispatchEvent(new Event("input", { bubbles: true }));
    next().value = "Zerno-ranok";
    next().dispatchEvent(new Event("input", { bubbles: true }));
    expect(calls("setProfileField").map((c) => c.args)).toEqual([
      ["nameDraft", "Олена К."],
      ["current", "kava2026!"],
      ["next", "Zerno-ranok"],
    ]);
    const nameSubmit = new Event("submit", { cancelable: true });
    q("form.cab-prof__name").dispatchEvent(nameSubmit);
    expect(nameSubmit.defaultPrevented).toBe(true);
    expect(calls("saveName")).toHaveLength(1);
    const pwSubmit = new Event("submit", { cancelable: true });
    q("form.cab-prof__pw").dispatchEvent(pwSubmit);
    expect(pwSubmit.defaultPrevented).toBe(true);
    expect(calls("changePassword")).toHaveLength(1);
    button("Вийти з акаунта").click();
    expect(calls("logout")).toHaveLength(1);
  });

  it("збереження: «Зберігаю…» зі спінером, кнопка disabled; збережено — «✓ Збережено»", () => {
    const { store } = mountWith(state({ nameDraft: "Олена Коваль-Шевчук" }));
    expect(nameInput().value).toBe("Олена Коваль-Шевчук");
    expect(shown(q(".cab-prof__save .spinner"))).toBe(false);
    patch(store, { saving: true });
    const save = q<HTMLButtonElement>(".cab-prof__save");
    expect(save.textContent).toBe("Зберігаю…");
    expect(save.disabled).toBe(true);
    expect(shown(q(".cab-prof__save .spinner"))).toBe(true);
    patch(store, { saving: false, saved: true });
    expect(save.textContent).toBe("Зберегти");
    expect(save.disabled).toBe(false);
    expect(shown(q(".cab-prof__saved"))).toBe(true);
    expect(q(".cab-prof__saved").textContent).toBe(SAVED);
    expect(q(".cab-prof__saved").getAttribute("role")).toBe("status");
  });

  it("ім'я порожнє — копірайт UI і aria-invalid", () => {
    mountWith(state({ nameDraft: "", nameError: true }));
    expect(nameInput().value).toBe("");
    expect(nameInput().getAttribute("aria-invalid")).toBe("true");
    const err = q("#cab-prof-name-error");
    expect(shown(err)).toBe(true);
    expect(err.textContent).toBe(NAME_ERROR);
    expect(err.textContent).toBe("Ім’я — від 1 до 80 символів.");
    expect(err.getAttribute("role")).toBe("alert");
  });

  it("помилки пароля: invalid_credentials на поточному, weak_password на новому", () => {
    const { store } = mountWith(
      state({ current: "kava2025", next: "Zerno-ranok", pwError: "invalid_credentials" }),
    );
    const err = q("#cab-prof-pw-error");
    expect(err.textContent).toBe("Поточний пароль невірний.");
    expect(current().getAttribute("aria-invalid")).toBe("true");
    expect(next().getAttribute("aria-invalid")).toBe("false");
    expect(current().value).toBe("kava2025");
    expect(q(".cab-prof__hint").textContent).toBe("✓");
    patch(store, { current: "kava2026!", next: "kava", pwError: "weak_password" });
    expect(err.textContent).toBe(PW_ERRORS.weak_password);
    expect(err.textContent).toBe("Пароль — від 8 до 128 символів.");
    expect(current().getAttribute("aria-invalid")).toBe("false");
    expect(next().getAttribute("aria-invalid")).toBe("true");
    expect(q(".cab-prof__hint").textContent).toBe("ще 4");
  });

  it("зміна пароля: busy — кнопка disabled зі спінером; успіх — «✓ Пароль змінено…»", () => {
    const { store } = mountWith(state({ current: "kava2026!", next: "Zerno-ranok" }));
    patch(store, { pwBusy: true });
    const submit = q<HTMLButtonElement>(".cab-prof__submit");
    expect(submit.disabled).toBe(true);
    expect(shown(q(".cab-prof__submit .spinner"))).toBe(true);
    patch(store, { pwBusy: false, pwDone: true, current: "", next: "" });
    expect(submit.disabled).toBe(false);
    expect(shown(q(".cab-prof__submit .spinner"))).toBe(false);
    expect(current().value).toBe("");
    expect(next().value).toBe("");
    expect(q(".cab-prof__done").textContent).toBe(PW_DONE);
    expect(q(".cab-prof__done").getAttribute("role")).toBe("status");
  });

  it("адмін — «роль · адміністратор (ADMIN_EMAILS)» і дата адміна", () => {
    mountWith(state({}, ADMIN_ME));
    expect(shown(q(".cab-prof__role"))).toBe(true);
    expect(q(".cab-prof__role").textContent).toBe(ADMIN_ROLE);
    expect(host.textContent).toContain("admin@example.com");
    expect(host.textContent).toContain("01.10.2026");
  });

  it("update не перезаписує поле, якщо значення те саме (курсор не збивається)", () => {
    const { store } = mountWith(state());
    const input = nameInput();
    input.value = "Олена";
    let writes = 0;
    const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value");
    Object.defineProperty(input, "value", {
      configurable: true,
      get: () => desc?.get?.call(input),
      set: (v) => {
        writes++;
        desc?.set?.call(input, v);
      },
    });
    patch(store, { nameDraft: "Олена" });
    expect(writes).toBe(0);
    patch(store, { nameDraft: "Олена К" });
    expect(writes).toBe(1);
    expect(input === nameInput()).toBe(true);
  });

  it("хелпери: nextHint, sinceDate", () => {
    expect(nextHint("")).toBe("від 8 символів");
    expect(nextHint("kava")).toBe("ще 4");
    expect(nextHint("kava2026")).toBe("✓");
    expect(sinceDate(OLENA.createdAt)).toBe("14.10.2026");
    expect(sinceDate(null)).toBe("");
    expect(sinceDate("not a date")).toBe("");
  });
});

// ───────────── фікстури ─────────────

describe("dev/fixtures/profile.js", () => {
  const NAMES = [
    "cab-profile",
    "sheet-n13-editing",
    "sheet-n13-saving",
    "sheet-n13-saved",
    "sheet-n13-name-empty",
    "sheet-n13-pw-invalid",
    "sheet-n13-pw-weak",
    "sheet-n13-pw-done",
    "sheet-n13-admin",
  ];

  it("9 станів аркуша sheet-n13 (з cab-profile) у fixtureStates, усі — кабінет на «Профілі»", () => {
    expect(Object.keys(profileFixtures)).toEqual(NAMES);
    for (const name of NAMES) {
      const s = fixtureStates[name];
      expect(s, name).toBe(profileFixtures[name]);
      expect(s?.route, name).toBe("cabinet");
      expect(s?.cabinet.section, name).toBe("profile");
      expect(s?.account.meStatus, name).toBe("ready");
    }
  });

  it("кожна фікстура монтується з текстами свого кадру", () => {
    const expected: Record<string, string[]> = {
      "cab-profile": ["olena@zerno.example.com", "14.10.2026"],
      "sheet-n13-saving": ["Зберігаю…"],
      "sheet-n13-saved": [SAVED],
      "sheet-n13-name-empty": [NAME_ERROR],
      "sheet-n13-pw-invalid": [PW_ERRORS.invalid_credentials],
      "sheet-n13-pw-weak": [PW_ERRORS.weak_password, "ще 4"],
      "sheet-n13-pw-done": [PW_DONE],
      "sheet-n13-admin": [ADMIN_ROLE, "admin@example.com"],
    };
    for (const name of NAMES) {
      const host = document.createElement("div");
      document.body.append(host);
      const store = createStore(profileFixtures[name] as UiState);
      const view = mount(host, { store, actions: createDevActions(store) });
      const visible = [...host.querySelectorAll<HTMLElement>("*")]
        .filter((el) => !el.closest("[hidden]"))
        .map((el) => (el.children.length === 0 ? el.textContent : ""))
        .join("\n");
      for (const t of expected[name] ?? []) expect(visible, name).toContain(t);
      const nameValue = host.querySelector<HTMLInputElement>('input[name="name"]')?.value;
      expect(nameValue, name).toBe(
        { "sheet-n13-name-empty": "", "sheet-n13-admin": "Адміністратор" }[name] ??
          (["cab-profile", "sheet-n13-pw-invalid", "sheet-n13-pw-weak", "sheet-n13-pw-done"].includes(name)
            ? "Олена Коваль"
            : "Олена Коваль-Шевчук"),
      );
      view.destroy();
      host.remove();
    }
  });
});

// ───────────── data/profile-actions.js ─────────────

describe("data/profile-actions.js", () => {
  function make(s: UiState = state(), offline = false) {
    const store = createStore(s);
    const refreshMe = vi.fn(async () => {});
    const routes: ((r: Route) => void)[] = [];
    const actions = profileActions(store, {
      params: new URLSearchParams(),
      api: accountApi,
      actions: () => ({ refreshMe }) as never,
      backend: {} as Backend,
      offline,
      onRoute: (fn) => {
        routes.push(fn);
      },
    });
    const profile = () => store.getState().cabinet.profile;
    return { store, actions, refreshMe, routes, profile };
  }

  it("ключі — рівно B10 з 2.1", () => {
    expect(Object.keys(make().actions).sort()).toEqual(["changePassword", "saveName", "setProfileField"]);
  });

  it("nameValid: 1…80 символів після trim", () => {
    expect(nameValid("")).toBe(false);
    expect(nameValid("   ")).toBe(false);
    expect(nameValid(" Олена ")).toBe(true);
    expect(nameValid("я".repeat(80))).toBe(true);
    expect(nameValid("я".repeat(81))).toBe(false);
  });

  it("вхід у розділ профілю — свіжа форма з поточним ім'ям; інші розділи не чіпає", () => {
    const { routes, profile } = make(
      state({
        nameDraft: "старе",
        saved: true,
        current: "x",
        next: "y",
        pwError: "weak_password",
        pwDone: true,
      }),
    );
    expect(routes).toHaveLength(1);
    routes[0]?.({ route: "cabinet", section: "history" });
    expect(profile().nameDraft).toBe("старе");
    routes[0]?.({ route: "cabinet", section: "profile" });
    expect(profile()).toEqual({
      nameDraft: "Олена Коваль",
      saving: false,
      saved: false,
      nameError: false,
      current: "",
      next: "",
      pwBusy: false,
      pwError: null,
      pwDone: false,
    });
  });

  it("setProfileField: значення поля і зняття помилок та «✓»", () => {
    const { actions, profile } = make(
      state({ nameError: true, saved: true, pwError: "invalid_credentials", pwDone: true }),
    );
    actions.setProfileField("current", "kava");
    expect(profile()).toMatchObject({
      current: "kava",
      nameError: false,
      saved: false,
      pwError: null,
      pwDone: false,
    });
    actions.setProfileField("nameDraft", "Олена К.");
    actions.setProfileField("next", "Zerno-ranok");
    expect(profile()).toMatchObject({ nameDraft: "Олена К.", next: "Zerno-ranok" });
  });

  it("saveName: порожнє або > 80 — помилка без запиту", async () => {
    const { fetch } = stubFetch({});
    const { actions, profile } = make(state({ nameDraft: "   " }));
    await actions.saveName();
    expect(profile().nameError).toBe(true);
    actions.setProfileField("nameDraft", "я".repeat(81));
    await actions.saveName();
    expect(profile().nameError).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("saveName: saving → PATCH /api/account з trim → refreshMe → saved", async () => {
    let release: () => void = () => {};
    const { calls } = stubFetch({
      "PATCH /api/account": (body) =>
        new Promise((resolve) => {
          release = () => resolve(json(200, { user: { ...OLENA, ...(body as object) } }));
        }),
    });
    const { actions, profile, refreshMe } = make(state({ nameDraft: "  Олена Коваль-Шевчук " }));
    const p = actions.saveName();
    expect(profile()).toMatchObject({ saving: true, saved: false, nameError: false });
    await actions.saveName(); // повторне натискання під час збереження — без другого запиту
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    release();
    await p;
    expect(calls[0]).toEqual({
      method: "PATCH",
      path: "/api/account",
      body: { name: "Олена Коваль-Шевчук" },
    });
    expect(refreshMe).toHaveBeenCalledOnce();
    expect(profile()).toMatchObject({ saving: false, saved: true, nameDraft: "Олена Коваль-Шевчук" });
  });

  it("saveName: 400 від сервера — помилка імені; мережа — лише знімає saving", async () => {
    stubFetch({
      "PATCH /api/account": () =>
        json(400, { error: "invalid_body", message: "Ім'я — від 1 до 80 символів." }),
    });
    const { actions, profile, refreshMe } = make(state({ nameDraft: "Олена" }));
    await actions.saveName();
    expect(profile()).toMatchObject({ saving: false, nameError: true, saved: false });
    expect(refreshMe).not.toHaveBeenCalled();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    actions.setProfileField("nameDraft", "Олена К.");
    await actions.saveName();
    expect(profile()).toMatchObject({ saving: false, nameError: false, saved: false, nameDraft: "Олена К." });
    expect(warn).toHaveBeenCalled();
  });

  it("changePassword: pwBusy → POST /api/account/password → pwDone, поля очищено", async () => {
    let release: () => void = () => {};
    const { calls } = stubFetch({
      "POST /api/account/password": () =>
        new Promise((resolve) => {
          release = () => resolve(json(200, { ok: true }));
        }),
    });
    const { actions, profile } = make(state({ current: "kava2026!", next: "Zerno-ranok" }));
    const p = actions.changePassword();
    expect(profile()).toMatchObject({ pwBusy: true, pwError: null, pwDone: false });
    await actions.changePassword();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    release();
    await p;
    expect(calls[0]).toEqual({
      method: "POST",
      path: "/api/account/password",
      body: { current: "kava2026!", next: "Zerno-ranok" },
    });
    expect(profile()).toMatchObject({ pwBusy: false, pwDone: true, current: "", next: "" });
  });

  it("changePassword: 401 invalid_credentials і 400 weak_password → pwError, введене лишається", async () => {
    stubFetch({
      "POST /api/account/password": (body) =>
        (body as { next: string }).next.length < 8
          ? json(400, { error: "weak_password", message: "Пароль — від 8 до 128 символів." })
          : json(401, { error: "invalid_credentials", message: "Невірний поточний пароль." }),
    });
    const unauthorized = vi.fn();
    setUnauthorizedHandler(unauthorized);
    const { actions, profile } = make(state({ current: "kava2025", next: "Zerno-ranok" }));
    await actions.changePassword();
    expect(profile()).toMatchObject({
      pwBusy: false,
      pwError: "invalid_credentials",
      pwDone: false,
      current: "kava2025",
      next: "Zerno-ranok",
    });
    expect(unauthorized).not.toHaveBeenCalled();
    actions.setProfileField("next", "kava");
    await actions.changePassword();
    expect(profile()).toMatchObject({ pwBusy: false, pwError: "weak_password", next: "kava" });
  });

  it("changePassword: мережа — busy знімається без помилки", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    const { actions, profile } = make(state({ current: "a", next: "bbbbbbbb" }));
    await actions.changePassword();
    expect(profile()).toMatchObject({ pwBusy: false, pwError: null, pwDone: false, current: "a" });
  });

  it("offline (?mock=1): без мережі — ім'я в me, пароль «змінено»", async () => {
    const { fetch } = stubFetch({});
    const { actions, profile, store } = make(state({ nameDraft: "Олена К." }), true);
    await actions.saveName();
    expect(store.getState().account.me?.user.name).toBe("Олена К.");
    expect(profile().saved).toBe(true);
    await actions.changePassword();
    expect(profile().pwDone).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
});

// ───────────── у зборі createAccountActions ─────────────

describe("profileActions у createAccountActions", () => {
  it("вхід на /?cabinet=profile після me — форма з ім'ям; saveName оновлює me через refreshMe", async () => {
    let name = "Олена Коваль";
    const meNow = () => meOf({ ...OLENA, name }, 12);
    const { calls } = stubFetch({
      "GET /api/auth/me": () => json(200, meNow()),
      "GET /api/projects": () => json(200, { projects: [] }),
      "PATCH /api/account": (body) => {
        name = (body as { name: string }).name;
        return json(200, { user: meNow().user });
      },
    });
    const store = createStore(state({ nameDraft: "" }, ME));
    store.setState((s) => ({ account: { ...s.account, me: null, meStatus: "loading" } }));
    const backend: Backend = {
      start: async () => {},
      stop: () => {},
      createProject: async () => "p",
      sendMessage: async () => {},
      sendCommand: async () => {},
      uploadPhotos: async () => {},
    };
    const actions = createAccountActions(store, {
      params: new URLSearchParams("cabinet=profile"),
      backend,
      api: accountApi,
    });
    try {
      await actions.meReady;
      expect(store.getState().cabinet.profile.nameDraft).toBe("Олена Коваль");
      actions.setProfileField("nameDraft", "Олена Коваль-Шевчук");
      await actions.saveName();
      expect(calls.some((c) => c.method === "PATCH" && c.path === "/api/account")).toBe(true);
      expect(store.getState().account.me?.user.name).toBe("Олена Коваль-Шевчук");
      expect(store.getState().cabinet.profile).toMatchObject({ saved: true, saving: false });
    } finally {
      actions.dispose();
    }
  });
});
