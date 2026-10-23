// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fixtureStates } from "../../public/static/dev/fixture-states.js";
import type { UiState } from "../../public/static/js/contracts.js";
import {
  APPLY_FORMATS_FIRST,
  boardCurrentFormats,
  boardFormatsDirty,
  brandChoices,
  brandLanguage,
  createActions,
  NEED_FORMAT,
} from "../../public/static/js/data/actions.js";
import { initialState } from "../../public/static/js/initial.js";
import { createStore } from "../../public/static/js/store.js";

type Call = { url: string; init: RequestInit | undefined };

/** Підмінений fetch: відповіді за шляхом (і методом), журнал викликів. */
function stubFetch(routes: Record<string, { status?: number; body?: unknown }> = {}) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const key = `${init?.method ?? "GET"} ${url}`;
    const r = routes[key] ?? routes[url] ?? { status: 202, body: { commandId: "c1" } };
    return new Response(JSON.stringify(r.body ?? {}), {
      status: r.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

const jsonBody = (c: Call | undefined) => JSON.parse(String(c?.init?.body));

class NoopEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: NoopEventSource[] = [];
  readyState = 0;
  onopen = null;
  onerror = null;
  closed = false;
  constructor(readonly url: string) {
    NoopEventSource.instances.push(this);
  }
  addEventListener() {}
  close() {
    this.closed = true;
  }
}
const EventSource = NoopEventSource as never;

/** Проєкт p1 на чекпоінті 1 (ревізія з фікстури). */
function projectStore(patch: Partial<UiState> = {}) {
  const s = fixtureStates.awaitingBrand;
  if (!s) throw new Error("немає фікстури");
  return createStore<UiState>({ ...s, ...patch });
}

function make(store = projectStore(), query = "") {
  return createActions(store, { params: new URLSearchParams(query), EventSource, batchMs: 0 });
}

beforeEach(() => {
  NoopEventSource.instances = [];
  history.replaceState(null, "", "/");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("createProject", () => {
  it("успіх: POST multipart → replaceState ?project=<id>, маршрут project, site, підключення", async () => {
    const calls = stubFetch({
      "POST /api/projects": { status: 201, body: { id: "abc", chatUrl: "/?project=abc" } },
      "/api/projects/abc": {
        body: { id: "abc", status: "intake", project: null, intake: null, totalUsd: 0 },
      },
    });
    const store = createStore<UiState>(initialState("start", null));
    const actions = make(store);
    expect(calls).toHaveLength(0);
    const form = new FormData();
    form.set("url", "zerno.example.com");
    const pending = actions.createProject(form);
    expect(store.getState().ui.sending).toBe(true);
    await pending;
    await actions.ready;
    expect(calls[0]?.url).toBe("/api/projects");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.body).toBe(form);
    expect(location.search).toBe("?project=abc");
    const s = store.getState();
    expect(s.route).toBe("project");
    expect(s.projectId).toBe("abc");
    expect(s.site).toBe("zerno.example.com");
    expect(s.ui.sending).toBe(false);
    expect(s.ui.startError).toBeNull();
    expect(NoopEventSource.instances.map((e) => e.url)).toEqual(["/api/projects/abc/events"]);
  });

  it("помилка: повідомлення сервера в ui.startError, маршрут не змінюється, не кидає", async () => {
    stubFetch({
      "POST /api/projects": {
        status: 422,
        body: { error: "unsupported_source", message: "Це соцмережа — вставте адресу сайту." },
      },
    });
    const store = createStore<UiState>(initialState("start", null));
    const actions = make(store);
    await expect(actions.createProject(new FormData())).resolves.toBeUndefined();
    const s = store.getState();
    expect(s.route).toBe("start");
    expect(s.ui.startError).toBe("Це соцмережа — вставте адресу сайту.");
    expect(s.ui.sending).toBe(false);
    expect(NoopEventSource.instances).toHaveLength(0);
  });

  it("мережева помилка → зрозумілий текст", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    const store = createStore<UiState>(initialState("start", null));
    await make(store).createProject(new FormData());
    expect(store.getState().ui.startError).toMatch(/зв'язку/);
  });
});

describe("повідомлення", () => {
  it("sendMessage: trim, POST /messages, скидає чернетку, правку і notice", async () => {
    const calls = stubFetch();
    const store = projectStore();
    store.setState((s) => ({ ui: { ...s.ui, draft: " коротше ", editing: true, notice: "стара помилка" } }));
    const actions = make(store);
    await expect(actions.sendMessage("  коротше  ")).resolves.toBe(true);
    expect(calls[0]?.url).toBe("/api/projects/p1/messages");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(jsonBody(calls[0])).toEqual({ text: "коротше" });
    expect(store.getState().ui).toMatchObject({ draft: "", editing: false, notice: null, sending: false });
  });

  it("sendMessage: порожній текст → false без запиту", async () => {
    const calls = stubFetch();
    await expect(make().sendMessage("   ")).resolves.toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("sendMessage: помилка → ui.notice, false, чернетка лишається", async () => {
    stubFetch({
      "POST /api/projects/p1/messages": { status: 400, body: { message: "Повідомлення задовге." } },
    });
    const store = projectStore();
    store.setState((s) => ({ ui: { ...s.ui, draft: "текст" } }));
    await expect(make(store).sendMessage("текст")).resolves.toBe(false);
    expect(store.getState().ui).toMatchObject({
      notice: "Повідомлення задовге.",
      draft: "текст",
      sending: false,
    });
  });

  it("setLanguage / setFormats лише пишуть чернетку — без запитів і повідомлень", async () => {
    vi.useFakeTimers();
    const calls = stubFetch();
    const store = projectStore();
    store.setState((s) => ({ ui: { ...s.ui, draft: "моя правка", editing: true } }));
    const actions = make(store);
    actions.setLanguage("en");
    actions.setFormats(["square", "vertical"]);
    expect(store.getState().ui).toMatchObject({
      pendingLanguage: "en",
      pendingFormats: ["vertical", "square"],
      draft: "моя правка",
      editing: true,
    });
    // Можна зняти будь-який, зокрема всі (чернетка `[]`).
    actions.setFormats([]);
    expect(store.getState().ui.pendingFormats).toEqual([]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toHaveLength(0);
    expect(store.getState().ui.notice).toBeNull();
  });
});

describe("approve з чернеткою вибору (ЧП1)", () => {
  it("без змін чернетки → approve без choices, як раніше", async () => {
    const calls = stubFetch();
    const store = projectStore({ rev: 2 });
    const actions = make(store);
    // Чернетка, що збігається з payload (9:16 і мова бренд-кіта), — це не зміна.
    actions.setFormats(["vertical"]);
    actions.setLanguage("uk");
    await actions.approve();
    expect(calls.map(jsonBody)).toEqual([{ type: "approve", rev: 2 }]);
  });

  it("1:1 + en → один запит approve з choices; після успіху чернетка чиста", async () => {
    const calls = stubFetch();
    const store = projectStore({ rev: 2 });
    const actions = make(store);
    actions.setFormats(["square"]);
    actions.setLanguage("en");
    expect(calls).toHaveLength(0);
    await actions.approve();
    expect(calls.map((c) => c.url)).toEqual(["/api/projects/p1/commands"]);
    expect(calls.map(jsonBody)).toEqual([
      { type: "approve", rev: 2, choices: { formats: ["square"], language: "en" } },
    ]);
    expect(store.getState().ui).toMatchObject({ pendingFormats: null, pendingLanguage: null });
  });

  it("лише формати → choices без мови", async () => {
    const calls = stubFetch();
    const actions = make(projectStore({ rev: 1 }));
    actions.setFormats(["landscape", "vertical"]);
    await actions.approve();
    expect(calls.map(jsonBody)).toEqual([
      { type: "approve", rev: 1, choices: { formats: ["vertical", "landscape"] } },
    ]);
  });

  it("0 форматів → запиту немає, підказка; помилка команди лишає чернетку", async () => {
    const calls = stubFetch({
      "POST /api/projects/p1/commands": { status: 400, body: { message: "Некоректні параметри команди." } },
    });
    const store = projectStore();
    const actions = make(store);
    actions.setFormats([]);
    await actions.approve();
    expect(calls).toHaveLength(0);
    expect(store.getState().ui.notice).toBe(NEED_FORMAT);

    actions.setFormats(["square"]);
    await actions.approve();
    expect(calls).toHaveLength(1);
    expect(store.getState().ui).toMatchObject({
      notice: "Некоректні параметри команди.",
      pendingFormats: ["square"],
    });
  });

  it("brandChoices / brandLanguage — чисті функції над станом", () => {
    const s = projectStore().getState();
    expect(brandLanguage(s)).toBe("uk");
    expect(brandChoices(s)).toBeNull();
    expect(brandChoices({ ...s, ui: { ...s.ui, pendingFormats: [] } })).toBe("empty");
    expect(brandChoices({ ...s, ui: { ...s.ui, pendingFormats: ["square", "vertical"] } })).toEqual({
      formats: ["vertical", "square"],
    });
    expect(brandChoices({ ...s, ui: { ...s.ui, pendingLanguage: "en" } })).toEqual({ language: "en" });
  });
});

describe("формати на ЧП3 — чернетка і «Застосувати»", () => {
  function boardStore() {
    const s = fixtureStates.awaitingStoryboard;
    if (!s) throw new Error("немає фікстури");
    return createStore<UiState>(s);
  }

  it("applyFormats шле «Формати: …» (ревізія) і чистить чернетку; approve при незастосованій — ні", async () => {
    const calls = stubFetch();
    const store = boardStore();
    const actions = make(store);
    const current = boardCurrentFormats(store.getState());
    const other = current.includes("landscape")
      ? current.filter((f) => f !== "landscape")
      : [...current, "landscape" as const];
    actions.setFormats(other);
    expect(boardFormatsDirty(store.getState())).toBe(true);
    await actions.approve();
    expect(calls).toHaveLength(0);
    expect(store.getState().ui.notice).toBe(APPLY_FORMATS_FIRST);

    await actions.applyFormats?.();
    expect(calls.map((c) => c.url)).toEqual(["/api/projects/p1/messages"]);
    expect(jsonBody(calls[0]).text).toMatch(/^Формати: /);
    expect(store.getState().ui.pendingFormats).toBeNull();
  });

  it("чернетка, що збігається з поточними, не блокує approve", async () => {
    const calls = stubFetch();
    const store = boardStore();
    const actions = make(store);
    actions.setFormats(boardCurrentFormats(store.getState()));
    expect(boardFormatsDirty(store.getState())).toBe(false);
    await actions.approve();
    expect(calls.map(jsonBody)).toEqual([{ type: "approve", rev: store.getState().rev }]);
  });
});

describe("команди", () => {
  it("approve шле rev зі стану; retry, set_logo, restart_confirmed — без window.confirm", async () => {
    const calls = stubFetch();
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    const actions = make(projectStore({ rev: 3 }));
    await actions.approve();
    await actions.retry();
    await actions.setLogo("a02");
    await actions.confirmRestart();
    expect(calls.every((c) => c.url === "/api/projects/p1/commands" && c.init?.method === "POST")).toBe(true);
    expect(calls.map(jsonBody)).toEqual([
      { type: "approve", rev: 3 },
      { type: "retry" },
      { type: "set_logo", assetId: "a02" },
      { type: "restart_confirmed" },
    ]);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("помилка команди → ui.notice", async () => {
    stubFetch({
      "POST /api/projects/p1/commands": { status: 400, body: { message: "Некоректні параметри команди." } },
    });
    const store = projectStore();
    await make(store).approve();
    expect(store.getState().ui.notice).toBe("Некоректні параметри команди.");
  });

  it("uploadPhotos: multipart photos на /uploads; помилка → notice", async () => {
    const calls = stubFetch();
    const store = projectStore();
    const actions = make(store);
    const files = [
      new File(["a"], "a.jpg", { type: "image/jpeg" }),
      new File(["b"], "b.png", { type: "image/png" }),
    ];
    await actions.uploadPhotos(files);
    expect(calls[0]?.url).toBe("/api/projects/p1/uploads");
    const body = calls[0]?.init?.body as FormData;
    expect(body.getAll("photos").map((f) => (f as File).name)).toEqual(["a.jpg", "b.png"]);

    stubFetch({ "POST /api/projects/p1/uploads": { status: 400, body: { message: "Файл завеликий." } } });
    await actions.uploadPhotos(files);
    expect(store.getState().ui.notice).toBe("Файл завеликий.");
  });
});

describe("UI-дії і маршрути", () => {
  it("startEdit, setDraft, setDoneFormat", () => {
    stubFetch();
    const store = projectStore();
    const actions = make(store);
    actions.startEdit();
    actions.setDraft("чернетка");
    actions.setDoneFormat("square");
    expect(store.getState().ui).toMatchObject({ editing: true, draft: "чернетка", doneFormat: "square" });
  });

  it("?project=<id> підключається одразу; newProject закриває SSE і повертає на старт", async () => {
    stubFetch({
      "/api/projects/p1": { body: { id: "p1", status: "crawling", project: null, intake: null } },
    });
    history.replaceState(null, "", "/?project=p1");
    const store = projectStore();
    const actions = make(store, "project=p1");
    await actions.ready;
    const es = NoopEventSource.instances[0];
    expect(es?.url).toBe("/api/projects/p1/events");
    actions.newProject();
    expect(es?.closed).toBe(true);
    expect(location.pathname + location.search).toBe("/");
    expect(store.getState()).toEqual(initialState("start", null));
  });

  it("без ?project= нічого не завантажує", () => {
    const calls = stubFetch();
    make(createStore<UiState>(initialState("start", null)));
    expect(calls).toHaveLength(0);
    expect(NoopEventSource.instances).toHaveLength(0);
  });
});

describe("mock (?mock=1)", () => {
  it("jump=brand: одразу робочий простір на чекпоінті 1, без мережі; approve → чекпоінт 2", async () => {
    vi.useFakeTimers();
    const calls = stubFetch();
    const store = createStore<UiState>(initialState("start", null));
    const actions = make(store, "mock=1&jump=brand");
    expect(store.getState().route).toBe("project");
    await actions.ready;
    let s = store.getState();
    expect(s).toMatchObject({
      status: "awaiting_brand",
      projectId: "p1",
      site: "zerno.example.com",
      conn: "online",
    });
    // `at` mock зсуває до реального часу — решта як у фікстурі.
    const { at: _at, ...brand } = s.checkpoints.brand ?? { at: "" };
    const { at: _fxAt, ...fxBrand } = fixtureStates.awaitingBrand?.checkpoints.brand ?? { at: "" };
    expect(brand).toEqual(fxBrand);

    await actions.approve();
    await vi.runAllTimersAsync();
    s = store.getState();
    expect(s.status).toBe("awaiting_script");
    expect(s.checkpoints.brand?.state).toBe("approved");
    expect(calls).toHaveLength(0);
    expect(NoopEventSource.instances).toHaveLength(0);
  });

  it("start → createProject → toBrand; повідомлення — echo + відповідь; formats у mock", async () => {
    vi.useFakeTimers();
    history.replaceState(null, "", "/?mock=1&speed=2");
    const calls = stubFetch();
    const store = createStore<UiState>(initialState("start", null));
    const actions = make(store, "mock=1&speed=2");
    const form = new FormData();
    form.set("url", "https://zerno.example.com/");
    const done = actions.createProject(form);
    expect(store.getState().ui.sending).toBe(true);
    await vi.runAllTimersAsync();
    await done;
    expect(new URLSearchParams(location.search).get("mock")).toBe("1");
    expect(new URLSearchParams(location.search).get("speed")).toBe("2");
    expect(new URLSearchParams(location.search).get("project")).toBe("p1");
    let s = store.getState();
    expect(s.status).toBe("awaiting_brand");
    expect(s.feed[0]).toMatchObject({ kind: "message", role: "user", text: "https://zerno.example.com/" });

    // Вибір форматів — лише чернетка: у стрічці нічого нового.
    const feedLength = s.feed.length;
    actions.setFormats(["square", "vertical"]);
    await vi.runAllTimersAsync();
    s = store.getState();
    expect(s.feed).toHaveLength(feedLength);
    expect(s.ui.pendingFormats).toEqual(["vertical", "square"]);
    expect(calls).toHaveLength(0);

    actions.newProject();
    expect(location.search).toBe("?mock=1&speed=2");
    expect(store.getState().route).toBe("start");
  });

  it("порожня форма в mock → startError", async () => {
    const store = createStore<UiState>(initialState("start", null));
    await make(store, "mock=1").createProject(new FormData());
    expect(store.getState().ui.startError).toMatch(/адресу сайту/);
  });

  it("jump=failed → retry → чекпоінт 3 → approve → готово → правка → ревізія 2 → готово", async () => {
    vi.useFakeTimers();
    stubFetch();
    const store = createStore<UiState>(initialState("start", null));
    const actions = make(store, "mock=1&jump=failed");
    await actions.ready;
    expect(store.getState().status).toBe("failed");
    await actions.retry();
    await vi.runAllTimersAsync();
    expect(store.getState().status).toBe("awaiting_storyboard");
    await actions.approve();
    await vi.runAllTimersAsync();
    expect(store.getState()).toMatchObject({ status: "delivered", rev: 1 });
    await actions.sendMessage("Зроби заголовок коротшим");
    await vi.runAllTimersAsync();
    let s = store.getState();
    expect(s).toMatchObject({ status: "awaiting_storyboard", rev: 2 });
    expect(s.feed.filter((f) => f.kind === "message" && f.role === "user").at(-1)).toMatchObject({
      text: "Зроби заголовок коротшим",
    });
    await actions.approve();
    await vi.runAllTimersAsync();
    s = store.getState();
    expect(s).toMatchObject({ status: "delivered", rev: 2 });
    expect(s.artifacts.videos.filter((v) => v.rev === 2)).toHaveLength(2);
  });

  it("час подій — реальний: jump зсуває шлях до «зараз», програвання ставить поточний час", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T12:00:00.000Z"));
    stubFetch();
    const store = createStore<UiState>(initialState("start", null));
    const actions = make(store, "mock=1&jump=brand");
    await actions.ready;
    let s = store.getState();
    // Тривалості фікстури збережено, остання подія — «зараз».
    expect(s.busyMs).toBe(fixtureStates.awaitingBrand?.busyMs);
    expect(Date.parse(s.feed.at(-1)?.at ?? "")).toBe(Date.now());

    await actions.approve();
    await vi.advanceTimersByTimeAsync(1000);
    s = store.getState();
    expect(s.status).toBe("scripting");
    const since = Date.parse(s.busySince ?? "");
    expect(Date.now() - since).toBeGreaterThanOrEqual(0);
    expect(Date.now() - since).toBeLessThan(5000);
  });

  it("?fail=1: approve на чекпоінті 2 один раз веде у failed", async () => {
    vi.useFakeTimers();
    stubFetch();
    const store = createStore<UiState>(initialState("start", null));
    const actions = make(store, "mock=1&jump=script&fail=1");
    await actions.ready;
    await actions.approve();
    await vi.runAllTimersAsync();
    expect(store.getState().status).toBe("failed");
  });
});
