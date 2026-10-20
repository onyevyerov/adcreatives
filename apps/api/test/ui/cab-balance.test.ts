// @vitest-environment happy-dom
/**
 * B7 · views/cab-balance.js (N8-B, N9-A): баланс і факти, нуль, банер повернення, тайли пакетів,
 * «закриє різницю», своя сума (три помилки, живий перерахунок), надсилання, незавершені поповнення,
 * вітальний бонус. Фікстури — dev/fixtures/cabinet.js.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fixtureStates } from "../../public/static/dev/fixture-states.js";
import { meOf, OLENA, PENDING_TOPUP } from "../../public/static/dev/fixtures/_base.js";
import type { Actions, UiState } from "../../public/static/js/contracts.js";
import { savePending } from "../../public/static/js/lib/pending.js";
import { createStore } from "../../public/static/js/store.js";
import { customErrorText, enoughLine, mount, returnText } from "../../public/static/js/views/cab-balance.js";

const NBSP = " ";
const plain = (node: Element | null) => (node?.textContent ?? "").replaceAll(NBSP, " ").trim();

function fixture(name: string): UiState {
  const s = fixtureStates[name];
  if (!s) throw new Error(`немає фікстури ${name}`);
  return s;
}

function viewActions() {
  return {
    selectPackage: vi.fn(),
    setCustom: vi.fn(),
    submitTopup: vi.fn(async () => {}),
    continueTopup: vi.fn(),
  };
}

function setup(state: UiState = fixture("cab-balance"), actions = viewActions()) {
  const el = document.createElement("div");
  document.body.append(el);
  const store = createStore(state);
  const view = mount(el, { store, actions: actions as unknown as Actions });
  let prev = store.getState();
  store.subscribe((next) => {
    view.update(next, prev);
    prev = next;
  });
  const q = <T extends Element = HTMLElement>(sel: string) => {
    const node = el.querySelector<T>(sel);
    if (!node) throw new Error(`немає ${sel}`);
    return node;
  };
  const tiles = () => [...el.querySelectorAll<HTMLButtonElement>("button.cab-tu__tile")];
  const topup = (patch: Partial<UiState["cabinet"]["topup"]>) =>
    store.setState((s) => ({ cabinet: { ...s.cabinet, topup: { ...s.cabinet.topup, ...patch } } }));
  return { el, store, view, q, tiles, topup, actions };
}

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
  vi.unstubAllGlobals();
});

describe("views/cab-balance.js · баланс", () => {
  it("cab-balance: заголовок, число, факти, ціни; без банера і нуля", () => {
    const { q, el } = setup();
    expect(q("h1").textContent).toBe("Баланс і поповнення");
    expect(plain(q(".cab-bal__num"))).toBe("12");
    expect(q(".cab-bal__word").textContent).toBe("кредитів");
    expect(plain(q(".cab-bal__facts"))).toContain("вистачить на 1 ролик або 4 правки");
    expect(plain(q(".cab-bal__facts"))).toContain("ролик 10 · правка 3 · додатковий формат +2");
    expect(q(".cab-bal__return").hidden).toBe(true);
    expect(q(".cab-bal__zero").hidden).toBe(true);
    expect(q(".cab-bal__pending").hidden).toBe(true);
    expect(el.querySelectorAll(".cab-tu__rec:not([hidden])").length).toBe(0);
  });

  it("cab-zero: «не вистачить…» і заклик", () => {
    const { q } = setup(fixture("cab-zero"));
    expect(plain(q(".cab-bal__num"))).toBe("0");
    expect(plain(q(".cab-bal__facts"))).toContain("не вистачить ні на ролик, ні на правку");
    expect(q(".cab-bal__zero").hidden).toBe(false);
    expect(q(".cab-bal__zero").textContent).toBe("Поповніть баланс, щоб зробити перший ролик.");
  });

  it("1 250 — тисячі через U+00A0, слово за creditWord", () => {
    const { q } = setup(fixture("sheet-n9-1250"));
    expect(q(".cab-bal__num").textContent).toBe(`1${NBSP}250`);
    expect(q(".cab-bal__word").textContent).toBe("кредитів");
    const one = setup({
      ...fixture("cab-balance"),
      account: { ...fixture("cab-balance").account, me: meOf(OLENA, 1) },
    });
    expect(one.q(".cab-bal__word").textContent).toBe("кредит");
  });

  it("вітальний бонус — із запису bonus в історії", () => {
    const { q } = setup(fixture("sheet-n9-bonus"));
    const bonus = [...q(".cab-bal__facts").children].at(-1) as HTMLElement;
    expect(bonus.hidden).toBe(false);
    expect(plain(bonus)).toBe("+5 · вітальний бонус, 14.10.2026");
    const none = setup();
    expect(([...none.q(".cab-bal__facts").children].at(-1) as HTMLElement).hidden).toBe(true);
  });

  it("enoughLine: три варіанти", () => {
    const prices = { video: 10, revision: 3, extraFormat: 2 };
    expect(enoughLine(12, prices).replaceAll(NBSP, " ")).toBe("вистачить на 1 ролик або 4 правки");
    expect(enoughLine(4, prices).replaceAll(NBSP, " ")).toBe("вистачить на 1 правку, на ролик — ні");
    expect(enoughLine(1, prices)).toBe("не вистачить ні на ролик, ні на правку");
  });
});

describe("банер повернення", () => {
  it("зі старту: хост відкладеного старту і «закриє різницю» на пакеті", () => {
    const { q, tiles } = setup(fixture("n6-start-return"));
    expect(q(".cab-bal__return").hidden).toBe(false);
    expect(q(".cab-bal__return").textContent).toBe(
      "Після оплати поверну на старт — ролик для zerno.example.com почнеться сам.",
    );
    const [starter, standard] = tiles();
    expect(starter?.getAttribute("aria-checked")).toBe("true");
    expect(starter?.querySelector<HTMLElement>(".cab-tu__rec")?.hidden).toBe(false);
    expect(starter?.querySelector(".cab-tu__rec")?.textContent).toBe("закриє різницю");
    expect(standard?.querySelector<HTMLElement>(".cab-tu__rec")?.hidden).toBe(true);
  });

  it("зі старту: хост — з localStorage, якщо в стані немає", () => {
    const s = fixture("n6-start-return");
    savePending(
      {
        url: "https://kava.example.com/menu",
        manualText: null,
        hadPhotos: false,
        at: new Date().toISOString(),
      },
      [],
    );
    const state = { ...s, account: { ...s.account, pending: null } };
    expect(returnText(state)).toBe(
      "Після оплати поверну на старт — ролик для kava.example.com почнеться сам.",
    );
    localStorage.clear();
    expect(returnText(state)).toBe("Після оплати поверну на старт — ролик почнеться сам.");
  });

  it("з проєкту з retry — «натисніть «Повторити» в чаті»; без retry — без банера", () => {
    const { q } = setup(fixture("n6-cab-return"));
    expect(q(".cab-bal__return").textContent).toBe(
      "Після оплати поверну до zerno.example.com — натисніть «Повторити» в чаті.",
    );
    expect(setup(fixture("cab-from-ws")).q(".cab-bal__return").hidden).toBe(true);
  });
});

describe("тайли пакетів", () => {
  it("радіогрупа: 3 пакети + своя сума; середній обрано за замовчуванням", () => {
    const { q, tiles } = setup();
    expect(q(".cab-tu__tiles").getAttribute("role")).toBe("radiogroup");
    const list = tiles();
    expect(list.map((b) => b.querySelector(".cab-tu__label")?.textContent)).toEqual([
      "Старт",
      "Кілька роликів",
      "Серія",
    ]);
    expect(list.map((b) => b.getAttribute("aria-checked"))).toEqual(["false", "true", "false"]);
    expect(list.map((b) => b.tabIndex)).toEqual([-1, 0, -1]);
    expect(plain(list[1]?.querySelector(".cab-tu__foot > span") ?? null)).toBe("2 ролики або 8 правок");
    expect(q(".cab-tu__tile--custom").getAttribute("role")).toBe("radio");
    expect(q(".cab-tu__tile--custom").getAttribute("aria-checked")).toBe("false");
    expect(plain(q(".cab-tu__submit"))).toBe("Поповнити на 25 кредитів→");
    expect(q(".cab-tu__note").textContent).toBe("тестова оплата — гроші не списуються");
  });

  it("клік по тайлу → selectPackage; ←/→ переводять вибір", () => {
    const { tiles, actions, q } = setup();
    tiles()[2]?.click();
    expect(actions.selectPackage).toHaveBeenCalledWith("pro");
    tiles()[1]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    expect(actions.selectPackage).toHaveBeenLastCalledWith("starter");
    tiles()[2]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(actions.selectPackage).toHaveBeenLastCalledWith("custom");
    expect(document.activeElement).toBe(q("input.cab-tu__input"));
  });

  it("один пакет, обраного немає — нічого не обрано, «Поповнити» без суми", () => {
    const { tiles, q } = setup(fixture("sheet-n9-one-package"));
    expect(tiles().map((b) => b.getAttribute("aria-checked"))).toEqual(["false"]);
    expect(plain(q(".cab-tu__submit"))).toBe("Поповнити→");
  });

  it("п’ять пакетів з довгою назвою; тайли перебудовуються при зміні списку", () => {
    const { tiles, q, store } = setup(fixture("sheet-n9-five-packages"));
    expect(tiles().length).toBe(5);
    expect(tiles()[3]?.getAttribute("aria-checked")).toBe("true");
    expect(tiles()[3]?.querySelector(".cab-tu__label")?.textContent).toBe("Сезонна кампанія для мережі");
    expect(plain(q(".cab-tu__submit"))).toBe("Поповнити на 150 кредитів→");
    store.setState((s) => ({ account: { ...s.account, me: meOf(OLENA, 12) } }));
    expect(tiles().length).toBe(3);
    // «Своя сума» лишається останньою.
    expect(q(".cab-tu__tiles").lastElementChild?.classList.contains("cab-tu__tile--custom")).toBe(true);
  });
});

describe("своя сума", () => {
  it.each([
    ["sheet-n9-custom-empty", "Вкажіть кількість кредитів — від 5 до 500."],
    ["sheet-n9-custom-fraction", "Лише ціле число кредитів — від 5 до 500."],
    ["sheet-n9-custom-range", "Від 5 до 500 кредитів."],
  ])("%s → «%s»", (name, msg) => {
    const { q } = setup(fixture(name));
    const err = q(".cab-tu__error");
    expect(err.getAttribute("role")).toBe("alert");
    expect(err.hidden).toBe(false);
    expect(err.textContent).toBe(msg);
    expect(q(".cab-tu__tile--custom").classList.contains("is-error")).toBe(true);
    expect(q("input.cab-tu__input").getAttribute("aria-invalid")).toBe("true");
    expect(q(".cab-tu__tile--custom .cab-tu__foot").textContent).toBe("від 5 до 500, лише ціле");
    expect(plain(q(".cab-tu__submit"))).toBe("Поповнити→");
  });

  it("тексти помилок", () => {
    const c = { min: 5, max: 500 };
    expect(customErrorText("empty", c)).toBe("Вкажіть кількість кредитів — від 5 до 500.");
    expect(customErrorText("integer", c)).toBe("Лише ціле число кредитів — від 5 до 500.");
    expect(customErrorText("range", c)).toBe("Від 5 до 500 кредитів.");
  });

  it("живий перерахунок і сума на кнопці", () => {
    const { q } = setup(fixture("sheet-n9-custom-ok"));
    expect(q(".cab-tu__tile--custom").getAttribute("aria-checked")).toBe("true");
    expect(q<HTMLInputElement>("input.cab-tu__input").value).toBe("40");
    expect(plain(q(".cab-tu__tile--custom .cab-tu__foot"))).toBe("= 4 ролики або 13 правок");
    expect(q(".cab-tu__tile--custom .cab-tu__foot").classList.contains("is-ok")).toBe(true);
    expect(q(".cab-tu__error").hidden).toBe(true);
    expect(plain(q(".cab-tu__submit"))).toBe("Поповнити на 40 кредитів→");
  });

  it("підказка без вводу; поле не перестворюється і не скидає введене", () => {
    const { q, topup, actions } = setup();
    const input = q<HTMLInputElement>("input.cab-tu__input");
    expect(input.placeholder).toBe("5–500");
    expect(q(".cab-tu__tile--custom .cab-tu__foot").textContent).toBe("від 5 до 500 кредитів");
    input.focus();
    expect(actions.selectPackage).toHaveBeenCalledWith("custom");
    input.value = "4";
    input.dispatchEvent(new Event("input"));
    expect(actions.setCustom).toHaveBeenCalledWith("4");
    topup({ mode: "custom", custom: "4" });
    expect(q("input.cab-tu__input")).toBe(input);
    expect(document.activeElement).toBe(input);
    // Помилку видно лише після спроби надіслати.
    expect(q(".cab-tu__error").hidden).toBe(true);
    topup({ error: true });
    expect(q(".cab-tu__error").textContent).toBe("Від 5 до 500 кредитів.");
  });

  it("клік по тайлу «Своя сума» обирає його і ставить фокус у поле", () => {
    const { q, actions } = setup();
    q(".cab-tu__tile--custom").click();
    expect(actions.selectPackage).toHaveBeenCalledWith("custom");
    expect(document.activeElement).toBe(q("input.cab-tu__input"));
  });
});

describe("надсилання і незавершені", () => {
  it("submit форми → submitTopup; busy — disabled зі спінером", () => {
    const { q, actions, topup } = setup();
    const submit = q<HTMLButtonElement>(".cab-tu__submit");
    expect(submit.disabled).toBe(false);
    expect(q(".cab-tu__spinner").hidden).toBe(true);
    q("form").dispatchEvent(new Event("submit", { cancelable: true }));
    expect(actions.submitTopup).toHaveBeenCalledTimes(1);
    topup({ busy: true });
    expect(submit.disabled).toBe(true);
    expect(submit.getAttribute("aria-busy")).toBe("true");
    expect(q(".cab-tu__spinner").hidden).toBe(false);
  });

  it("sheet-n9-busy", () => {
    const { q } = setup(fixture("sheet-n9-busy"));
    expect(q<HTMLButtonElement>(".cab-tu__submit").disabled).toBe(true);
    expect(plain(q(".cab-tu__submit"))).toBe("Поповнити на 25 кредитів→");
  });

  it("незавершене поповнення: назва пакета, мета, «Продовжити оплату» → continueTopup", () => {
    const { q, actions, store, el } = setup(fixture("sheet-n9-pending"));
    expect(q(".cab-bal__pending").hidden).toBe(false);
    expect(plain(q(".cab-bal__pending-title"))).toBe("Незавершене поповнення · Кілька роликів");
    // Час — локальний; у фікстурі 19.10 11:20 за Києвом.
    expect(plain(q(".cab-bal__pending-meta"))).toMatch(/^25 кредитів · створено 19\.10 \d\d:20 · t_9q4m$/);
    q<HTMLButtonElement>(".cab-bal__continue").click();
    expect(actions.continueTopup).toHaveBeenCalledWith("t_9q4m");
    store.setState((s) => ({
      cabinet: {
        ...s.cabinet,
        pendingTopups: [{ ...PENDING_TOPUP, id: "t_c1", packageId: "custom", credits: 22 }],
      },
    }));
    expect(plain(q(".cab-bal__pending-title"))).toBe("Незавершене поповнення · своя сума");
    store.setState((s) => ({ cabinet: { ...s.cabinet, pendingTopups: [] } }));
    expect(q(".cab-bal__pending").hidden).toBe(true);
    expect(el.querySelectorAll(".cab-bal__pending-row").length).toBe(0);
  });

  it("destroy прибирає розділ", () => {
    const { view, el } = setup();
    view.destroy();
    expect(el.childNodes.length).toBe(0);
  });
});
