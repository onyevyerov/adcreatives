// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDevActions } from "../../public/static/dev/dev-actions.js";
import { fixtureStates } from "../../public/static/dev/fixture-states.js";
import type { FeedItem, UiState } from "../../public/static/js/contracts.js";
import { createStore } from "../../public/static/js/store.js";
import { cardState, clock, liveOwners, mount, richText } from "../../public/static/js/views/chat.js";

type Item = Extract<FeedItem, { kind: string }>;

function fixture(name: string): UiState {
  const s = fixtureStates[name];
  if (!s) throw new Error(`немає фікстури ${name}`);
  return s;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
  document.body.textContent = "";
});

function setup(state: UiState) {
  const el = document.createElement("aside");
  el.id = "chat";
  document.body.append(el);
  const store = createStore(state);
  const actions = createDevActions(store);
  const view = mount(el, { store, actions });
  const off = store.subscribe((s, prev) => view.update(s, prev));
  cleanups.push(() => {
    off();
    view.destroy();
  });
  const $ = <T extends Element = HTMLElement>(sel: string) => el.querySelector(sel) as T | null;
  const $$ = (sel: string) => [...el.querySelectorAll<HTMLElement>(sel)];
  const visible = (sel: string) => $$(sel).filter((n) => !n.hidden && !n.closest("[hidden]"));
  return { el, store, actions, view, $, $$, visible };
}

const rowsOf = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>(".ch-list > [data-id]")];

describe("chat · заголовок і з'єднання", () => {
  it("«Діалог» + індикатор за state.conn", () => {
    const { $, store } = setup(fixture("awaitingBrand"));
    expect($(".ch-title")?.textContent).toBe("Діалог");
    expect($(".ch-title")?.classList.contains("display-s")).toBe(true);
    const conn = $(".ch-conn") as HTMLElement;
    expect(conn.hidden).toBe(false);
    expect(conn.textContent).toBe("на зв'язку");
    expect(conn.querySelector(".dot--ok")).not.toBeNull();

    store.setState({ conn: "reconnecting" });
    expect(conn.textContent).toBe("перепідключаюсь…");
    expect(conn.querySelector(".dot--accent.dot--pulse")).not.toBeNull();
    store.setState({ conn: "lost" });
    expect(conn.textContent).toBe("з'єднання втрачено");
    expect(conn.querySelector(".dot--danger")).not.toBeNull();
    store.setState({ conn: "idle" });
    expect(conn.hidden).toBe(true);
  });
});

describe("chat · елементи стрічки (C4, X1)", () => {
  it.each(Object.keys(fixtureStates).filter((n) => n !== "start"))(
    "%s: кожен FeedItem має рядок у порядку стрічки",
    (name) => {
      const state = fixture(name);
      const { el } = setup(state);
      const rows = rowsOf(el);
      expect(rows.map((r) => r.dataset.id)).toEqual(state.feed.map((i: Item) => i.id));
      expect(rows.map((r) => r.dataset.kind)).toEqual(state.feed.map((i: Item) => i.kind));
    },
  );

  it("повідомлення: асистент з міткою і часом, клієнт — бульбашка, **жирний** → <strong>", () => {
    const { $$ } = setup(fixture("awaitingScript"));
    const assistant = $$('[data-role="assistant"]');
    expect(assistant.length).toBeGreaterThan(0);
    const first = assistant[0] as HTMLElement;
    expect(first.querySelector(".ch-msg__meta")?.textContent).toMatch(/^AdCreative · \d\d:\d\d$/);
    const strong = [...first.querySelectorAll(".ch-msg__text strong")].map((n) => n.textContent);
    expect(strong).toContain("Зерно");
    expect(first.querySelector(".ch-msg__text")?.textContent).not.toContain("**");
    expect(first.querySelectorAll(".ch-msg__text br").length).toBeGreaterThan(0);

    const user = $$('[data-role="user"]');
    expect(user[0]?.querySelector(".ch-bubble")?.textContent).toBe("Формати: 9:16, 1:1");
    expect(user[0]?.querySelector(".ch-msg__meta")).toBeNull();
  });

  it("system — мітка «Система»; текст клієнта не розбирається", () => {
    const base = fixture("awaitingBrand");
    const feed: FeedItem[] = [
      ...base.feed,
      {
        kind: "message",
        id: "s-1",
        at: "2026-10-07T10:42:00.000Z",
        role: "system",
        text: "Увага",
        buttons: [],
      },
      {
        kind: "message",
        id: "u-1",
        at: "2026-10-07T10:43:00.000Z",
        role: "user",
        text: "**так** <b>x</b>",
        buttons: [],
      },
    ];
    const { $ } = setup({ ...base, feed });
    expect($('[data-id="s-1"] .ch-msg__meta')?.textContent).toMatch(/^Система · /);
    const bubble = $('[data-id="u-1"] .ch-bubble') as HTMLElement;
    expect(bubble.textContent).toBe("**так** <b>x</b>");
    expect(bubble.querySelector("strong, b")).toBeNull();
  });

  it("прогрес: триває — спінер, завершено — ✓", () => {
    const { $$ } = setup(fixture("directing"));
    const progress = $$('[data-kind="progress"]');
    const running = progress.filter((p) => p.dataset.state === "running");
    expect(running).toHaveLength(1);
    expect(running[0]?.querySelector(".spinner")).not.toBeNull();
    expect(running[0]?.textContent).toContain("Генерую сцени… 2/3");
    const done = progress.filter((p) => p.dataset.state === "done");
    expect(done.length).toBeGreaterThan(0);
    expect(done[0]?.querySelector(".ch-progress__mark")?.textContent).toBe("✓");
    expect(done[0]?.querySelector(".spinner")).toBeNull();
  });

  it("прогрес: лічильник done/total лише якщо мітка його не містить", () => {
    const base = fixture("directing");
    const feed: FeedItem[] = [
      {
        kind: "progress",
        id: "p-1",
        at: base.feed[0]?.at ?? "",
        stage: "crawl",
        label: "Сканую",
        done: 3,
        total: 9,
        running: true,
      },
      {
        kind: "progress",
        id: "p-2",
        at: base.feed[0]?.at ?? "",
        stage: "crawl",
        label: "Сканую 3/9",
        done: 3,
        total: 9,
        running: false,
      },
    ];
    const { $ } = setup({ ...base, feed });
    const c1 = $('[data-id="p-1"] .ch-progress__count') as HTMLElement;
    expect(c1.textContent).toBe("3/9");
    expect(c1.hidden).toBe(false);
    expect(($('[data-id="p-2"] .ch-progress__count') as HTMLElement).hidden).toBe(true);
  });

  it("помилка (X1): етап, текст, «Спробувати ще раз» → retry", async () => {
    const { $, actions } = setup(fixture("failed"));
    const err = $('[data-kind="error"]') as HTMLElement;
    expect(err.querySelector(".ch-error__head")?.textContent).toBe("Помилка · codegen");
    expect(err.querySelector(".ch-error__text")?.textContent).toBe(
      "Щось пішло не так на етапі «codegen»: модель не відповіла вчасно.",
    );
    const btn = err.querySelector<HTMLButtonElement>('[data-action="retry"]');
    expect(btn?.hidden).toBe(false);
    expect(btn?.textContent).toBe("Спробувати ще раз");
    btn?.click();
    await Promise.resolve();
    expect(actions.calls.map((c) => c.name)).toContain("retry");
  });

  it("failed: retry показує лише картка помилки, не дубль у повідомленні", () => {
    const { visible } = setup(fixture("failed"));
    const retry = visible('[data-action="retry"]');
    expect(retry).toHaveLength(1);
    expect(retry[0]?.closest("[data-kind]")?.getAttribute("data-kind")).toBe("error");
  });

  it("неretryable помилка без кнопки; retry переходить до повідомлення після неї", () => {
    const base = fixture("failed");
    const feed = base.feed.map((i: Item) => (i.kind === "error" ? { ...i, retryable: false } : i));
    const { visible } = setup({ ...base, feed });
    const retry = visible('[data-action="retry"]');
    expect(retry).toHaveLength(1);
    expect(retry[0]?.closest("[data-kind]")?.getAttribute("data-kind")).toBe("message");
  });
});

describe("chat · картки чекпоінтів", () => {
  it("awaitingBrand: одна активна картка з діями; дубль кнопок у повідомленні схований", () => {
    const { $$, visible } = setup(fixture("awaitingBrand"));
    const cards = $$('[data-kind="checkpoint"]');
    expect(cards).toHaveLength(1);
    const card = cards[0] as HTMLElement;
    expect(card.dataset.state).toBe("active");
    expect(card.classList.contains("ch-card--active")).toBe(true);
    expect(card.querySelector(".ch-card__title")?.textContent).toBe("Чекпоінт 1 — бренд");
    expect(card.querySelector(".ch-card__rev")?.textContent).toBe("· рев. 1");
    expect(card.querySelector(".diamond--open")).not.toBeNull();
    expect(visible('[data-action="approve"]')).toHaveLength(1);
    expect(visible('[data-action="edit"]')).toHaveLength(1);
    expect(visible('[data-action="approve"]')[0]?.closest(".ch-card")).toBe(card);
  });

  it("awaitingScript: бренд — «✓ Затверджено», тексти — активна", () => {
    const { $ } = setup(fixture("awaitingScript"));
    const brand = $('[data-kind="checkpoint"][data-state="approved"]') as HTMLElement;
    expect(brand.querySelector(".ch-card__title")?.textContent).toBe("Чекпоінт 1 — бренд");
    expect(brand.querySelector(".ch-card__status")?.textContent).toBe("✓ Затверджено");
    expect(brand.querySelector('[data-action="approve"]')?.closest("[hidden]")).not.toBeNull();
    expect(brand.querySelector(".diamond--done")).not.toBeNull();
    const script = $('[data-kind="checkpoint"][data-state="active"]') as HTMLElement;
    expect(script.querySelector(".ch-card__title")?.textContent).toBe("Чекпоінт 2 — тексти");
  });

  it("нова ревізія: стара картка — «Замінено новою ревізією»", () => {
    const { $$ } = setup(fixture("deliveredRev2"));
    const board = $$('[data-kind="checkpoint"]').filter((c) =>
      c.querySelector(".ch-card__title")?.textContent?.includes("розкадровка"),
    );
    expect(board.map((c) => c.dataset.state)).toEqual(["superseded", "approved"]);
    expect(board[0]?.querySelector(".ch-card__status")?.textContent).toBe("Замінено новою ревізією");
    expect(board[0]?.querySelector(".diamond--stale")).not.toBeNull();
  });

  it("cardState: активна лише при збігу ревізії, state open і статусу awaiting", () => {
    const s = fixture("awaitingBrand");
    const item = s.feed.find((i: Item) => i.kind === "checkpoint");
    if (item?.kind !== "checkpoint") throw new Error("немає картки чекпоінта");
    expect(cardState(item, s)).toBe("active");
    expect(cardState(item, { ...s, status: "scripting" })).toBe("idle");
    const entry = s.checkpoints.brand;
    if (!entry) throw new Error("немає brand");
    const cp = (patch: object) => ({ ...s.checkpoints, brand: { ...entry, ...patch } });
    expect(cardState(item, { ...s, checkpoints: cp({ state: "approved" }) })).toBe("approved");
    expect(cardState(item, { ...s, checkpoints: cp({ state: "superseded" }) })).toBe("superseded");
    expect(cardState(item, { ...s, checkpoints: cp({ rev: 2 }) })).toBe("superseded");
  });

  it("кнопки активної картки: «Затвердити» → approve, «Правки» → startEdit + фокус композера", async () => {
    const { visible, actions, store, $ } = setup(fixture("awaitingBrand"));
    (visible('[data-action="approve"]')[0] as HTMLButtonElement).click();
    await Promise.resolve();
    expect(actions.calls.map((c) => c.name)).toContain("approve");
    (visible('[data-action="edit"]')[0] as HTMLButtonElement).click();
    expect(store.getState().ui.editing).toBe(true);
    expect(document.activeElement).toBe($(".ch-composer__input"));
  });

  it("після затвердження (статус змінився) дії зникають, картка стає «✓ Затверджено» на місці", () => {
    const s = fixture("awaitingBrand");
    const { store, $, visible } = setup(s);
    const card = $('[data-kind="checkpoint"]');
    const entry = s.checkpoints.brand;
    if (!entry) throw new Error("немає brand");
    store.setState({
      status: "scripting",
      checkpoints: { ...s.checkpoints, brand: { ...entry, state: "approved" } },
    });
    expect($('[data-kind="checkpoint"]')).toBe(card);
    expect(card?.getAttribute("data-state")).toBe("approved");
    expect(visible("[data-action]")).toHaveLength(0);
  });
});

describe("chat · кнопки повідомлень", () => {
  const at = "2026-10-07T10:58:00.000Z";

  it("без картки approve/edit живуть в останньому повідомленні з ними", () => {
    const base = fixture("awaitingBrand");
    const feed: FeedItem[] = [
      { kind: "message", id: "m-1", at, role: "assistant", text: "Старе", buttons: ["approve", "edit"] },
      { kind: "message", id: "m-2", at, role: "assistant", text: "Нове", buttons: ["approve", "edit"] },
    ];
    const { visible } = setup({ ...base, feed });
    const approve = visible('[data-action="approve"]');
    expect(approve).toHaveLength(1);
    expect(approve[0]?.closest("[data-id]")?.getAttribute("data-id")).toBe("m-2");
    expect(approve[0]?.textContent).toBe("Затвердити");
    expect(visible('[data-action="edit"]')[0]?.textContent).toBe("Правки");
  });

  it("approve/edit поза awaiting_* сховані", () => {
    const base = fixture("awaitingBrand");
    const feed: FeedItem[] = [
      { kind: "message", id: "m-1", at, role: "assistant", text: "x", buttons: ["approve", "edit"] },
    ];
    const { visible, $ } = setup({ ...base, status: "scripting", feed });
    expect(visible("[data-action]")).toHaveLength(0);
    expect(($('[data-id="m-1"] .ch-actions') as HTMLElement).hidden).toBe(true);
  });

  it("restart_confirm → confirmRestart; ховається, коли з'явилось новіше повідомлення з кнопками", async () => {
    const base = fixture("delivered");
    const restart: FeedItem = {
      kind: "message",
      id: "m-r",
      at,
      role: "assistant",
      text: "Почати все спочатку?",
      buttons: ["restart_confirm"],
    };
    const { visible, actions, store } = setup({ ...base, feed: [...base.feed, restart] });
    const btn = visible('[data-action="restart_confirm"]')[0] as HTMLButtonElement;
    expect(btn.textContent).toBe("Так, почати заново");
    expect(btn.className).toContain("btn--ghost-ink");
    btn.click();
    await Promise.resolve();
    expect(actions.calls.map((c) => c.name)).toContain("confirmRestart");

    store.setState((s) => ({
      status: "awaiting_brand",
      feed: [
        ...s.feed,
        { kind: "message", id: "m-n", at, role: "assistant", text: "y", buttons: ["approve"] },
      ],
    }));
    expect(visible('[data-action="restart_confirm"]')).toHaveLength(0);
  });

  it("liveOwners: retry лише у failed", () => {
    const s = fixture("failed");
    expect(liveOwners(s).retry).not.toBeNull();
    expect(liveOwners({ ...s, status: "directing" }).retry).toBeNull();
  });

  it("подвійне натискання не дублює дію, поки вона виконується", async () => {
    const base = fixture("awaitingBrand");
    const store = createStore(base);
    const approve = vi.fn(() => new Promise<void>((r) => setTimeout(r, 10)));
    const actions = { ...createDevActions(store), approve };
    const el = document.createElement("aside");
    document.body.append(el);
    const view = mount(el, { store, actions });
    cleanups.push(() => view.destroy());
    const btn = el.querySelector<HTMLButtonElement>('.ch-card [data-action="approve"]');
    btn?.click();
    btn?.click();
    expect(approve).toHaveBeenCalledOnce();
    await new Promise((r) => setTimeout(r, 20));
    expect(btn?.disabled).toBe(false);
  });
});

describe("chat · інкрементальне оновлення", () => {
  it("нові елементи дописуються, старі вузли лишаються тими самими", () => {
    const s = fixture("awaitingBrand");
    const { el, store } = setup(s);
    const before = rowsOf(el);
    const list = el.querySelector(".ch-list");
    store.setState((st) => ({
      feed: [
        ...st.feed,
        {
          kind: "message",
          id: "new-1",
          at: "2026-10-07T11:00:00.000Z",
          role: "user",
          text: "Привіт",
          buttons: [],
        },
      ],
    }));
    const after = rowsOf(el);
    expect(after).toHaveLength(before.length + 1);
    expect(after.slice(0, before.length)).toEqual(before);
    for (const [i, node] of before.entries()) expect(after[i]).toBe(node);
    expect(after.at(-1)?.dataset.id).toBe("new-1");
    expect(after.at(-1)?.classList.contains("ch-enter")).toBe(true);
    expect(before[0]?.classList.contains("ch-enter")).toBe(false);
    expect(el.querySelector(".ch-list")).toBe(list);
  });

  it("рядок прогресу оновлюється на місці (той самий вузол)", () => {
    const s = fixture("directing");
    const { el, store } = setup(s);
    const last = s.feed.at(-1) as Item;
    expect(last.kind).toBe("progress");
    const node = el.querySelector(`[data-id="${last.id}"]`);
    store.setState((st) => ({
      feed: [...st.feed.slice(0, -1), { ...last, label: "Генерую сцени… 3/3", done: 3, running: false }],
    }));
    const same = el.querySelector(`[data-id="${last.id}"]`);
    expect(same).toBe(node);
    expect(same?.textContent).toContain("3/3");
    expect(same?.getAttribute("data-state")).toBe("done");
    expect(same?.querySelector(".spinner")).toBeNull();
  });

  it("елементи, яких більше немає в стрічці, прибираються", () => {
    const { el, store } = setup(fixture("awaitingBrand"));
    store.setState({ feed: [] });
    expect(rowsOf(el)).toHaveLength(0);
  });

  it("автоскрол: униз лише якщо користувач був унизу (поріг 80 px)", () => {
    const { el, store } = setup(fixture("awaitingBrand"));
    const feed = el.querySelector(".ch-feed") as HTMLElement;
    let scrollTop = 0;
    Object.defineProperty(feed, "scrollHeight", { configurable: true, get: () => 1000 });
    Object.defineProperty(feed, "clientHeight", { configurable: true, get: () => 300 });
    Object.defineProperty(feed, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (v: number) => {
        scrollTop = v;
      },
    });
    const add = (id: string) =>
      store.setState((st) => ({
        feed: [
          ...st.feed,
          { kind: "message", id, at: "2026-10-07T11:00:00.000Z", role: "user", text: id, buttons: [] },
        ],
      }));

    scrollTop = 640; // 1000 - 640 - 300 = 60 ≤ 80 → унизу
    add("a");
    expect(scrollTop).toBe(1000);

    scrollTop = 200; // далеко від низу
    add("b");
    expect(scrollTop).toBe(200);

    scrollTop = 640;
    store.setState({ conn: "lost" }); // не новий елемент — скрол не чіпаємо
    expect(scrollTop).toBe(640);
  });
});

describe("chat · хелпери", () => {
  it("richText: **жирний** лише через вузли, переноси — <br>", () => {
    const box = document.createElement("div");
    box.append(...richText("a **b** c\n**d**", true));
    expect(box.querySelectorAll("strong")).toHaveLength(2);
    expect(box.querySelectorAll("br")).toHaveLength(1);
    expect(box.textContent).toBe("a b cd");
    const raw = document.createElement("div");
    raw.append(...richText("**x**", false));
    expect(raw.textContent).toBe("**x**");
  });

  it("clock: HH:MM місцевого часу", () => {
    const d = new Date(2026, 9, 7, 9, 5);
    expect(clock(d.toISOString())).toBe("09:05");
    expect(clock("не дата")).toBe("");
  });

  it("notice показується біля композера і ховається при null", () => {
    const { $, store } = setup(fixture("awaitingBrand"));
    const notice = $(".ch-notice") as HTMLElement;
    expect(notice.hidden).toBe(true);
    store.setState((s) => ({ ui: { ...s.ui, notice: "Не вдалося надіслати" } }));
    expect(notice.hidden).toBe(false);
    expect(notice.getAttribute("role")).toBe("alert");
    expect(notice.textContent).toBe("Не вдалося надіслати");
    store.setState((s) => ({ ui: { ...s.ui, notice: null } }));
    expect(notice.hidden).toBe(true);
  });
});
