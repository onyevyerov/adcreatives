// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDevActions } from "../../public/static/dev/dev-actions.js";
import { fixtureStates } from "../../public/static/dev/fixture-states.js";
import type { Actions, UiState } from "../../public/static/js/contracts.js";
import { createStore } from "../../public/static/js/store.js";
import { mount, PLACEHOLDERS, placeholderFor, revisionHint } from "../../public/static/js/views/composer.js";

function fixture(name: string): UiState {
  const s = fixtureStates[name];
  if (!s) throw new Error(`немає фікстури ${name}`);
  return s;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
  document.body.textContent = "";
});

const flush = () => new Promise((r) => setTimeout(r, 0));

function setup(state: UiState, override: Partial<Actions> = {}) {
  const el = document.createElement("div");
  document.body.append(el);
  const store = createStore(state);
  const dev = createDevActions(store);
  const actions = { ...dev, ...override };
  const view = mount(el, { store, actions });
  const off = store.subscribe((s, prev) => view.update(s, prev));
  cleanups.push(() => {
    off();
    view.destroy();
  });
  const input = el.querySelector("textarea") as HTMLTextAreaElement;
  const send = el.querySelector('button[type="submit"]') as HTMLButtonElement;
  const form = el.querySelector("form") as HTMLFormElement;
  const type = (value: string) => {
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const key = (init: KeyboardEventInit) => {
    const ev = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init });
    input.dispatchEvent(ev);
    return ev;
  };
  return { el, store, actions, dev, input, send, form, type, key };
}

const sent = (dev: ReturnType<typeof createDevActions>) =>
  dev.calls.filter((c) => c.name === "sendMessage").map((c) => c.args[0]);

describe("composer · клавіші", () => {
  it("Enter надсилає обрізаний текст і очищає поле", async () => {
    const { dev, input, type, key, store } = setup(fixture("awaitingBrand"));
    type("  Зроби коротше  ");
    expect(store.getState().ui.draft).toBe("  Зроби коротше  ");
    const ev = key({});
    expect(ev.defaultPrevented).toBe(true);
    await flush();
    expect(sent(dev)).toEqual(["Зроби коротше"]);
    expect(input.value).toBe("");
    expect(store.getState().ui.draft).toBe("");
  });

  it("Shift+Enter — новий рядок, не надсилає", async () => {
    const { dev, type, key } = setup(fixture("awaitingBrand"));
    type("рядок");
    const ev = key({ shiftKey: true });
    expect(ev.defaultPrevented).toBe(false);
    await flush();
    expect(sent(dev)).toEqual([]);
  });

  it("⌘+Enter і Ctrl+Enter теж надсилають", async () => {
    const { dev, type, key } = setup(fixture("awaitingBrand"));
    type("раз");
    key({ metaKey: true });
    await flush();
    type("два");
    key({ ctrlKey: true });
    await flush();
    expect(sent(dev)).toEqual(["раз", "два"]);
  });

  it("Enter під час IME-набору ігнорується", async () => {
    const { dev, type, key } = setup(fixture("awaitingBrand"));
    type("こん");
    const ev = key({ isComposing: true });
    expect(ev.defaultPrevented).toBe(false);
    await flush();
    expect(sent(dev)).toEqual([]);
  });

  it("порожнє поле (лише пробіли) не надсилається", async () => {
    const { dev, type, key, form } = setup(fixture("awaitingBrand"));
    type("   \n ");
    key({});
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    expect(sent(dev)).toEqual([]);
  });

  it("sendMessage → false: текст лишається в полі", async () => {
    const sendMessage = vi.fn(async () => false);
    const { input, type, key } = setup(fixture("awaitingBrand"), { sendMessage });
    type("не дійде");
    key({});
    await flush();
    expect(sendMessage).toHaveBeenCalledWith("не дійде");
    expect(input.value).toBe("не дійде");
  });

  it("кнопка надсилання (submit) надсилає", async () => {
    const { dev, type, send } = setup(fixture("awaitingBrand"));
    type("кнопкою");
    send.click();
    await flush();
    expect(sent(dev)).toEqual(["кнопкою"]);
  });
});

describe("composer · стани", () => {
  it.each([
    ["awaitingBrand", PLACEHOLDERS.awaiting],
    ["awaitingScript", PLACEHOLDERS.awaiting],
    ["awaitingStoryboard", PLACEHOLDERS.awaiting],
    ["crawling", PLACEHOLDERS.busy],
    ["directing", PLACEHOLDERS.busy],
    ["revising", PLACEHOLDERS.busy],
    ["failed", PLACEHOLDERS.busy],
    ["delivered", PLACEHOLDERS.delivered],
  ])("%s → плейсхолдер «%s»", (name, ph) => {
    const { input } = setup(fixture(name));
    expect(input.placeholder).toBe(ph);
  });

  it("плейсхолдери з C5", () => {
    expect(PLACEHOLDERS).toEqual({
      editing: "Опишіть, що змінити",
      awaiting: "Відповідь, питання або правки",
      delivered: "Напишіть правку — зроблю нову ревізію",
      busy: "Можна писати — врахую на наступному погодженні",
    });
    const s = fixture("delivered");
    expect(placeholderFor({ ...s, ui: { ...s.ui, editing: true } })).toBe(PLACEHOLDERS.editing);
  });

  it("плейсхолдер міняється зі статусом", () => {
    const { input, store } = setup(fixture("awaitingBrand"));
    store.setState({ status: "scripting" });
    expect(input.placeholder).toBe(PLACEHOLDERS.busy);
    store.setState({ status: "delivered" });
    expect(input.placeholder).toBe(PLACEHOLDERS.delivered);
  });

  it("кнопка надсилання неактивна при порожньому полі й під час ui.sending", () => {
    const { send, type, store } = setup(fixture("awaitingBrand"));
    expect(send.disabled).toBe(true);
    type("  ");
    expect(send.disabled).toBe(true);
    type("текст");
    expect(send.disabled).toBe(false);
    store.setState((s) => ({ ui: { ...s.ui, sending: true } }));
    expect(send.disabled).toBe(true);
    store.setState((s) => ({ ui: { ...s.ui, sending: false } }));
    expect(send.disabled).toBe(false);
  });

  it("ui.sending блокує надсилання з клавіатури", async () => {
    const { dev, type, key, store } = setup(fixture("awaitingBrand"));
    type("текст");
    store.setState((s) => ({ ui: { ...s.ui, sending: true } }));
    key({});
    await flush();
    expect(sent(dev)).toEqual([]);
  });

  it("startEdit: рамка --ink (клас), плейсхолдер «Опишіть, що змінити» і фокус", () => {
    const { input, form, dev } = setup(fixture("awaitingBrand"));
    expect(form.classList.contains("ch-composer--editing")).toBe(false);
    expect(document.activeElement).not.toBe(input);
    dev.startEdit();
    expect(form.classList.contains("ch-composer--editing")).toBe(true);
    expect(input.placeholder).toBe(PLACEHOLDERS.editing);
    expect(document.activeElement).toBe(input);
  });

  it("помилка дії (ui.notice) — рядок role=alert", () => {
    const { el, store } = setup(fixture("awaitingBrand"));
    const notice = el.querySelector(".ch-notice") as HTMLElement;
    expect(notice.hidden).toBe(true);
    store.setState((s) => ({ ui: { ...s.ui, notice: "Помилка 500" } }));
    expect(notice.hidden).toBe(false);
    expect(notice.textContent).toBe("Помилка 500");
  });
});

describe("composer · фото", () => {
  it("«+ Фото» відкриває прихований input[type=file] з потрібними типами", () => {
    const { el } = setup(fixture("awaitingBrand"));
    const file = el.querySelector('input[type="file"]') as HTMLInputElement;
    expect(file.hidden).toBe(true);
    expect(file.multiple).toBe(true);
    expect(file.accept).toBe("image/*,.heic,.heif");
    const click = vi.spyOn(file, "click").mockImplementation(() => {});
    const photo = [...el.querySelectorAll("button")].find((b) => b.textContent === "+ Фото");
    photo?.click();
    expect(click).toHaveBeenCalledOnce();
  });

  it("вибрані файли → uploadPhotos", () => {
    const uploadPhotos = vi.fn(async (_files: FileList | File[]) => {});
    const { el } = setup(fixture("awaitingBrand"), { uploadPhotos });
    const file = el.querySelector('input[type="file"]') as HTMLInputElement;
    const photos = [new File(["a"], "a.jpg", { type: "image/jpeg" }), new File(["b"], "b.heic")];
    Object.defineProperty(file, "files", { configurable: true, get: () => photos });
    file.dispatchEvent(new Event("change"));
    expect(uploadPhotos).toHaveBeenCalledOnce();
    expect(Array.from(uploadPhotos.mock.calls[0]?.[0] ?? [], (f) => f.name)).toEqual(["a.jpg", "b.heic"]);
  });
});

describe("composer · чернетка", () => {
  it("введення → setDraft; зовнішня зміна ui.draft → у поле, textarea та сама", () => {
    const { input, store, el, type } = setup(fixture("awaitingBrand"));
    type("моє");
    expect(store.getState().ui.draft).toBe("моє");
    store.setState((s) => ({ ui: { ...s.ui, draft: "з фікстури" } }));
    expect(el.querySelector("textarea")).toBe(input);
    expect(input.value).toBe("з фікстури");
  });

  it("початкова чернетка з ui.draft", () => {
    const s = fixture("awaitingBrand");
    const { input, send } = setup({ ...s, ui: { ...s.ui, draft: "почато" } });
    expect(input.value).toBe("почато");
    expect(send.disabled).toBe(false);
  });

  it("оновлення стану не перезаписує поле, якщо draft не змінився", () => {
    const { input, store } = setup(fixture("awaitingBrand"));
    input.value = "локально"; // без input-події (наприклад, ще не доставлено)
    store.setState({ status: "scripting" });
    expect(input.value).toBe("локально");
  });

  it("зовнішня зміна draft зберігає позицію курсора у фокусі", () => {
    const { input, store, type } = setup(fixture("awaitingBrand"));
    type("abcdef");
    input.focus();
    input.setSelectionRange(2, 2);
    store.setState((s) => ({ ui: { ...s.ui, draft: "abcdefgh" } }));
    expect(input.value).toBe("abcdefgh");
    expect(input.selectionStart).toBe(2);
  });
});

// ───────────── B5 · ціна правки після видачі (N5-A) ─────────────

const NB = " ";

describe("composer · ціна правки (N5-A)", () => {
  function priced(state: UiState) {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("мережа в тесті"))),
    );
    return setup(state);
  }
  const price = (el: HTMLElement) => el.querySelector(".cmp-price") as HTMLElement;
  const shown = (el: HTMLElement) => !(price(el).parentElement as HTMLElement).hidden;

  it("n5-done: «↵ надіслати · правка — 3 кредити»", () => {
    const { el } = priced(fixture("n5-done"));
    expect(shown(el)).toBe(true);
    expect(el.querySelector(".cmp-hint")?.textContent).toBe(`↵ надіслати · правка — 3${NB}кредити`);
    expect(price(el).classList.contains("cmp-price--short")).toBe(false);
  });

  it("n5-done-short: «правка — 3 кредити, у вас 2» кольором --ink, надсилання не блокується", async () => {
    const { el, dev, type, key, send } = priced(fixture("n5-done-short"));
    expect(price(el).textContent).toBe(`правка — 3${NB}кредити, у вас 2`);
    expect(price(el).classList.contains("cmp-price--short")).toBe(true);
    type("Зроби заголовок коротшим");
    expect(send.disabled).toBe(false);
    key({});
    await flush();
    expect(sent(dev)).toEqual(["Зроби заголовок коротшим"]);
  });

  it("баланс 0 — так само надсилається", async () => {
    const base = fixture("n5-done-short");
    const me = base.account.me;
    if (!me) throw new Error("немає me");
    const { dev, type, form } = priced({ ...base, account: { ...base.account, me: { ...me, balance: 0 } } });
    type("Інша музика");
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();
    expect(sent(dev)).toEqual(["Інша музика"]);
  });

  it("n5-done-typing: чернетка в полі, кнопка активна, підказка лишається", () => {
    const { el, input, send } = priced(fixture("n5-done-typing"));
    expect(input.value).toBe("Зроби заголовок коротшим");
    expect(send.disabled).toBe(false);
    expect(shown(el)).toBe(true);
  });

  it("до видачі й без цін підказки ціни немає; поява — за статусом", () => {
    const { el, store } = priced(fixture("n5-cp1"));
    expect(shown(el)).toBe(false);
    expect(price(el).textContent).toBe("");
    store.setState({ status: "delivered" });
    expect(shown(el)).toBe(true);
    store.setState((s) => ({ account: { ...s.account, prices: null } }));
    expect(shown(el)).toBe(false);
  });

  it("revisionHint", () => {
    const base = fixture("n5-done");
    expect(revisionHint(base)).toEqual({ text: `правка — 3${NB}кредити`, short: false });
    expect(revisionHint({ ...base, status: "revising" })).toBeNull();
    expect(revisionHint({ ...base, account: { ...base.account, prices: null } })).toBeNull();
    // Баланс невідомий — без «у вас».
    expect(revisionHint({ ...base, account: { ...base.account, me: null } })).toEqual({
      text: `правка — 3${NB}кредити`,
      short: false,
    });
  });
});
