// @vitest-environment happy-dom
/**
 * S1 старт (B1 прототипу) + B2 акаунтів (N3-A): шапка гостя й користувача, рядок ціни, K3,
 * відкладений старт, автостарт, flash після виходу, «Мої проєкти · N».
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fixtureStates } from "../../public/static/dev/fixture-states.js";
import { ME, meOf, OLENA, PRICES } from "../../public/static/dev/fixtures/_base.js";
import type { Actions, Me, PartDeps, UiState } from "../../public/static/js/contracts.js";
import { SEGMENTS } from "../../public/static/js/contracts.js";
import { LOGOUT_FLASH } from "../../public/static/js/data/account.js";
import * as realApi from "../../public/static/js/data/account-api.js";
import type { Backend } from "../../public/static/js/data/actions.js";
import { createActions } from "../../public/static/js/data/actions.js";
import { AUTOSTART_MIN_MS, startActions } from "../../public/static/js/data/start-actions.js";
import { initialState } from "../../public/static/js/initial.js";
import { PENDING_KEY, peekPending, savePending } from "../../public/static/js/lib/pending.js";
import { createStore } from "../../public/static/js/store.js";
import { EXAMPLE_HOST, formatTime, MAX_PHOTOS, mount } from "../../public/static/js/views/start.js";

type SubmitStart = Actions["submitStart"];

/** Фікстура за назвою (B2 — dev/fixtures/start.js). */
function fixture(name: string): UiState {
  const s = fixtureStates[name];
  if (!s) throw new Error(`немає фікстури ${name}`);
  return s;
}

const NBSP = " ";
/** Текст без розривів U+00A0 — для порівняння з копірайтом. */
const plain = (node: Element | null) => (node?.textContent ?? "").replaceAll(NBSP, " ");

const user = (balance: number): Me => meOf(OLENA, balance);
const guest = (patch: Partial<UiState["account"]> = {}): UiState => {
  const s = initialState("start", null);
  return { ...s, account: { ...s.account, meStatus: "anon", prices: PRICES, ...patch } };
};
const signedIn = (balance = 12, patch: Partial<UiState["account"]> = {}): UiState => {
  const s = initialState("start", null);
  return {
    ...s,
    account: {
      ...s.account,
      me: user(balance),
      meStatus: "ready",
      projectCount: 4,
      prices: PRICES,
      ...patch,
    },
  };
};

/** Дії view: усе — моки. */
function viewActions() {
  return {
    submitStart: vi.fn<SubmitStart>(async () => {}),
    openAuth: vi.fn(),
    openTopup: vi.fn(),
    navigate: vi.fn(),
    dismissFlash: vi.fn(),
  };
}

function setup(state: UiState = fixture("start"), actions = viewActions()) {
  const el = document.createElement("section");
  document.body.append(el);
  const store = createStore(state);
  const view = mount(el, { store, actions: actions as unknown as Actions });
  let prev = store.getState();
  store.subscribe((next) => {
    view.update(next, prev);
    prev = next;
  });
  const q = <T extends Element>(sel: string) => {
    const node = el.querySelector<T>(sel);
    if (!node) throw new Error(`немає ${sel}`);
    return node;
  };
  const setUi = (patch: Partial<UiState["ui"]>) => store.setState((s) => ({ ui: { ...s.ui, ...patch } }));
  const setAccount = (patch: Partial<UiState["account"]>) =>
    store.setState((s) => ({ account: { ...s.account, ...patch } }));
  const submit = () => q<HTMLFormElement>("form").dispatchEvent(new Event("submit", { cancelable: true }));
  return { el, store, view, q, setUi, setAccount, submit, actions, submitStart: actions.submitStart };
}

function setFiles(input: HTMLInputElement, count: number) {
  const files = Array.from({ length: count }, (_, i) => new File(["x"], `p${i}.jpg`, { type: "image/jpeg" }));
  Object.defineProperty(input, "files", { configurable: true, value: files });
  input.dispatchEvent(new Event("change"));
  return files;
}

/** FormData першого виклику submitStart. */
function sentForm(fn: { mock: { calls: Parameters<SubmitStart>[] } }): FormData {
  const form = fn.mock.calls[0]?.[0];
  if (!form) throw new Error("submitStart не викликано");
  return form;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

/** Мережі в тестах немає: будь-який fetch — помилка тесту. */
const fetchStub = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
  throw new Error(`fetch у тесті: ${String(input)}`);
});

beforeEach(() => {
  vi.stubGlobal("fetch", fetchStub);
  fetchStub.mockClear();
});

afterEach(() => {
  document.body.textContent = "";
  localStorage.clear();
  sessionStorage.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("views/start.js", () => {
  it("рендериться з fixtureStates.start", () => {
    const { q, el } = setup();
    expect(q(".st-head .wordmark").textContent).toBe("AdCreative");
    const title = q("h1.display-xl");
    expect(title.querySelector(".accent-dot")?.textContent).toBe(".");
    expect(q(".st-lead").classList.contains("body-l")).toBe(true);
    expect(q<HTMLInputElement>('input[name="url"]').value).toBe("");
    expect(q(".st-submit").textContent).toContain("Почати");
    expect(q<HTMLButtonElement>(".st-submit").disabled).toBe(false);
    expect(q<HTMLParagraphElement>(".st-error").hidden).toBe(true);
    expect(q(".st-error").getAttribute("role")).toBe("alert");

    const file = q<HTMLInputElement>('input[type="file"][name="photos"]');
    expect(file.multiple).toBe(true);
    expect(file.getAttribute("accept")).toBe("image/*,.heic,.heif");
    expect(q(".st-photos").textContent).toBe(`+ Фото (до ${MAX_PHOTOS})`);
    expect(q<HTMLDivElement>(".st-manual").hidden).toBe(true);

    const video = q<HTMLVideoElement>("video");
    expect(video.getAttribute("src")).toBe("/static/media/sample-9x16.mp4");
    expect(video.getAttribute("poster")).toBe("/static/media/sample-9x16.jpg");
    expect(video.muted).toBe(true);
    expect(video.hasAttribute("loop")).toBe(true);
    expect(video.hasAttribute("playsinline")).toBe(true);
    expect(q(".st-time").textContent).toBe("0:00 / 0:00");

    const segs = [...el.querySelectorAll(".st-legend__seg")].map((n) => n.textContent);
    expect(segs).toEqual(SEGMENTS.map((s, i) => `0${i + 1} ${s.label}`));
    const diamonds = [...el.querySelectorAll<HTMLElement>(".st-legend__diamond")];
    expect(diamonds.map((d) => d.style.left)).toEqual(["34.33%", "52.24%", "76.12%"]);
    expect(el.querySelector(".diamond--open, .diamond--done")).toBeNull();
    expect(q(".st-note").textContent).toContain("Три чекпоінти");
  });

  it("«Приклад» підставляє адресу", () => {
    const { q } = setup();
    q<HTMLButtonElement>(".st-example").click();
    expect(q<HTMLInputElement>('input[name="url"]').value).toBe(EXAMPLE_HOST);
  });

  it("«Немає сайту?» розкриває і ховає textarea manualText", () => {
    const { q } = setup();
    const toggle = q<HTMLButtonElement>(".st-manual-toggle");
    toggle.click();
    expect(q<HTMLDivElement>(".st-manual").hidden).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(q('textarea[name="manualText"]')).toBeTruthy();
    toggle.click();
    expect(q<HTMLDivElement>(".st-manual").hidden).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("сабміт з адресою і фото кличе submitStart з правильним FormData", async () => {
    const { q, submit, submitStart } = setup();
    q<HTMLInputElement>('input[name="url"]').value = "  zerno.example.com ";
    const files = setFiles(q<HTMLInputElement>('input[name="photos"]'), 3);
    expect(q(".st-photos").textContent).toBe("Фото: 3");
    submit();
    await flush();
    expect(submitStart).toHaveBeenCalledOnce();
    const form = sentForm(submitStart);
    expect(form.get("url")).toBe("zerno.example.com");
    expect(form.has("manualText")).toBe(false);
    const sent = form.getAll("photos") as File[];
    expect(sent.map((f) => f.name)).toEqual(files.map((f) => f.name));
  });

  it("сабміт з описом бізнесу без адреси шле лише manualText", async () => {
    const { q, submit, submitStart } = setup();
    q<HTMLButtonElement>(".st-manual-toggle").click();
    q<HTMLTextAreaElement>('textarea[name="manualText"]').value = "Кав'ярня на Подолі.";
    submit();
    await flush();
    const form = sentForm(submitStart);
    expect([...form.keys()]).toEqual(["manualText"]);
    expect(form.get("manualText")).toBe("Кав'ярня на Подолі.");
  });

  it("порожній сабміт показує помилку і не кличе submitStart", async () => {
    const { q, submit, submitStart } = setup();
    submit();
    await flush();
    expect(submitStart).not.toHaveBeenCalled();
    const err = q<HTMLParagraphElement>(".st-error");
    expect(err.hidden).toBe(false);
    expect(err.textContent).toMatch(/адресу сайту/);
    const url = q<HTMLInputElement>('input[name="url"]');
    url.value = "z";
    url.dispatchEvent(new Event("input"));
    expect(err.hidden).toBe(true);
  });

  it(`понад ${MAX_PHOTOS} фото — помилка, фото не надсилаються`, async () => {
    const { q, submit, submitStart } = setup();
    setFiles(q<HTMLInputElement>('input[name="photos"]'), MAX_PHOTOS + 1);
    expect(q(".st-error").textContent).toContain(`до ${MAX_PHOTOS} фото`);
    expect(q(".st-photos").textContent).toBe(`+ Фото (до ${MAX_PHOTOS})`);
    setFiles(q<HTMLInputElement>('input[name="photos"]'), 2);
    expect(q<HTMLParagraphElement>(".st-error").hidden).toBe(true);
    q<HTMLInputElement>('input[name="url"]').value = "zerno.example.com";
    submit();
    await flush();
    expect(sentForm(submitStart).getAll("photos")).toHaveLength(2);
  });

  it("ui.startError показується під полем і зникає", () => {
    const { q, setUi } = setup();
    const err = q<HTMLParagraphElement>(".st-error");
    setUi({ startError: "Це внутрішня або приватна адреса." });
    expect(err.hidden).toBe(false);
    expect(err.textContent).toBe("Це внутрішня або приватна адреса.");
    setUi({ startError: null });
    expect(err.hidden).toBe(true);
    expect(err.textContent).toBe("");
  });

  it("кнопка disabled зі спінером, поки запит триває, і за ui.sending", async () => {
    let resolve: () => void = () => {};
    const actions = viewActions();
    actions.submitStart.mockImplementation(
      () =>
        new Promise<void>((r) => {
          resolve = r;
        }),
    );
    const { q, submit, setUi } = setup(fixture("start"), actions);
    const btn = q<HTMLButtonElement>(".st-submit");
    const spinner = q<HTMLElement>(".st-submit__spinner");
    q<HTMLInputElement>('input[name="url"]').value = "zerno.example.com";
    submit();
    expect(btn.disabled).toBe(true);
    expect(spinner.hidden).toBe(false);
    submit();
    expect(actions.submitStart).toHaveBeenCalledOnce();
    resolve();
    await flush();
    expect(btn.disabled).toBe(false);
    expect(spinner.hidden).toBe(true);
    setUi({ sending: true });
    expect(btn.disabled).toBe(true);
    setUi({ sending: false });
    expect(btn.disabled).toBe(false);
  });

  it("update не перестворює video, поля й textarea", () => {
    const { el, q, setUi, setAccount, store } = setup();
    const before = ["video", 'input[name="url"]', 'input[name="photos"]', "textarea"].map((s) => q(s));
    q<HTMLInputElement>('input[name="url"]').value = "чернетка";
    setUi({ startError: "x", sending: true });
    setUi({ startError: null, sending: false, startShortage: { need: 10, have: 4 } });
    setAccount({ me: ME, meStatus: "ready", flash: "x" });
    store.setState({ status: "crawling" });
    const after = ["video", 'input[name="url"]', 'input[name="photos"]', "textarea"].map((s) => q(s));
    after.forEach((node, i) => {
      expect(node).toBe(before[i]);
    });
    expect(q<HTMLInputElement>('input[name="url"]').value).toBe("чернетка");
    expect(el.querySelectorAll("video")).toHaveLength(1);
  });

  it("помилка відео → смугастий плейсхолдер 9:16", () => {
    const { q } = setup();
    const video = q<HTMLVideoElement>("video");
    video.dispatchEvent(new Event("error"));
    expect(video.hidden).toBe(true);
    expect(q(".st-frame").classList.contains("stripes")).toBe(true);
  });

  it("timeupdate рухає тайм-код і смугу", () => {
    const { q } = setup();
    const video = q<HTMLVideoElement>("video");
    Object.defineProperty(video, "duration", { configurable: true, value: 15 });
    Object.defineProperty(video, "currentTime", { configurable: true, value: 3.4 });
    video.dispatchEvent(new Event("timeupdate"));
    expect(q(".st-time").textContent).toBe("0:03 / 0:15");
    expect(Number(q<HTMLElement>(".st-bar .bar__fill").style.getPropertyValue("--bar-value"))).toBeCloseTo(
      3.4 / 15,
    );
    expect(formatTime(75)).toBe("1:15");
  });

  it("destroy прибирає розмітку", () => {
    const { el, view } = setup(signedIn());
    view.destroy();
    expect(el.childElementCount).toBe(0);
  });
});

describe("N3-A · шапка", () => {
  it("гість — «Увійти» → dismissFlash + openAuth(login, header)", () => {
    const { q, actions, el } = setup(guest());
    const login = q<HTMLButtonElement>(".st-head .st-login");
    expect(login.textContent).toBe("Увійти");
    expect(login.classList.contains("btn--ghost")).toBe(true);
    expect(el.querySelector(".st-account .ac")).toBeNull();
    login.click();
    expect(actions.dismissFlash).toHaveBeenCalledOnce();
    expect(actions.openAuth).toHaveBeenCalledWith("login", "header");
  });

  it("гість — коло теми перед «Увійти» (порядок Tab = видимий); користувачу — лише меню акаунта", () => {
    const { el, setAccount } = setup(guest());
    const head = el.querySelector(".st-account") as HTMLElement;
    const trigger = head.querySelector(".tm-trigger");
    const login = head.querySelector(".st-login");
    expect(trigger?.getAttribute("aria-haspopup")).toBe("menu");
    expect(
      trigger && login && trigger.compareDocumentPosition(login) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    setAccount({ me: ME, meStatus: "ready" });
    expect(head.querySelector(".tm-trigger")).toBeNull();
    setAccount({ me: null, meStatus: "anon" });
    expect(head.querySelectorAll(".tm-trigger").length).toBe(1);
  });

  it("me вантажиться — порожньо; користувач — контроли акаунта з place start", () => {
    const { el, setAccount } = setup(fixture("start"));
    const head = el.querySelector(".st-account");
    expect(head?.childElementCount).toBe(0);
    setAccount({ me: ME, meStatus: "ready" });
    expect(el.querySelector(".st-login")).toBeNull();
    const controls = el.querySelector(".st-account .ac");
    expect(controls?.classList.contains("ac--start")).toBe(true);
    setAccount({ me: null, meStatus: "anon" });
    expect(el.querySelector(".st-account .ac")).toBeNull();
    expect(el.querySelector(".st-login")).not.toBeNull();
  });
});

describe("N3-A · рядок ціни", () => {
  it("користувач: «Ролик — 10 кредитів · у вас 12», без «поповнити»", () => {
    const { q } = setup(signedIn(12));
    const price = q<HTMLElement>(".st-price");
    expect(price.hidden).toBe(false);
    expect(plain(price)).toBe("Ролик — 10 кредитів·у вас 12·поповнити");
    expect(q<HTMLElement>(".st-price__more").hidden).toBe(true);
  });

  it("нестача: «поповнити» → openTopup({from: start})", () => {
    const { q, actions } = setup(signedIn(4));
    expect(plain(q(".st-price__tail"))).toBe("у вас 4");
    expect(q<HTMLElement>(".st-price__more").hidden).toBe(false);
    q<HTMLButtonElement>(".st-price__topup").click();
    expect(actions.openTopup).toHaveBeenCalledWith({ from: "start" });
  });

  it("гість: «Ролик — 10 кредитів · правки на чекпоінтах безкоштовні» з account.prices", () => {
    const { q } = setup(guest());
    const price = q<HTMLElement>(".st-price");
    expect(price.hidden).toBe(false);
    const visible = [...price.querySelectorAll<HTMLElement>(":scope > :not([hidden])")].map(plain);
    expect(visible.join(" ")).toBe("Ролик — 10 кредитів· правки на чекпоінтах безкоштовні");
    expect(q<HTMLElement>(".st-price__more").hidden).toBe(true);
  });

  it("цін немає (збій packages) — рядок без числа; me вантажиться — рядка немає", () => {
    const { q, setAccount } = setup(guest({ prices: null }));
    const price = q<HTMLElement>(".st-price");
    expect(price.hidden).toBe(false);
    const visible = [...price.querySelectorAll<HTMLElement>(":scope > :not([hidden])")].map(plain);
    expect(visible).toEqual(["правки на чекпоінтах безкоштовні"]);
    expect(plain(price)).not.toMatch(/\d/);
    setAccount({ prices: PRICES });
    expect(plain(q(".st-price__value"))).toBe("10 кредитів");
    document.body.textContent = "";
    expect(setup(fixture("start")).q<HTMLElement>(".st-price").hidden).toBe(true);
  });

  it("ціна — лише з account.prices (не з me)", () => {
    const { q } = setup(signedIn(12, { prices: { video: 7, revision: 3, extraFormat: 2 } }));
    expect(plain(q(".st-price__value"))).toBe("7 кредитів");
  });
});

describe("N3-A · K3 на старті", () => {
  it("ui.startShortage → картка: числа, пакет «Старт», своя сума", () => {
    const { q, el, actions } = setup(fixture("n3-402"));
    const card = q<HTMLElement>(".st-shortage .sh.sh--start");
    expect(card.getAttribute("role")).toBe("alert");
    expect(plain(card.querySelector(".sh-title"))).toBe("Не вистачає кредитів");
    const nums = [...card.querySelectorAll(".sh-num__value")].map((n) => n.textContent);
    expect(nums).toEqual(["10", "4", "6"]);
    expect(plain(card.querySelector(".sh-advice"))).toBe(
      "Різницю закриє пакет «Старт» — 10 кредитів. Після оплати ролик почнеться сам.",
    );
    expect(plain(card.querySelector(".sh-primary"))).toBe("Поповнити на 10→");
    expect(plain(card.querySelector(".sh-secondary"))).toBe("Своя сума · 6");
    // Нестачу показує картка, а не рядок помилки.
    expect(q<HTMLElement>(".st-error").hidden).toBe(true);
    card.querySelector<HTMLButtonElement>(".sh-primary")?.click();
    expect(actions.openTopup).toHaveBeenLastCalledWith({ from: "start", packageId: "starter" });
    card.querySelector<HTMLButtonElement>(".sh-secondary")?.click();
    expect(actions.openTopup).toHaveBeenLastCalledWith({ from: "start", custom: 6 });
    expect(el.querySelectorAll(".sh")).toHaveLength(1);
  });

  it("велика нестача → більший пакет; своя сума не менша за мінімум", () => {
    const { q, setUi } = setup(signedIn(0));
    setUi({ startShortage: { need: 10, have: 0 } });
    expect(plain(q(".sh-primary"))).toBe("Поповнити на 10→");
    setUi({ startShortage: { need: 12, have: 0 } });
    expect(plain(q(".sh-primary"))).toBe("Поповнити на 25→");
    expect(plain(q(".sh-secondary"))).toBe("Своя сума · 12");
    setUi({ startShortage: { need: 10, have: 8 } });
    expect(plain(q(".sh-secondary"))).toBe("Своя сума · 5");
    setUi({ startShortage: null });
    expect(q<HTMLElement>(".st-shortage").hidden).toBe(true);
    expect(q(".st-shortage").childElementCount).toBe(0);
  });
});

describe("N3-A · автостарт, flash, «Мої проєкти»", () => {
  it("n3-auto: «Починаю ролик для …», фото втрачено, кнопка «Починаю» disabled", () => {
    const { q } = setup(fixture("n3-auto"));
    const starting = q<HTMLElement>(".st-starting");
    expect(starting.hidden).toBe(false);
    expect(starting.getAttribute("role")).toBe("status");
    expect(plain(starting)).toBe("Починаю ролик для zerno.example.com· −10 кредитів · залишок 15");
    expect(q<HTMLElement>(".st-lost").hidden).toBe(false);
    expect(q(".st-lost").textContent).toBe(
      "Фото, обрані до входу, не збереглися — додайте їх у чаті через «+ Фото».",
    );
    const btn = q<HTMLButtonElement>(".st-submit");
    expect(btn.disabled).toBe(true);
    expect(q(".st-submit__label").textContent).toBe("Починаю");
    expect(q<HTMLElement>(".st-price").hidden).toBe(true);
    expect(q<HTMLInputElement>('input[name="url"]').value).toBe("zerno.example.com");
  });

  it("автостарт без фото — лише рядок старту; без адреси — без хоста", () => {
    const { q, setAccount } = setup(signedIn(25));
    setAccount({ autostart: { host: null, charged: 10, after: 15, photosLost: false } });
    expect(plain(q(".st-starting__host"))).toBe("Починаю ролик");
    expect(q<HTMLElement>(".st-lost").hidden).toBe(true);
    setAccount({ autostart: null });
    expect(q<HTMLElement>(".st-starting").hidden).toBe(true);
    expect(q(".st-submit__label").textContent).toBe("Почати");
  });

  it("n15-logout: рядок-статус гостю; після входу — схований", () => {
    const { q, setAccount } = setup(fixture("n15-logout"));
    const flash = q<HTMLElement>(".st-flash");
    expect(flash.hidden).toBe(false);
    expect(flash.getAttribute("role")).toBe("status");
    expect(flash.textContent).toBe(LOGOUT_FLASH);
    setAccount({ me: ME, meStatus: "ready" });
    expect(flash.hidden).toBe(true);
  });

  it("«Мої проєкти · N» — лише користувачу з проєктами → cabinet/projects", () => {
    const { q, setAccount, actions } = setup(signedIn(12, { projectCount: 4 }));
    const link = q<HTMLButtonElement>(".st-projects");
    expect(link.hidden).toBe(false);
    expect(plain(link)).toBe("Мої проєкти · 4");
    link.click();
    expect(actions.navigate).toHaveBeenCalledWith({ route: "cabinet", section: "projects" });
    setAccount({ projectCount: null });
    expect(link.hidden).toBe(true);
    setAccount({ projectCount: 0 });
    expect(link.hidden).toBe(true);
    setAccount({ projectCount: 3, me: null, meStatus: "anon" });
    expect(link.hidden).toBe(true);
  });

  it("відкладений старт із localStorage підставляється у форму", () => {
    savePending({ url: null, manualText: "Кав'ярня", hadPhotos: false, at: new Date().toISOString() }, []);
    const { q } = setup(guest());
    expect(q<HTMLDivElement>(".st-manual").hidden).toBe(false);
    expect(q<HTMLTextAreaElement>("textarea").value).toBe("Кав'ярня");
  });

  it.each(["n3-guest", "n3-guest-url", "n3-user", "n3-low", "n3-402", "n3-auto", "n3-empty", "n15-logout"])(
    "фікстура %s монтується",
    (name) => {
      const { el } = setup(fixture(name));
      expect(el.querySelector(".st")).not.toBeNull();
    },
  );

  it("n3-guest-url / n3-empty: адреса з відкладеного старту, помилка порожньої форми", () => {
    expect(setup(fixture("n3-guest-url")).q<HTMLInputElement>("input[name=url]").value).toBe(
      "zerno.example.com",
    );
    document.body.textContent = "";
    const empty = setup(fixture("n3-empty"));
    expect(empty.q<HTMLElement>(".st-error").hidden).toBe(false);
    expect(empty.q(".st-error").textContent).toBe("Вставте адресу сайту або коротко опишіть бізнес.");
    expect(empty.q(".st-login").textContent).toBe("Увійти");
  });
});

// ───────────── Дії ─────────────

/** Бекенд проєкту без мережі. */
function fakeBackend(create: Backend["createProject"] = async () => "p_new") {
  const backend: Backend = {
    start: vi.fn(async () => {}),
    stop: vi.fn(),
    createProject: vi.fn(create),
    sendMessage: async () => {},
    sendCommand: async () => {},
    uploadPhotos: async () => {},
  };
  return backend;
}

/**
 * Дії з data/actions.js (createProject) + start-actions.js; дії інших блоків — моки.
 * `backend` — без мережі; без нього — справжній HTTP-бекенд над стабом `fetch`.
 */
function makeActions(state: UiState, backend?: Backend) {
  const store = createStore<UiState>(state);
  const params = new URLSearchParams("");
  const base = createActions(store, { params, ...(backend ? { backend } : {}) });
  const others = { openAuth: vi.fn(), navigate: vi.fn(), openTopup: vi.fn() };
  let all: Actions;
  const deps: PartDeps = {
    params,
    api: realApi,
    actions: () => all,
    backend: backend ?? fakeBackend(),
    offline: false,
    onRoute: () => {},
  };
  const own = startActions(store, deps);
  all = Object.assign(base, others, own) as unknown as Actions;
  return { store, actions: all, others, own };
}

function startForm(url = "zerno.example.com", files = 0) {
  const form = new FormData();
  form.append("url", url);
  for (let i = 0; i < files; i++) form.append("photos", new File(["x"], `p${i}.jpg`, { type: "image/jpeg" }));
  return form;
}

const storedPending = () => JSON.parse(localStorage.getItem(PENDING_KEY) ?? "null");

describe("data/start-actions.js", () => {
  it("рівно ключі B2", () => {
    const { own } = makeActions(guest(), fakeBackend());
    expect(Object.keys(own).sort()).toEqual(["dismissFlash", "startPending", "submitStart"]);
  });

  it("гість → відкладений старт у localStorage і модалка register, без запиту", async () => {
    const backend = fakeBackend();
    const { actions, others, store } = makeActions(guest({ flash: LOGOUT_FLASH }), backend);
    await actions.submitStart(startForm("zerno.example.com", 2));
    expect(storedPending()).toMatchObject({ url: "zerno.example.com", manualText: null, hadPhotos: true });
    expect(store.getState().account.pending?.url).toBe("zerno.example.com");
    expect(store.getState().account.flash).toBeNull();
    expect(others.openAuth).toHaveBeenCalledWith("register", "start");
    expect(backend.createProject).not.toHaveBeenCalled();
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("me ще вантажиться — чекає на нього (користувач не йде в реєстрацію)", async () => {
    const backend = fakeBackend();
    const { actions, others, store } = makeActions(initialState("start", null), backend);
    const done = actions.submitStart(startForm());
    await flush();
    expect(others.openAuth).not.toHaveBeenCalled();
    expect(backend.createProject).not.toHaveBeenCalled();
    store.setState((s) => ({ account: { ...s.account, me: user(12), meStatus: "ready" } }));
    await done;
    expect(backend.createProject).toHaveBeenCalledOnce();
    expect(others.openAuth).not.toHaveBeenCalled();
  });

  it("баланс < ціни → K3 без запиту; форма відкладена до оплати", async () => {
    const backend = fakeBackend();
    const { actions, store } = makeActions(signedIn(4), backend);
    await actions.submitStart(startForm());
    expect(store.getState().ui.startShortage).toEqual({ need: 10, have: 4 });
    expect(store.getState().route).toBe("start");
    expect(backend.createProject).not.toHaveBeenCalled();
    expect(fetchStub).not.toHaveBeenCalled();
    expect(peekPending()?.url).toBe("zerno.example.com");
  });

  it("вистачає → createProject → маршрут project, нічого не відкладено", async () => {
    const backend = fakeBackend();
    const { actions, store } = makeActions(signedIn(12), backend);
    await actions.submitStart(startForm());
    expect(backend.createProject).toHaveBeenCalledOnce();
    const sent = vi.mocked(backend.createProject).mock.calls[0]?.[0];
    expect(sent?.get("url")).toBe("zerno.example.com");
    expect(store.getState().route).toBe("project");
    expect(store.getState().projectId).toBe("p_new");
    expect(peekPending()).toBeNull();
  });

  it("402 від сервера (стаб fetch) → та сама картка K3; форма відкладена", async () => {
    fetchStub.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            error: "insufficient_credits",
            message: "Не вистачає кредитів: потрібно 10, у вас 4.",
            required: 10,
            available: 4,
          }),
          { status: 402, headers: { "Content-Type": "application/json" } },
        ),
    );
    // Клієнт думає, що 12, сервер знає, що 4.
    const { actions, store } = makeActions(signedIn(12));
    await actions.submitStart(startForm());
    expect(fetchStub).toHaveBeenCalledOnce();
    expect(String(fetchStub.mock.calls[0]?.[0])).toBe("/api/projects");
    expect(store.getState().ui.startShortage).toEqual({ need: 10, have: 4 });
    expect(store.getState().route).toBe("start");
    expect(peekPending()?.url).toBe("zerno.example.com");

    const el = document.createElement("section");
    document.body.append(el);
    mount(el, { store, actions });
    const nums = [...el.querySelectorAll(".st-shortage .sh-num__value")].map((n) => n.textContent);
    expect(nums).toEqual(["10", "4", "6"]);
    expect(el.querySelector<HTMLElement>(".st-error")?.hidden).toBe(true);
  });

  it("startPending: рядок «Починаю ролик…» мін. 1.2 с, потім createProject → project", async () => {
    vi.useFakeTimers();
    const photo = new File(["x"], "a.jpg", { type: "image/jpeg" });
    savePending(
      { url: "zerno.example.com", manualText: null, hadPhotos: true, at: new Date().toISOString() },
      [photo],
    );
    const backend = fakeBackend();
    const { actions, store } = makeActions(signedIn(25, { pending: peekPending() }), backend);
    const done = actions.startPending();
    expect(store.getState().account.autostart).toEqual({
      host: "zerno.example.com",
      charged: 10,
      after: 15,
      photosLost: false,
    });
    expect(store.getState().account.pending).toBeNull();
    expect(localStorage.getItem(PENDING_KEY)).toBeNull();
    await vi.advanceTimersByTimeAsync(AUTOSTART_MIN_MS - 1);
    expect(backend.createProject).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(backend.createProject).toHaveBeenCalledOnce();
    const sent = vi.mocked(backend.createProject).mock.calls[0]?.[0];
    expect(sent?.get("url")).toBe("zerno.example.com");
    expect(((sent?.getAll("photos") ?? []) as File[]).map((f) => f.name)).toEqual(["a.jpg"]);
    expect(store.getState().route).toBe("project");
    expect(store.getState().account.autostart).toBeNull();
    expect(peekPending()).toBeNull();
  });

  it("startPending після перезавантаження: фото втрачено (photosLost)", async () => {
    vi.useFakeTimers();
    localStorage.setItem(
      PENDING_KEY,
      JSON.stringify({
        url: "zerno.example.com",
        manualText: null,
        hadPhotos: true,
        at: new Date().toISOString(),
      }),
    );
    const { actions, store } = makeActions(signedIn(25), fakeBackend());
    const done = actions.startPending();
    expect(store.getState().account.autostart?.photosLost).toBe(true);
    await vi.runAllTimersAsync();
    await done;
  });

  it("startPending з іншого маршруту повертає на старт", async () => {
    vi.useFakeTimers();
    savePending(
      { url: "zerno.example.com", manualText: null, hadPhotos: false, at: new Date().toISOString() },
      [],
    );
    const s = signedIn(25);
    const { actions, others } = makeActions({ ...s, route: "checkout" }, fakeBackend());
    const done = actions.startPending();
    expect(others.navigate).toHaveBeenCalledWith({ route: "start" });
    await vi.runAllTimersAsync();
    await done;
  });

  it("startPending: немає відкладеного — нічого", async () => {
    const backend = fakeBackend();
    const { actions, store } = makeActions(signedIn(25), backend);
    await actions.startPending();
    expect(store.getState().account.autostart).toBeNull();
    expect(backend.createProject).not.toHaveBeenCalled();
  });

  it("startPending: не вистачає — K3 без запиту, відкладений старт повертається", async () => {
    savePending(
      { url: "zerno.example.com", manualText: null, hadPhotos: false, at: new Date().toISOString() },
      [],
    );
    const backend = fakeBackend();
    const { actions, store } = makeActions(signedIn(4), backend);
    await actions.startPending();
    expect(store.getState().ui.startShortage).toEqual({ need: 10, have: 4 });
    expect(store.getState().account.autostart).toBeNull();
    expect(backend.createProject).not.toHaveBeenCalled();
    expect(peekPending()?.url).toBe("zerno.example.com");
  });

  it("startPending: 402 → K3, автостарт знято, відкладений старт повертається", async () => {
    vi.useFakeTimers();
    savePending(
      { url: "zerno.example.com", manualText: null, hadPhotos: false, at: new Date().toISOString() },
      [],
    );
    const { ApiError } = await import("../../public/static/js/data/api.js");
    const backend = fakeBackend(async () => {
      throw new ApiError("Не вистачає", 402, "insufficient_credits", { required: 10, available: 2 });
    });
    const { actions, store } = makeActions(signedIn(25), backend);
    const done = actions.startPending();
    await vi.runAllTimersAsync();
    await done;
    expect(store.getState().ui.startShortage).toEqual({ need: 10, have: 2 });
    expect(store.getState().account.autostart).toBeNull();
    expect(store.getState().route).toBe("start");
    expect(peekPending()?.url).toBe("zerno.example.com");
  });

  it("dismissFlash прибирає рядок-статус", () => {
    const { actions, store } = makeActions(guest({ flash: LOGOUT_FLASH }), fakeBackend());
    actions.dismissFlash();
    expect(store.getState().account.flash).toBeNull();
  });
});
