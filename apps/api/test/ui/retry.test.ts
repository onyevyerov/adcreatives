// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fixtureStates } from "../../public/static/dev/fixture-states.js";
import type { Actions, PartDeps, UiState } from "../../public/static/js/contracts.js";
import { createAccountActions } from "../../public/static/js/data/account.js";
import type { Backend } from "../../public/static/js/data/actions.js";
import { retryActions } from "../../public/static/js/data/retry-actions.js";
import { createStore } from "../../public/static/js/store.js";
import { lastRefusedText, userTextBefore } from "../../public/static/js/views/chat.js";

type Retry = NonNullable<UiState["ui"]["retry"]>;

const EDIT = "Зроби заголовок коротшим";

function fixture(name: string): UiState {
  const s = fixtureStates[name];
  if (!s) throw new Error(`немає фікстури ${name}`);
  return s;
}

const withRetry = (s: UiState, retry: Retry | null): UiState => ({ ...s, ui: { ...s.ui, retry } });

/** Part-фабрика з підставними діями проєкту. */
function setup(state: UiState, over: Partial<Pick<Actions, "approve" | "sendMessage">> = {}) {
  const store = createStore(state);
  const approve = vi.fn(over.approve ?? (async () => {}));
  const sendMessage = vi.fn(over.sendMessage ?? (async () => true));
  const actions = { approve, sendMessage } as unknown as Actions;
  const deps = { actions: () => actions } as unknown as PartDeps;
  const part = retryActions(store, deps);
  return { store, part, approve, sendMessage };
}

beforeEach(() => {
  // Тести не ходять у мережу.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("мережа в тестах заборонена");
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

describe("retryAfterTopup · part-файл B6", () => {
  it("рівно ключ B6 із 2.1", () => {
    const { part } = setup(fixture("n6-retry"));
    expect(Object.keys(part)).toEqual(["retryAfterTopup"]);
  });

  it("cp3 → approve(); успіх знімає ui.retry", async () => {
    const { store, part, approve, sendMessage } = setup(fixture("n6-retry"));
    await part.retryAfterTopup();
    expect(approve).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(store.getState().ui.retry).toBeNull();
  });

  it("cp3: збій команди (ui.notice) — картка лишається", async () => {
    const { store, part } = setup(fixture("n6-retry"), {
      approve: async () => store.setState((s) => ({ ui: { ...s.ui, notice: "Сервер недоступний" } })),
    });
    await part.retryAfterTopup();
    expect(store.getState().ui.retry).toEqual({ ctx: "cp3", plus: 10, text: null });
  });

  it("rev → sendMessage(текст правки); успіх знімає ui.retry", async () => {
    const { store, part, approve, sendMessage } = setup(fixture("n6-retry-rev"));
    await part.retryAfterTopup();
    expect(sendMessage).toHaveBeenCalledWith(EDIT);
    expect(approve).not.toHaveBeenCalled();
    expect(store.getState().ui.retry).toBeNull();
  });

  it("rev: не надіслалось — картка лишається", async () => {
    const { store, part } = setup(fixture("n6-retry-rev"), { sendMessage: async () => false });
    await part.retryAfterTopup();
    expect(store.getState().ui.retry?.ctx).toBe("rev");
  });

  it("rev без тексту з оплати — правка перед останньою відмовою зі стрічки", async () => {
    const { part, sendMessage } = setup(
      withRetry(fixture("n7-rev-short"), { ctx: "rev", plus: 10, text: null }),
    );
    await part.retryAfterTopup();
    expect(sendMessage).toHaveBeenCalledWith(EDIT);
  });

  it("без ui.retry — нічого", async () => {
    const { part, approve, sendMessage } = setup(fixture("n7-fmt-short"));
    await part.retryAfterTopup();
    expect(approve).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("подвійне натискання не дублює дію", async () => {
    let release = () => {};
    const { part, approve } = setup(fixture("n6-retry"), {
      approve: () =>
        new Promise<void>((r) => {
          release = r;
        }),
    });
    const first = part.retryAfterTopup();
    await part.retryAfterTopup();
    release();
    await first;
    expect(approve).toHaveBeenCalledTimes(1);
  });

  it("нова ui.retry, покладена під час повтору, не скидається", async () => {
    const next: Retry = { ctx: "cp3", plus: 25, text: null };
    const { store, part } = setup(fixture("n6-retry"), {
      approve: async () => store.setState((s) => ({ ui: { ...s.ui, retry: next } })),
    });
    await part.retryAfterTopup();
    expect(store.getState().ui.retry).toBe(next);
  });
});

describe("chat.js · текст правки для повтору", () => {
  it("userTextBefore / lastRefusedText", () => {
    const feed = fixture("n7-rev-short").feed;
    expect(userTextBefore(feed)).toBe(EDIT);
    expect(userTextBefore(feed, 0)).toBeNull();
    expect(lastRefusedText(feed)).toBe(EDIT);
    expect(lastRefusedText(fixture("n7-rev").feed)).toBeNull();
  });
});

describe("retryAfterTopup · у зібраних діях (data/account.js)", () => {
  function backendStub(): Backend & {
    sendCommand: ReturnType<typeof vi.fn>;
    sendMessage: ReturnType<typeof vi.fn>;
  } {
    return {
      start: vi.fn(async () => {}),
      stop: vi.fn(),
      createProject: vi.fn(async () => "p1"),
      sendMessage: vi.fn(async () => {}),
      sendCommand: vi.fn(async () => {}),
      uploadPhotos: vi.fn(async () => {}),
    };
  }

  it("cp3: команда approve з поточною ревізією через бекенд проєкту", async () => {
    const store = createStore(fixture("n6-retry"));
    const backend = backendStub();
    const actions = createAccountActions(store, { params: new URLSearchParams("mock=1"), backend });
    await actions.retryAfterTopup();
    expect(backend.sendCommand).toHaveBeenCalledWith("p1", { type: "approve", rev: 1 });
    expect(store.getState().ui.retry).toBeNull();
    actions.dispose();
  });

  it("rev: правка повідомленням; відмова сервера лишає картку", async () => {
    const store = createStore(fixture("n6-retry-rev"));
    const backend = backendStub();
    backend.sendMessage.mockRejectedValueOnce(new Error("Сервер недоступний"));
    const actions = createAccountActions(store, { params: new URLSearchParams("mock=1"), backend });
    await actions.retryAfterTopup();
    expect(backend.sendMessage).toHaveBeenCalledWith("p1", EDIT);
    expect(store.getState().ui.retry?.ctx).toBe("rev");
    await actions.retryAfterTopup();
    expect(store.getState().ui.retry).toBeNull();
    actions.dispose();
  });
});
