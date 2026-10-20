// @vitest-environment happy-dom
/**
 * Крок 0 фронтенду акаунтів: спільні бібліотеки (K1, K3, K4), маршрути, ApiError, pending.js,
 * ядро акаунта (refreshMe/delta, 401, охорона маршрутів, Object.assign і `ready`), зміни data/actions.js.
 */
import { I18N_KEYS, type I18nKey, t } from "@adc/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ADMIN_ME, HISTORY, ME, PACKAGES, PRICES, PROJECTS } from "../../public/static/dev/fixtures/_base.js";
import type { AccountActions, Me, PartDeps, Route, UiState } from "../../public/static/js/contracts.js";
import {
  applyRoute,
  createAccountActions,
  LOGOUT_FLASH,
  routeOf,
} from "../../public/static/js/data/account.js";
import * as realApi from "../../public/static/js/data/account-api.js";
import type { Backend } from "../../public/static/js/data/actions.js";
import { createActions } from "../../public/static/js/data/actions.js";
import { ApiError, api, NETWORK_MESSAGE, setUnauthorizedHandler } from "../../public/static/js/data/api.js";
import { initialState } from "../../public/static/js/initial.js";
import { CREDIT_TEMPLATES, parseCreditMessage } from "../../public/static/js/lib/credit-messages.js";
import {
  closingPackage,
  creditWord,
  customFor,
  enoughFor,
  extraFormatsCharge,
  formatCredits,
  formatNumber,
  isLow,
  paidFormats,
  plural,
  signed,
} from "../../public/static/js/lib/credits.js";
import {
  PENDING_KEY,
  peekPending,
  photosLost,
  RETURN_KEY,
  savePending,
  saveReturn,
  takePending,
  takeReturn,
} from "../../public/static/js/lib/pending.js";
import { routeFromUrl, urlForRoute } from "../../public/static/js/router.js";
import { createStore } from "../../public/static/js/store.js";
import { shortageCard } from "../../public/static/js/views/shortage.js";

/**
 * Part-файли дій замокано no-op-фабриками з тими самими ключами: тести ядра не залежать від тіл,
 * які блоки допишуть. `parts.deps[файл]` — deps, які ядро передало фабриці; `parts.fns[ключ]` —
 * мок дії з останнього `createAccountActions`.
 */
const parts = vi.hoisted(() => {
  const KEYS: Record<string, string[]> = {
    auth: ["openAuth", "closeAuth", "setAuthField", "submitAuth", "resendAuthMail", "authGoogle"],
    start: ["submitStart", "startPending", "dismissFlash"],
    retry: ["retryAfterTopup"],
    topup: ["openTopup", "selectPackage", "setCustom", "submitTopup", "continueTopup"],
    checkout: ["confirmCheckout", "checkoutAgain", "checkoutReturn"],
    cabinet: ["loadHistory", "loadProjects", "toggleProjectCredits", "openProject"],
    profile: ["setProfileField", "saveName", "changePassword"],
    admin: [
      "adminTab",
      "adminSearch",
      "adminSelect",
      "adminField",
      "adminAdjust",
      "adminCancelConfirm",
      "adminCopy",
    ],
  };
  const deps: Record<string, unknown> = {};
  const fns: Record<string, ReturnType<typeof vi.fn>> = {};
  const factory = (file: string, name: string) => ({
    [name]: (_store: unknown, d: unknown) => {
      deps[file] = d;
      return Object.fromEntries(
        (KEYS[file] ?? []).map((k) => {
          const fn = vi.fn(async () => {});
          fns[k] = fn;
          return [k, fn];
        }),
      );
    },
  });
  return { KEYS, deps, fns, factory };
});
vi.mock("../../public/static/js/data/auth-actions.js", () => parts.factory("auth", "authActions"));
vi.mock("../../public/static/js/data/start-actions.js", () => parts.factory("start", "startActions"));
vi.mock("../../public/static/js/data/retry-actions.js", () => parts.factory("retry", "retryActions"));
vi.mock("../../public/static/js/data/topup-actions.js", () => parts.factory("topup", "topupActions"));
vi.mock("../../public/static/js/data/checkout-actions.js", () =>
  parts.factory("checkout", "checkoutActions"),
);
vi.mock("../../public/static/js/data/cabinet-actions.js", () => parts.factory("cabinet", "cabinetActions"));
vi.mock("../../public/static/js/data/profile-actions.js", () => parts.factory("profile", "profileActions"));
vi.mock("../../public/static/js/data/admin-actions.js", () => parts.factory("admin", "adminActions"));

/** deps, які ядро передало part-фабриці `file`. */
const depsOf = (file: string) => {
  const d = parts.deps[file] as PartDeps | undefined;
  if (!d) throw new Error(`фабрику ${file} не викликано`);
  return d;
};
/** Мок дії part-файла. */
const fn = (key: keyof AccountActions) => {
  const f = parts.fns[key];
  if (!f) throw new Error(`немає моку ${key}`);
  return f;
};

const NBSP = " ";

/** Усі ключі `AccountActions` (contracts.js, 2.1). */
const ACCOUNT_KEYS: (keyof AccountActions)[] = [
  "refreshMe",
  "navigate",
  "logout",
  "openAuth",
  "closeAuth",
  "setAuthField",
  "submitAuth",
  "resendAuthMail",
  "authGoogle",
  "submitStart",
  "startPending",
  "dismissFlash",
  "retryAfterTopup",
  "openTopup",
  "selectPackage",
  "setCustom",
  "submitTopup",
  "continueTopup",
  "confirmCheckout",
  "checkoutAgain",
  "checkoutReturn",
  "loadHistory",
  "loadProjects",
  "toggleProjectCredits",
  "openProject",
  "setProfileField",
  "saveName",
  "changePassword",
  "adminTab",
  "adminSearch",
  "adminSelect",
  "adminField",
  "adminAdjust",
  "adminCancelConfirm",
  "adminCopy",
];

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Бекенд проєкту без мережі: журнал start/stop. */
function fakeBackend() {
  const log: string[] = [];
  const backend: Backend = {
    start: async (id) => {
      log.push(`start ${id}`);
    },
    stop: () => {
      log.push("stop");
    },
    createProject: async () => "p_new",
    sendMessage: async () => {},
    sendCommand: async () => {},
    uploadPhotos: async () => {},
  };
  return { backend, log };
}

type AccountApi = typeof realApi;

/**
 * API акаунтів без мережі: кожна обгортка account-api.js — мок, що повертає `{}`; `me` — за
 * чергою відповідей (число — `ApiError` з цим статусом), `listProjects` — проєкти Олени.
 */
function fakeApi(...answers: (Me | number)[]) {
  const all = Object.fromEntries(Object.keys(realApi).map((k) => [k, vi.fn(async () => ({}))]));
  const me = vi.fn(async () => {
    const next = answers.length > 1 ? answers.shift() : answers[0];
    if (typeof next === "number") throw new ApiError("x", next, next === 401 ? "unauthorized" : null, null);
    if (!next) throw new Error("fakeApi: немає відповіді me");
    return next;
  });
  const logout = vi.fn(async () => null);
  const listProjects = vi.fn(async () => ({ projects: PROJECTS }));
  return { ...all, me, logout, listProjects } as unknown as AccountApi & {
    me: typeof me;
    logout: typeof logout;
    listProjects: typeof listProjects;
  };
}

const withBalance = (balance: number): Me => ({ ...ME, balance });

type Made = ReturnType<typeof createAccountActions>;
let made: Made | null = null;

function make(opts: { state?: UiState; query?: string; answers?: (Me | number)[] } = {}) {
  const store = createStore<UiState>(opts.state ?? initialState("start", null));
  const { backend, log } = fakeBackend();
  const accountApi = fakeApi(...(opts.answers ?? [withBalance(12)]));
  const actions = createAccountActions(store, {
    params: new URLSearchParams(opts.query ?? ""),
    backend,
    api: accountApi,
  });
  made = actions;
  return { store, actions, log, accountApi };
}

const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

beforeEach(() => {
  history.replaceState(null, "", "/");
  sessionStorage.clear();
  for (const k of Object.keys(parts.deps)) delete parts.deps[k];
  for (const k of Object.keys(parts.fns)) delete parts.fns[k];
});

afterEach(() => {
  made?.dispose();
  made = null;
  setUnauthorizedHandler(null);
  sessionStorage.clear();
  warn.mockClear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ───────────── K1 · lib/credits.js ─────────────

describe("lib/credits.js", () => {
  it.each([
    [0, "кредитів"],
    [1, "кредит"],
    [2, "кредити"],
    [4, "кредити"],
    [5, "кредитів"],
    [11, "кредитів"],
    [12, "кредитів"],
    [14, "кредитів"],
    [21, "кредит"],
    [22, "кредити"],
    [25, "кредитів"],
    [111, "кредитів"],
    [1250, "кредитів"],
  ])("creditWord(%i) → %s", (n, word) => {
    expect(creditWord(n)).toBe(word);
    expect(creditWord(-n)).toBe(word);
  });

  it("plural з довільними формами", () => {
    const forms: [string, string, string] = ["правка", "правки", "правок"];
    expect([1, 3, 7, 13, 23].map((n) => plural(n, forms))).toEqual([
      "правка",
      "правки",
      "правок",
      "правок",
      "правки",
    ]);
  });

  it("formatNumber / formatCredits — U+00A0 між тисячами і перед словом", () => {
    expect(formatNumber(1250)).toBe(`1${NBSP}250`);
    expect(formatNumber(1_000_000)).toBe(`1${NBSP}000${NBSP}000`);
    expect(formatNumber(12)).toBe("12");
    expect(formatNumber(-1250)).toBe(`−1${NBSP}250`);
    expect(formatCredits(1250)).toBe(`1${NBSP}250${NBSP}кредитів`);
    expect(formatCredits(1)).toBe(`1${NBSP}кредит`);
    expect(formatCredits(22)).toBe(`22${NBSP}кредити`);
  });

  it("signed: «−10» (U+2212) · «+25» · «0»", () => {
    expect(signed(-10)).toBe("−10");
    expect(signed(25)).toBe("+25");
    expect(signed(0)).toBe("0");
    expect(signed(1250)).toBe(`+1${NBSP}250`);
  });

  it("enoughFor: ролик або правки · лише правки · ні на що", () => {
    expect(enoughFor(12, PRICES)).toBe(`1${NBSP}ролик або 4${NBSP}правки`);
    expect(enoughFor(25, PRICES)).toBe(`2${NBSP}ролики або 8${NBSP}правок`);
    expect(enoughFor(60, PRICES)).toBe(`6${NBSP}роликів або 20${NBSP}правок`);
    expect(enoughFor(9, PRICES)).toBe(`3${NBSP}правки, на ролик — ні`);
    expect(enoughFor(3, PRICES)).toBe(`1${NBSP}правку, на ролик — ні`);
    expect(enoughFor(2, PRICES)).toBe("ні на ролик, ні на правку");
    expect(enoughFor(0, PRICES)).toBe("ні на ролик, ні на правку");
  });

  it("isLow: менше половини ціни ролика", () => {
    expect(isLow(4, PRICES)).toBe(true);
    expect(isLow(5, PRICES)).toBe(false);
    expect(isLow(0, PRICES)).toBe(true);
  });

  it("closingPackage: найменший ≥ нестачі, інакше найбільший; customFor — не менше мінімуму", () => {
    expect(closingPackage(PACKAGES, 6).label).toBe("Старт");
    expect(closingPackage(PACKAGES, 10).label).toBe("Старт");
    expect(closingPackage(PACKAGES, 11).label).toBe("Кілька роликів");
    expect(closingPackage(PACKAGES, 999).label).toBe("Серія");
    expect(closingPackage([...PACKAGES].reverse(), 6).id).toBe("starter");
    expect(customFor(2, { min: 5 })).toBe(5);
    expect(customFor(22, { min: 5 })).toBe(22);
  });

  it("extraFormatsCharge: перший формат у ціні, оплачений не рахується", () => {
    expect(extraFormatsCharge(["vertical"], [], PRICES)).toEqual({ need: 0, extra: [], paid: [] });
    expect(extraFormatsCharge(["vertical", "square"], [], PRICES)).toEqual({
      need: 2,
      extra: ["square"],
      paid: [],
    });
    expect(extraFormatsCharge(["vertical", "square"], ["square"], PRICES)).toEqual({
      need: 0,
      extra: [],
      paid: ["square"],
    });
    expect(extraFormatsCharge(["vertical", "square", "landscape"], ["landscape"], PRICES)).toEqual({
      need: 2,
      extra: ["square"],
      paid: ["landscape"],
    });
  });

  it("paidFormats: з credits.parts kind format — для рядка і для projectCredits", () => {
    const zerno = PROJECTS.find((p) => p.id === "p_zerno") ?? null;
    expect(paidFormats(zerno)).toEqual(["square"]);
    expect(paidFormats(zerno?.credits ?? null)).toEqual(["square"]);
    expect(paidFormats(PROJECTS.find((p) => p.id === "p_kav") ?? null)).toEqual([]);
    expect(paidFormats(null)).toEqual([]);
    expect(paidFormats({ ...PROJECTS[0], credits: null } as never)).toEqual([]);
  });
});

// ───────────── K4 · lib/credit-messages.js ─────────────

describe("lib/credit-messages.js", () => {
  it("шаблони — дослівно з uk.ts", () => {
    for (const key of Object.keys(CREDIT_TEMPLATES) as I18nKey[]) {
      expect(I18N_KEYS).toContain(key);
      expect(CREDIT_TEMPLATES[key as keyof typeof CREDIT_TEMPLATES]).toBe(t(key));
    }
  });

  it("розпізнає кожен із п'яти шаблонів, звичайний текст → null", () => {
    expect(parseCreditMessage(t("insufficientCredits", { need: 10, have: 4 }))).toEqual({
      kind: "insufficient",
      need: 10,
      have: 4,
    });
    expect(parseCreditMessage(t("insufficientCreditsFormats", { need: 2, have: 1 }))).toEqual({
      kind: "insufficientFormats",
      need: 2,
      have: 1,
    });
    expect(parseCreditMessage(t("chargedRevision", { credits: 3, balance: 9 }))).toEqual({
      kind: "chargedRevision",
      credits: 3,
      balance: 9,
    });
    expect(parseCreditMessage(t("chargedFormats", { credits: 4, count: 2, balance: 8 }))).toEqual({
      kind: "chargedFormats",
      credits: 4,
      count: 2,
      balance: 8,
    });
    expect(parseCreditMessage(t("refundedFailure", { credits: 10 }))).toEqual({
      kind: "refunded",
      credits: 10,
    });
    expect(parseCreditMessage(`  ${t("refundedFailure", { credits: 10 })}\n`)).toEqual({
      kind: "refunded",
      credits: 10,
    });
    expect(parseCreditMessage("Ролик готовий. Завантаження — праворуч.")).toBeNull();
    expect(parseCreditMessage("Не вистачає кредитів: потрібно багато")).toBeNull();
    expect(parseCreditMessage(`${t("chargedRevision", { credits: 3, balance: 9 })} І ще щось`)).toBeNull();
  });
});

// ───────────── router.js ─────────────

describe("router.js", () => {
  const cases: [string, Route][] = [
    ["/", { route: "start" }],
    ["/?project=p_zerno", { route: "project", projectId: "p_zerno" }],
    ["/?cabinet=balance", { route: "cabinet", section: "balance" }],
    ["/?cabinet=history", { route: "cabinet", section: "history" }],
    ["/?cabinet=projects", { route: "cabinet", section: "projects" }],
    ["/?cabinet=profile", { route: "cabinet", section: "profile" }],
    ["/?checkout=t_9q4m", { route: "checkout", id: "t_9q4m" }],
    ["/?admin=users", { route: "admin", tab: "users" }],
    ["/?admin=outbox", { route: "admin", tab: "outbox" }],
    ["/?admin=all", { route: "admin", tab: "all" }],
    ["/?admin=users&user=u_olena01", { route: "admin", tab: "users", userId: "u_olena01" }],
  ];

  it.each(cases)("%s ↔ маршрут", (url, route) => {
    expect(routeFromUrl(new URLSearchParams(url.slice(1)))).toEqual(route);
    expect(urlForRoute(route)).toBe(url);
  });

  it("посилання з листа: start + auth", () => {
    expect(routeFromUrl(new URLSearchParams("auth=activate&token=abc"))).toEqual({
      route: "start",
      auth: { kind: "activate", token: "abc" },
    });
    expect(routeFromUrl(new URLSearchParams("auth=reset&token=x%2By"))).toEqual({
      route: "start",
      auth: { kind: "reset", token: "x+y" },
    });
    expect(routeFromUrl(new URLSearchParams("project=p1&auth=activate&token=t"))).toEqual({
      route: "project",
      projectId: "p1",
      auth: { kind: "activate", token: "t" },
    });
    expect(routeFromUrl(new URLSearchParams("auth=activate"))).toEqual({ route: "start" });
    expect(routeFromUrl(new URLSearchParams("auth=other&token=abc"))).toEqual({ route: "start" });
  });

  it("невідомий розділ / вкладка → перший за списком", () => {
    expect(routeFromUrl(new URLSearchParams("cabinet="))).toEqual({ route: "cabinet", section: "balance" });
    expect(routeFromUrl(new URLSearchParams("cabinet=nope"))).toEqual({
      route: "cabinet",
      section: "balance",
    });
    expect(routeFromUrl(new URLSearchParams("admin=x"))).toEqual({ route: "admin", tab: "users" });
  });

  it("mock-режим зберігає службові параметри, решта — ні", () => {
    const mock = new URLSearchParams("mock=1&speed=10&jump=brand&project=p1");
    expect(urlForRoute({ route: "cabinet", section: "history" }, mock)).toBe(
      "/?mock=1&speed=10&cabinet=history",
    );
    expect(urlForRoute({ route: "start" }, mock)).toBe("/?mock=1&speed=10");
    expect(urlForRoute({ route: "project", projectId: "p2" }, mock)).toBe("/?mock=1&speed=10&project=p2");
    const live = new URLSearchParams("speed=10&project=p1");
    expect(urlForRoute({ route: "start" }, live)).toBe("/");
  });
});

// ───────────── data/api.js ─────────────

describe("ApiError", () => {
  it("status, code, message сервера і body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json(402, { error: "insufficient_credits", message: "Не вистачає.", required: 10, available: 4 }),
      ),
    );
    const err = await api("/api/projects").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toBeInstanceOf(Error);
    expect(err).toMatchObject({ status: 402, code: "insufficient_credits", message: "Не вистачає." });
    expect((err as ApiError).body).toMatchObject({ required: 10, available: 4 });
  });

  it("без message — «Помилка N», без error — code null", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("oops", { status: 500 })),
    );
    await expect(api("/x")).rejects.toMatchObject({ status: 500, code: null, message: "Помилка 500" });
  });

  it("мережа → status 0, code network, зрозумілий текст", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    await expect(api("/x")).rejects.toMatchObject({ status: 0, code: "network", message: NETWORK_MESSAGE });
  });

  it("setUnauthorizedHandler — лише на 401 unauthorized, не на invalid_credentials", async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(401, { error: "invalid_credentials", message: "Невірний." })),
    );
    await expect(api("/api/auth/login")).rejects.toMatchObject({ code: "invalid_credentials" });
    expect(handler).not.toHaveBeenCalled();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(401, { error: "unauthorized", message: "Потрібно увійти." })),
    );
    await expect(api("/api/account")).rejects.toMatchObject({ status: 401, code: "unauthorized" });
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0]?.[1]).toBe("/api/account");
  });
});

// ───────────── lib/pending.js ─────────────

describe("lib/pending.js", () => {
  const pending = {
    url: "zerno.example.com",
    manualText: null,
    hadPhotos: true,
    at: "2026-10-19T08:00:00.000Z",
  };

  it("savePending → peekPending → takePending (читає й видаляє), файли — у пам'яті", () => {
    const file = new File(["x"], "a.jpg", { type: "image/jpeg" });
    savePending(pending, [file]);
    expect(JSON.parse(sessionStorage.getItem(PENDING_KEY) ?? "null")).toEqual(pending);
    expect(peekPending()).toEqual(pending);
    expect(peekPending()).toEqual(pending);
    const taken = takePending();
    expect(taken?.pending).toEqual(pending);
    expect(taken?.files).toEqual([file]);
    expect(taken && photosLost(taken)).toBe(false);
    expect(sessionStorage.getItem(PENDING_KEY)).toBeNull();
    expect(takePending()).toBeNull();
    expect(peekPending()).toBeNull();
  });

  it("photosLost: фото були, а файлів у пам'яті вже немає (перезавантаження)", () => {
    sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending));
    const taken = takePending();
    expect(taken?.files).toEqual([]);
    expect(taken && photosLost(taken)).toBe(true);
    savePending({ ...pending, hadPhotos: false }, []);
    const plain = takePending();
    expect(plain && photosLost(plain)).toBe(false);
  });

  it("saveReturn / takeReturn — round-trip, читає й видаляє; биті дані → null", () => {
    const back = {
      kind: "project" as const,
      projectId: "p_zerno",
      host: "zerno.example.com",
      retry: { ctx: "rev" as const, text: "коротше" },
    };
    saveReturn(back);
    expect(JSON.parse(sessionStorage.getItem(RETURN_KEY) ?? "null")).toEqual(back);
    expect(takeReturn()).toEqual(back);
    expect(takeReturn()).toBeNull();
    sessionStorage.setItem(RETURN_KEY, "{not json");
    expect(takeReturn()).toBeNull();
    sessionStorage.setItem(PENDING_KEY, JSON.stringify({ url: 1 }));
    expect(peekPending()).toBeNull();
  });
});

// ───────────── K3 · views/shortage.js ─────────────

describe("views/shortage.js", () => {
  it("тексти, числа, role=alert, кліки; старт — кнопки 40 зі стрілкою", () => {
    const primary = vi.fn();
    const secondary = vi.fn();
    const card = shortageCard({
      title: "Не вистачає кредитів",
      need: 10,
      have: 4,
      size: "start",
      advice: "Різницю закриє пакет «Старт» — 10 кредитів. Після оплати ролик почнеться сам.",
      primary: { label: "Поповнити на 10", onClick: primary },
      secondary: { label: "Своя сума · 6", onClick: secondary },
    });
    expect(card.getAttribute("role")).toBe("alert");
    expect(card.classList.contains("sh--start")).toBe(true);
    expect(card.querySelector(".sh-title")?.textContent).toBe("Не вистачає кредитів");
    expect([...card.querySelectorAll(".sh-num")].map((n) => n.textContent)).toEqual([
      "потрібно10",
      "у вас4",
      "не вистачає6",
    ]);
    expect(card.querySelector(".sh-advice")?.textContent).toMatch(/^Різницю закриє пакет «Старт»/);
    const [p, s] = [...card.querySelectorAll("button")];
    expect(p?.textContent).toBe("Поповнити на 10→");
    expect(p?.querySelector(".btn__arrow")?.getAttribute("aria-hidden")).toBe("true");
    expect(p?.classList.contains("btn--sm")).toBe(false);
    expect(s?.textContent).toBe("Своя сума · 6");
    p?.click();
    s?.click();
    expect(primary).toHaveBeenCalledOnce();
    expect(secondary).toHaveBeenCalledOnce();
  });

  it("чат — кнопки 34 без стрілки; без secondary — одна кнопка; нестача не від'ємна", () => {
    const card = shortageCard({
      title: "Не вистачає на правку",
      need: 3,
      have: 1250,
      size: "chat",
      advice: "…",
      primary: { label: "Поповнити", onClick: () => {} },
    });
    expect(card.classList.contains("sh--chat")).toBe(true);
    const buttons = card.querySelectorAll("button");
    expect(buttons.length).toBe(1);
    expect(buttons[0]?.textContent).toBe("Поповнити");
    expect(buttons[0]?.classList.contains("btn--sm")).toBe(true);
    expect([...card.querySelectorAll(".sh-num b")].map((n) => n.textContent)).toEqual([
      "3",
      `1${NBSP}250`,
      "0",
    ]);
  });

  it("текст передається лише як textContent", () => {
    const card = shortageCard({
      title: "<b>x</b>",
      need: 1,
      have: 0,
      size: "chat",
      advice: "<i>y</i>",
      primary: { label: "<u>z</u>", onClick: () => {} },
    });
    expect(card.querySelector("b.sh-num__value")).not.toBeNull();
    expect(card.querySelector(".sh-title b, i, u")).toBeNull();
    expect(card.querySelector(".sh-advice")?.textContent).toBe("<i>y</i>");
  });
});

// ───────────── data/account.js ─────────────

describe("createAccountActions", () => {
  it("Object.assign на об'єкт createActions: усі ключі AccountActions, геттер ready живий", async () => {
    const { actions } = make();
    for (const key of ACCOUNT_KEYS) expect(typeof actions[key], key).toBe("function");
    const desc = Object.getOwnPropertyDescriptor(actions, "ready");
    expect(typeof desc?.get).toBe("function");
    const before = actions.ready;
    actions.navigate({ route: "project", projectId: "p1" });
    expect(actions.ready).not.toBe(before);
    await actions.ready;
  });

  it("справжні part-фабрики разом дають рівно ключі AccountActions (крім ядра)", async () => {
    const files = ["auth", "start", "retry", "topup", "checkout", "cabinet", "profile", "admin"];
    const store = createStore<UiState>(initialState("start", null));
    const deps: PartDeps = {
      params: new URLSearchParams(),
      api: fakeApi(withBalance(12)),
      actions: () => ({}) as never,
      backend: fakeBackend().backend,
      offline: false,
      onRoute: () => {},
    };
    const keys: string[] = [];
    for (const file of files) {
      const mod = await vi.importActual<Record<string, (s: unknown, d: PartDeps) => object>>(
        `../../public/static/js/data/${file}-actions.js`,
      );
      const [factory, ...extra] = Object.values(mod).filter((v) => typeof v === "function");
      expect(extra, `${file}: одна фабрика`).toEqual([]);
      const part = factory?.(store, deps) ?? {};
      expect(Object.keys(part).sort(), file).toEqual([...(parts.KEYS[file] ?? [])].sort());
      keys.push(...Object.keys(part));
    }
    expect(new Set(keys).size).toBe(keys.length);
    expect([...keys, "refreshMe", "navigate", "logout"].sort()).toEqual([...ACCOUNT_KEYS].sort());
  });

  it("старт: me → ready; 401 → anon; мережа → anon; без delta на першому завантаженні", async () => {
    const ok = make();
    await ok.actions.meReady;
    expect(ok.store.getState().account).toMatchObject({
      meStatus: "ready",
      me: { balance: 12 },
      delta: null,
    });
    ok.actions.dispose();
    const guest = make({ answers: [401] });
    await guest.actions.meReady;
    expect(guest.store.getState().account).toMatchObject({ meStatus: "anon", me: null });
    guest.actions.dispose();
    const offline = make({ answers: [0] });
    await offline.actions.meReady;
    expect(offline.store.getState().account.meStatus).toBe("anon");
  });

  it("refreshMe ставить delta, коли баланс змінився", async () => {
    const { actions, store } = make({
      answers: [withBalance(12), withBalance(9), withBalance(19), withBalance(19)],
    });
    await actions.meReady;
    await actions.refreshMe();
    const d1 = store.getState().account.delta;
    expect(d1?.credits).toBe(-3);
    await actions.refreshMe();
    const d2 = store.getState().account.delta;
    expect(d2?.credits).toBe(10);
    expect(d2?.key).toBeGreaterThan(d1?.key ?? Number.POSITIVE_INFINITY);
    await actions.refreshMe();
    expect(store.getState().account.delta).toBe(d2);
    expect(store.getState().account.me?.balance).toBe(19);
  });

  it("повідомлення білінгу від assistant у стрічці → refreshMe", async () => {
    const { actions, store, accountApi } = make({ answers: [withBalance(12), withBalance(9)] });
    await actions.meReady;
    expect(accountApi.me).toHaveBeenCalledTimes(1);
    const now = new Date().toISOString();
    const message = (id: string, role: "assistant" | "user", text: string, at = now) => ({
      kind: "message" as const,
      id,
      at,
      role,
      text,
      buttons: [],
    });
    // Реплей історії SSE: старе повідомлення білінгу не смикає refreshMe.
    store.setState((s) => ({
      feed: [
        ...s.feed,
        message("0-1", "assistant", t("refundedFailure", { credits: 10 }), "2026-10-14T07:00:00.000Z"),
      ],
    }));
    store.setState((s) => ({ feed: [...s.feed, message("1-0", "assistant", "Ролик готовий.")] }));
    store.setState((s) => ({
      feed: [...s.feed, message("2-0", "user", t("chargedRevision", { credits: 3, balance: 9 }))],
    }));
    expect(accountApi.me).toHaveBeenCalledTimes(1);
    store.setState((s) => ({
      feed: [...s.feed, message("3-0", "assistant", t("chargedRevision", { credits: 3, balance: 9 }))],
    }));
    await vi.waitFor(() => expect(store.getState().account.delta?.credits).toBe(-3));
    expect(accountApi.me).toHaveBeenCalledTimes(2);
  });

  it("401 на project → session 401 + форма входу в сцені, потік зупинено; me 401 — ні", async () => {
    const state = { ...initialState("project", "p1"), route: "project" as const };
    const { actions, store, log } = make({ state, query: "project=p1" });
    await actions.meReady;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(401, { error: "unauthorized", message: "Потрібно увійти." })),
    );
    await expect(api("/api/auth/me")).rejects.toBeInstanceOf(ApiError);
    expect(store.getState().session).toBeNull();
    await expect(api("/api/projects/p1")).rejects.toBeInstanceOf(ApiError);
    const s = store.getState();
    expect(s.session).toBe("401");
    expect(s.auth).toMatchObject({ view: "login", context: "session", email: "", busy: false });
    expect(s.account).toMatchObject({ meStatus: "anon", me: null });
    expect(log.at(-1)).toBe("stop");
  });

  it("401 на іншому маршруті → openAuth(login, session)", async () => {
    const { actions } = make({ query: "cabinet=history", state: initialState("cabinet", null) });
    await actions.meReady;
    const openAuth = vi.fn();
    actions.openAuth = openAuth;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(401, { error: "unauthorized", message: "Потрібно увійти." })),
    );
    await expect(api("/api/account/transactions")).rejects.toBeInstanceOf(ApiError);
    expect(openAuth).toHaveBeenCalledWith("login", "session");
  });

  it("navigate: pushState, стан маршруту, stop при виході з проєкту, start при вході", async () => {
    const { actions, store, log } = make();
    await actions.meReady;
    actions.navigate({ route: "project", projectId: "p_zerno" });
    expect(location.search).toBe("?project=p_zerno");
    expect(store.getState()).toMatchObject({ route: "project", projectId: "p_zerno", status: "intake" });
    expect(log).toEqual(["stop", "start p_zerno"]);
    store.setState({ status: "delivered", session: "404" });
    actions.navigate({ route: "cabinet", section: "projects" });
    expect(location.search).toBe("?cabinet=projects");
    expect(store.getState()).toMatchObject({ route: "cabinet", session: null });
    expect(store.getState().cabinet.section).toBe("projects");
    expect(log.at(-1)).toBe("stop");
    actions.navigate({ route: "checkout", id: "t_1" });
    expect(store.getState().checkout).toMatchObject({
      id: "t_1",
      status: "loading",
      returnTo: { kind: "cabinet" },
    });
    actions.navigate({ route: "admin", tab: "outbox" });
    expect(location.search).toBe("?admin=outbox");
    expect(store.getState().admin).toMatchObject({ tab: "outbox", selectedId: null });
    const account = store.getState().account;
    actions.navigate({ route: "start" });
    expect(location.pathname + location.search).toBe("/");
    expect(store.getState()).toMatchObject({ route: "start", projectId: null, status: "intake" });
    expect(store.getState().account).toBe(account);
  });

  it("popstate веде тим самим шляхом", async () => {
    const { actions, store } = make();
    await actions.meReady;
    actions.navigate({ route: "cabinet", section: "history" });
    actions.navigate({ route: "cabinet", section: "profile" });
    history.replaceState(null, "", "/?cabinet=history");
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(store.getState().cabinet.section).toBe("history");
  });

  it("applyRoute / routeOf — взаємно зворотні", () => {
    const base = initialState("start", null);
    const routes: Route[] = [
      { route: "start" },
      { route: "project", projectId: "p1" },
      { route: "cabinet", section: "profile" },
      { route: "checkout", id: "t_1" },
      { route: "admin", tab: "all" },
      { route: "admin", tab: "users", userId: "u_olena01" },
    ];
    for (const r of routes) expect(routeOf({ ...base, ...applyRoute(base, r) })).toEqual(r);
  });

  it("logout → POST, гість, старт із flash", async () => {
    const { actions, store, accountApi } = make();
    await actions.meReady;
    actions.navigate({ route: "cabinet", section: "profile" });
    await actions.logout();
    expect(accountApi.logout).toHaveBeenCalledOnce();
    const s = store.getState();
    expect(s.route).toBe("start");
    expect(s.account).toMatchObject({ me: null, meStatus: "anon", flash: LOGOUT_FLASH });
    expect(location.pathname + location.search).toBe("/");
  });

  it("охорона: гість на cabinet / checkout → модалка login (header / checkout), маршрут лишається", async () => {
    const cab = make({ answers: [401], query: "cabinet=balance", state: initialState("cabinet", null) });
    const openAuth = vi.fn();
    cab.actions.openAuth = openAuth;
    await cab.actions.meReady;
    expect(openAuth).toHaveBeenCalledWith("login", "header");
    expect(cab.store.getState().route).toBe("cabinet");
    cab.actions.dispose();
    const co = make({ answers: [401], state: initialState("start", null) });
    const openCo = vi.fn();
    co.actions.openAuth = openCo;
    await co.actions.meReady;
    co.actions.navigate({ route: "checkout", id: "t_1" });
    expect(openCo).toHaveBeenCalledWith("login", "checkout");
    expect(co.store.getState().route).toBe("checkout");
  });

  it("охорона: після входу підписники onRoute отримують маршрут ще раз; admin без isAdmin → 403", async () => {
    const { actions, store } = make({
      answers: [401, withBalance(12)],
      state: initialState("cabinet", null),
    });
    actions.openAuth = vi.fn();
    const seen: Route[] = [];
    depsOf("cabinet").onRoute((r) => seen.push(r));
    await actions.meReady;
    expect(seen).toEqual([]);
    await actions.refreshMe(); // вхід виконано (B1 викликає refreshMe)
    expect(seen).toEqual([{ route: "cabinet", section: "balance" }]);
    actions.navigate({ route: "admin", tab: "users" });
    expect(store.getState().session).toBe("403");
    expect(store.getState().admin.forbidden).toBe(true);
    expect(seen).toHaveLength(1);
    actions.navigate({ route: "cabinet", section: "history" });
    expect(store.getState().session).toBeNull();
    expect(seen.at(-1)).toEqual({ route: "cabinet", section: "history" });
  });

  it("адмін проходить на admin; deps для part-файлів", async () => {
    const { actions, store } = make({ answers: [ADMIN_ME] });
    await actions.meReady;
    const seen: Route[] = [];
    depsOf("cabinet").onRoute((r) => seen.push(r));
    actions.navigate({ route: "admin", tab: "users", userId: "u_olena01" });
    expect(store.getState().session).toBeNull();
    expect(seen).toEqual([{ route: "admin", tab: "users", userId: "u_olena01" }]);
    expect(depsOf("admin").actions()).toBe(actions);
    expect(depsOf("topup").offline).toBe(false);
    expect(typeof depsOf("checkout").api.me).toBe("function");
  });

  it("посилання з листа: токен прибрано з URL, auth activating + submitAuth / reset", async () => {
    history.replaceState(null, "", "/?auth=activate&token=tok1");
    const a = make({ query: "auth=activate&token=tok1" });
    expect(location.search).toBe("");
    expect(a.store.getState().auth).toMatchObject({ view: "activating", token: "tok1", context: null });
    expect(fn("submitAuth")).toHaveBeenCalledOnce();
    a.actions.dispose();
    history.replaceState(null, "", "/?auth=reset&token=tok2");
    const r = make({ query: "auth=reset&token=tok2" });
    expect(location.search).toBe("");
    expect(r.store.getState().auth).toMatchObject({ view: "reset", token: "tok2" });
    expect(fn("submitAuth")).not.toHaveBeenCalled();
    r.actions.dispose();
    history.replaceState(null, "", "/?project=p1&auth=activate&token=tok3");
    make({ query: "project=p1&auth=activate&token=tok3", state: initialState("project", "p1") });
    expect(location.search).toBe("?project=p1");
  });

  it("застаріла відповідь me відкидається (активація: пізній 401 від першого me)", async () => {
    let release: (v: unknown) => void = () => {};
    const slow = new Promise((resolve) => {
      release = resolve;
    });
    const { actions, store, accountApi } = make();
    accountApi.me.mockReset();
    accountApi.me
      .mockImplementationOnce(async () => {
        await slow;
        throw new ApiError("x", 401, "unauthorized", null);
      })
      .mockImplementationOnce(async () => withBalance(5));
    const first = actions.refreshMe();
    await actions.refreshMe();
    expect(store.getState().account).toMatchObject({ meStatus: "ready", me: { balance: 5 } });
    release(null);
    await first;
    expect(store.getState().account).toMatchObject({ meStatus: "ready", me: { balance: 5 } });
  });

  it("401 на me після входу (сесія протухла): project → session 401; інші → openAuth(login, session)", async () => {
    const state = { ...initialState("project", "p1"), route: "project" as const };
    const p = make({ state, query: "project=p1", answers: [withBalance(12), 401] });
    await p.actions.meReady;
    await p.actions.refreshMe();
    expect(p.store.getState().session).toBe("401");
    expect(p.store.getState().auth).toMatchObject({ view: "login", context: "session" });
    expect(p.log.at(-1)).toBe("stop");
    p.actions.dispose();
    const c = make({ state: initialState("cabinet", null), answers: [withBalance(12), 401] });
    await c.actions.meReady;
    await c.actions.refreshMe();
    expect(fn("openAuth")).toHaveBeenCalledWith("login", "session");
    expect(c.store.getState().account.meStatus).toBe("anon");
    c.actions.dispose();
    // Гість (не був ready) — просто anon, без модалки.
    const g = make({ answers: [401] });
    await g.actions.meReady;
    await g.actions.refreshMe();
    expect(fn("openAuth")).not.toHaveBeenCalled();
    expect(g.store.getState().session).toBeNull();
  });

  it("projectCount: вантажиться, коли me ready, і після успішного createProject", async () => {
    const { actions, store, accountApi } = make();
    expect(store.getState().account.projectCount).toBeNull();
    await actions.meReady;
    await vi.waitFor(() => expect(store.getState().account.projectCount).toBe(4));
    expect(accountApi.listProjects).toHaveBeenCalledTimes(1);
    accountApi.listProjects.mockResolvedValueOnce({ projects: [...PROJECTS, PROJECTS[0]] } as never);
    const form = new FormData();
    form.set("url", "zerno.example.com");
    await actions.createProject(form);
    await vi.waitFor(() => expect(store.getState().account.projectCount).toBe(5));
    expect(store.getState().route).toBe("project");
  });

  it("admin: forbidden скидається на кожному вході; selected — лише для того самого userId", async () => {
    const { actions, store, accountApi } = make();
    await actions.meReady;
    actions.navigate({ route: "admin", tab: "users" });
    expect(store.getState().admin.forbidden).toBe(true);
    accountApi.me.mockResolvedValue(ADMIN_ME);
    await actions.refreshMe();
    actions.navigate({ route: "admin", tab: "users", userId: "u_olena01" });
    expect(store.getState().admin.forbidden).toBe(false);
    expect(store.getState().session).toBeNull();
    const selected = { user: ME.user, balance: 12, entries: HISTORY };
    store.setState((s) => ({ admin: { ...s.admin, selected } }));
    actions.navigate({ route: "admin", tab: "outbox", userId: "u_olena01" });
    expect(store.getState().admin.selected).toBe(selected);
    actions.navigate({ route: "admin", tab: "users", userId: "u_andriy02" });
    expect(store.getState().admin.selected).toBeNull();
  });

  it("logout скидає кабінет, адмінку, чек і projectCount попереднього користувача", async () => {
    const { actions, store } = make();
    await actions.meReady;
    await vi.waitFor(() => expect(store.getState().account.projectCount).toBe(4));
    actions.navigate({ route: "checkout", id: "t_1" });
    store.setState((s) => ({
      cabinet: { ...s.cabinet, history: { ...s.cabinet.history, entries: HISTORY } },
      admin: { ...s.admin, q: "olena" },
    }));
    await actions.logout();
    const s = store.getState();
    expect(s.cabinet).toEqual(initialState("start", null).cabinet);
    expect(s.admin).toEqual(initialState("start", null).admin);
    expect(s.checkout).toBeNull();
    expect(s.account.projectCount).toBeNull();
    expect(s.account.flash).toBe(LOGOUT_FLASH);
  });

  it("?mock=1 — фейковий me (Олена, 12) без мережі", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const store = createStore<UiState>(initialState("start", null));
    const actions = createAccountActions(store, { params: new URLSearchParams("mock=1") });
    made = actions;
    await actions.meReady;
    expect(store.getState().account).toMatchObject({
      meStatus: "ready",
      me: { balance: 12 },
      projectCount: 4,
    });
    expect(store.getState().account.me?.user.email).toBe("olena@zerno.example.com");
    await actions.refreshMe();
    expect(fetch).not.toHaveBeenCalled();
  });
});

// ───────────── data/actions.js (зміни Кроку 0) ─────────────

describe("data/actions.js", () => {
  class NoopEventSource {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 2;
    readyState = 0;
    onopen = null;
    onerror = null;
    addEventListener() {}
    close() {}
  }
  const EventSource = NoopEventSource as never;

  it("createProject: 402 → ui.startShortage, успіх → refreshMe, гілки акаунта не скидаються", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json(402, { error: "insufficient_credits", message: "x", required: 10, available: 4 }),
      ),
    );
    const refreshMe = vi.fn(async () => {});
    const start = {
      ...initialState("start", null),
      account: { ...initialState("start", null).account, flash: "f" },
    };
    const store = createStore<UiState>(start);
    const actions = createActions(store, {
      params: new URLSearchParams(),
      EventSource,
      batchMs: 0,
      refreshMe,
    });
    const form = new FormData();
    form.set("url", "zerno.example.com");
    await actions.createProject(form);
    expect(store.getState().ui).toMatchObject({
      startShortage: { need: 10, have: 4 },
      startError: null,
      sending: false,
    });
    expect(refreshMe).not.toHaveBeenCalled();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url === "/api/projects"
          ? json(201, { id: "abc", chatUrl: "/?project=abc", balance: 2 })
          : json(200, { id: "abc", status: "intake", project: null, intake: null, totalUsd: 0 }),
      ),
    );
    await actions.createProject(form);
    await actions.ready;
    expect(refreshMe).toHaveBeenCalledOnce();
    expect(store.getState()).toMatchObject({ route: "project", projectId: "abc", projectCredits: null });
    expect(store.getState().ui.startShortage).toBeNull();
    expect(store.getState().account.flash).toBe("f");
    actions.dispose();
  });

  it("GET проєкту: credits → projectCredits; 404 not_found → session 404", async () => {
    const credits = PROJECTS.find((p) => p.id === "p_zerno")?.credits;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json(200, { id: "p1", status: "delivered", project: null, intake: null, totalUsd: 0, credits }),
      ),
    );
    const store = createStore<UiState>(initialState("project", "p1"));
    const actions = createActions(store, {
      params: new URLSearchParams("project=p1"),
      EventSource,
      batchMs: 0,
    });
    await actions.ready;
    expect(store.getState().projectCredits).toEqual(credits);
    actions.dispose();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(404, { error: "not_found", message: "Не знайдено." })),
    );
    const lost = createStore<UiState>(initialState("project", "p2"));
    const a2 = createActions(lost, { params: new URLSearchParams("project=p2"), EventSource, batchMs: 0 });
    await a2.ready;
    expect(lost.getState().session).toBe("404");
    expect(lost.getState().ui.notice).toBeNull();
    a2.dispose();
  });
});

describe("dev/fixtures/_base.js", () => {
  it("історія з 11 записів сходиться з балансом 12", () => {
    expect(HISTORY).toHaveLength(11);
    expect(HISTORY[0]?.balanceAfter).toBe(12);
    for (let i = 0; i < HISTORY.length - 1; i++) {
      const newer = HISTORY[i];
      const older = HISTORY[i + 1];
      expect(newer && older && older.balanceAfter + newer.credits).toBe(newer?.balanceAfter);
    }
    expect(ME.balance).toBe(12);
    expect(PROJECTS).toHaveLength(4);
    expect(PROJECTS.find((p) => p.id === "p_zerno")?.credits).toMatchObject({ charged: 15, refunded: 0 });
  });
});
