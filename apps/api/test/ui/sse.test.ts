// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eventsOf, PATHS, type StoredEvent } from "../../public/static/dev/fixture-events.js";
import type { ChatEvent, UiState } from "../../public/static/js/contracts.js";
import { createActions } from "../../public/static/js/data/actions.js";
import { reduce } from "../../public/static/js/data/reduce.js";
import { connectEvents, RECONNECT_MS } from "../../public/static/js/data/sse.js";
import { initialState } from "../../public/static/js/initial.js";
import { createStore } from "../../public/static/js/store.js";

type Listener = (e: MessageEvent) => void;

/** Фейковий EventSource: події диспетчеризуються вручну, `error` — як у браузері (і в onerror). */
class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];
  static last(): FakeEventSource {
    const es = FakeEventSource.instances.at(-1);
    if (!es) throw new Error("EventSource не створено");
    return es;
  }

  readyState = FakeEventSource.CONNECTING;
  onopen: ((e: Event) => unknown) | null = null;
  onerror: ((e: Event) => unknown) | null = null;
  closed = false;
  private listeners = new Map<string, Listener[]>();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }
  open() {
    this.readyState = FakeEventSource.OPEN;
    this.onopen?.(new Event("open"));
  }
  emit({ id, event }: StoredEvent) {
    const e = { type: event.type, data: JSON.stringify(event), lastEventId: id } as MessageEvent;
    for (const fn of this.listeners.get(event.type) ?? []) fn(e);
    if (event.type === "error") this.onerror?.(e);
  }
  /** Обрив з'єднання: браузер або перепідключається (CONNECTING), або здається (CLOSED). */
  fail(readyState: number) {
    this.readyState = readyState;
    this.onerror?.(new Event("error"));
  }
}

const ES = FakeEventSource as unknown as NonNullable<Parameters<typeof connectEvents>[0]["EventSource"]>;
const events = eventsOf(PATHS.failed);

beforeEach(() => {
  FakeEventSource.instances = [];
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function setup() {
  const store = createStore<UiState>(initialState("project", "p1"));
  const conns: string[] = [];
  const seen: string[] = [];
  const sub = connectEvents({
    projectId: "p1",
    EventSource: ES,
    onEvent: (id: string, event: ChatEvent) => {
      seen.push(id);
      store.setState((s) => reduce(s, event, id));
    },
    onConn: (c) => {
      conns.push(c);
      store.setState({ conn: c });
    },
  });
  return { store, conns, seen, sub };
}

describe("connectEvents", () => {
  it("підписується на всі типи подій і передає їх у reduce", () => {
    const { store, conns, sub } = setup();
    const es = FakeEventSource.last();
    expect(es.url).toBe("/api/projects/p1/events");
    es.open();
    expect(conns).toEqual(["online"]);
    for (const e of events) es.emit(e);
    const s = store.getState();
    expect(s.status).toBe("failed");
    expect(s.error?.stage).toBe("codegen");
    // Подія чату `error` теж прийшла в onerror, але це не обрив.
    expect(s.conn).toBe("online");
    expect(sub.lastEventId).toBe(events.at(-1)?.id);
  });

  it("повтори й старі ID відкидаються", () => {
    const { seen } = setup();
    const es = FakeEventSource.last();
    es.open();
    const head = events.slice(0, 5);
    for (const e of [...head, ...head, events[1] as StoredEvent]) es.emit(e);
    expect(seen).toEqual(head.map((e) => e.id));
  });

  it("CONNECTING → reconnecting, CLOSED → lost і ручне перепідключення з lastEventId через 3 с", () => {
    vi.useFakeTimers();
    const { conns, store } = setup();
    const first = FakeEventSource.last();
    first.open();
    for (const e of events.slice(0, 3)) first.emit(e);
    first.fail(FakeEventSource.CONNECTING);
    expect(store.getState().conn).toBe("reconnecting");
    first.open();
    first.fail(FakeEventSource.CLOSED);
    expect(store.getState().conn).toBe("lost");
    vi.advanceTimersByTime(RECONNECT_MS - 1);
    expect(FakeEventSource.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.instances).toHaveLength(2);
    const second = FakeEventSource.last();
    const lastId = events[2]?.id ?? "";
    expect(second.url).toBe(`/api/projects/p1/events?lastEventId=${encodeURIComponent(lastId)}`);
    expect(first.closed).toBe(true);
    expect(store.getState().conn).toBe("reconnecting");
    second.open();
    expect(conns).toEqual(["online", "reconnecting", "online", "lost", "reconnecting", "online"]);
    // Сервер міг повторити вже отримане — відкидається.
    second.emit(events[2] as StoredEvent);
    second.emit(events[3] as StoredEvent);
    expect(store.getState().feed.length).toBeGreaterThan(0);
  });

  it("close() скасовує таймер і ігнорує пізні події", () => {
    vi.useFakeTimers();
    const { sub, seen } = setup();
    const es = FakeEventSource.last();
    es.open();
    es.fail(FakeEventSource.CLOSED);
    sub.close();
    vi.advanceTimersByTime(RECONNECT_MS * 2);
    expect(FakeEventSource.instances).toHaveLength(1);
    es.emit(events[0] as StoredEvent);
    expect(seen).toEqual([]);
  });

  it("некоректний JSON і подія без типу ігноруються", () => {
    const { seen } = setup();
    const es = FakeEventSource.last();
    es.open();
    const fns = (es as unknown as { listeners: Map<string, Listener[]> }).listeners.get("message") ?? [];
    for (const fn of fns) fn({ data: "{", lastEventId: "1-0" } as MessageEvent);
    for (const fn of fns) fn({ data: '{"type":"nope"}', lastEventId: "2-0" } as MessageEvent);
    expect(seen).toEqual([]);
  });
});

describe("createActions + SSE", () => {
  it("?project=<id>: GET проєкту, SSE, події в store, статус з'єднання", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: "p1",
            status: "crawling",
            project: null,
            intake: { input: { url: "https://www.zerno.example.com/uk/" } },
            totalUsd: 0,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetch);
    const store = createStore<UiState>(initialState("project", "p1"));
    const actions = createActions(store, {
      params: new URLSearchParams("project=p1"),
      EventSource: ES,
      batchMs: 0,
    });
    const es = FakeEventSource.last();
    expect(es.url).toBe("/api/projects/p1/events");
    await actions.ready;
    expect(fetch).toHaveBeenCalledWith("/api/projects/p1", undefined);
    expect(store.getState().site).toBe("www.zerno.example.com");
    expect(store.getState().conn).toBe("idle");
    es.open();
    expect(store.getState().conn).toBe("online");
    for (const e of eventsOf(PATHS.brand)) es.emit(e);
    expect(store.getState().status).toBe("awaiting_brand");
    es.fail(FakeEventSource.CLOSED);
    expect(store.getState().conn).toBe("lost");
    actions.dispose();
    expect(es.closed).toBe(true);
  });

  it("події збираються в один setState за вікно batchMs", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 404 })),
    );
    const store = createStore<UiState>(initialState("project", "p1"));
    const renders = vi.fn();
    store.subscribe(renders);
    const actions = createActions(store, {
      params: new URLSearchParams("project=p1"),
      EventSource: ES,
      batchMs: 30,
    });
    await actions.ready;
    expect(store.getState().ui.notice).toBe("Помилка 404");
    renders.mockClear();
    const es = FakeEventSource.last();
    for (const e of eventsOf(PATHS.brand)) es.emit(e);
    expect(renders).not.toHaveBeenCalled();
    vi.advanceTimersByTime(30);
    expect(renders).toHaveBeenCalledOnce();
    expect(store.getState().status).toBe("awaiting_brand");
    actions.dispose();
  });
});
