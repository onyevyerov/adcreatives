// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableCSSFileLoading":true,"handleDisabledFileLoadingAsSuccess":true}}
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDevActions } from "../../public/static/dev/dev-actions.js";
import { fixtureStates } from "../../public/static/dev/fixture-states.js";
import { boot } from "../../public/static/js/app.js";
import { STATUS_LABELS, STATUSES, type UiState } from "../../public/static/js/contracts.js";
import { createStore } from "../../public/static/js/store.js";
import { formatUsd, mount, statusKind } from "../../public/static/js/views/topbar.js";
import { DEFAULT_PUBLIC_DIR } from "../../src/config.ts";

function fixture(name: string): UiState {
  const s = fixtureStates[name];
  if (!s) throw new Error(`немає фікстури ${name}`);
  return s;
}

describe("views/topbar.js", () => {
  let host: HTMLElement;
  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
  });
  afterEach(() => {
    document.body.textContent = "";
  });

  function mountWith(state: UiState) {
    const store = createStore(state);
    const actions = createDevActions(store);
    const view = mount(host, { store, actions });
    store.subscribe((s, prev) => view.update(s, prev));
    return { store, actions, view };
  }

  const q = (sel: string) => host.querySelector<HTMLElement>(sel);

  it("хост, вордмарк, «Новий проєкт», «Статистика»", () => {
    const { view } = mountWith(fixture("awaitingBrand"));
    expect(q(".tb-wordmark")?.textContent).toBe("AdCreative");
    expect(q(".tb-host")?.textContent).toBe("zerno.example.com");
    expect(q(".tb-host")?.getAttribute("title")).toBe("zerno.example.com");
    expect(q(".tb-host")?.classList.contains("mono")).toBe(true);
    expect(q(".tb-sep")?.textContent).toBe("/");
    const btn = q("button.tb-new");
    expect(btn?.textContent).toBe("Новий проєкт");
    expect(btn?.classList.contains("btn--ghost")).toBe(true);
    const stats = q("a.tb-stats");
    expect(stats?.textContent).toBe("Статистика");
    expect(stats?.getAttribute("href")).toBe("/stats");
    view.destroy();
    expect(host.children.length).toBe(0);
  });

  it("без хоста ховає «/» і хост", () => {
    const { store, view } = mountWith({ ...fixture("crawling"), site: null });
    expect(q(".tb-host")?.hidden).toBe(true);
    expect(q(".tb-sep")?.hidden).toBe(true);
    store.setState({ site: "a.example.com" });
    expect(q(".tb-host")?.hidden).toBe(false);
    expect(q(".tb-host")?.textContent).toBe("a.example.com");
    view.destroy();
  });

  it.each([...STATUSES])("статус %s — підпис зі STATUS_LABELS", (status) => {
    const { view } = mountWith({ ...fixture("crawling"), status });
    expect(q(".tb-status__label")?.textContent).toBe(STATUS_LABELS[status]);
    expect(q(".tb-status")?.dataset.status).toBe(status);
    view.destroy();
  });

  it("крапка статусу за C2", () => {
    const { store, view } = mountWith(fixture("crawling"));
    const dot = () => q(".tb-status .dot");
    expect(q(".tb-status")?.classList.contains("tb-status--busy")).toBe(true);
    expect(dot()?.className).toBe("dot dot--accent dot--pulse");
    store.setState({ status: "awaiting_brand" });
    expect(dot()?.className).toBe("dot dot--accent");
    store.setState({ status: "delivered" });
    expect(dot()?.className).toBe("dot");
    store.setState({ status: "failed" });
    expect(dot()?.className).toBe("dot dot--danger");
    expect(q(".tb-status")?.classList.contains("tb-status--failed")).toBe(true);
    expect(statusKind("intake")).toBe("idle");
    expect(statusKind("revising")).toBe("busy");
    view.destroy();
  });

  it("витрати — «Витрачено $X.XX», оновлюються на місці", () => {
    const { store, view } = mountWith({ ...fixture("crawling"), totalUsd: 0 });
    const cost = q(".tb-cost");
    expect(cost?.textContent).toBe("Витрачено $0.00");
    store.setState({ totalUsd: 2.305 });
    expect(q(".tb-cost")).toBe(cost);
    expect(q(".tb-cost__sum")?.textContent).toBe("$2.31");
    store.setState({ totalUsd: 12 });
    expect(cost?.textContent).toBe("Витрачено $12.00");
    expect(formatUsd(0.1)).toBe("$0.10");
    expect(formatUsd(Number.NaN)).toBe("$0.00");
    view.destroy();
  });

  it("клік на вордмарк і «Новий проєкт» → newProject", () => {
    const { actions, view } = mountWith(fixture("awaitingBrand"));
    const newProjectCalls = () => actions.calls.filter((c) => c.name === "newProject").length;
    const click = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    q(".tb-wordmark")?.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(newProjectCalls()).toBe(1);
    q("button.tb-new")?.click();
    expect(newProjectCalls()).toBe(2);
    // клік з модифікатором — звичайне посилання (нова вкладка), без newProject
    q(".tb-wordmark")?.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true }),
    );
    expect(newProjectCalls()).toBe(2);
    view.destroy();
  });

  it("update не перестворює DOM", () => {
    const { store, view } = mountWith(fixture("crawling"));
    const root = host.firstElementChild;
    const btn = q("button.tb-new");
    store.setState(fixture("delivered"));
    expect(host.firstElementChild).toBe(root);
    expect(q("button.tb-new")).toBe(btn);
    expect(q(".tb-status__label")?.textContent).toBe("готово");
    view.destroy();
  });
});

describe("app.js з топбаром і таймлайном", () => {
  const errors = vi.spyOn(console, "error");
  afterEach(() => {
    errors.mockClear();
    vi.useRealTimers();
    document.body.textContent = "";
  });

  /** Розмітка <body> справжнього index.html (у тесті innerHTML дозволено; у public — ні). */
  function mountIndexHtml() {
    const html = readFileSync(path.join(DEFAULT_PUBLIC_DIR, "index.html"), "utf8");
    const body = /<body>([\s\S]*)<\/body>/.exec(html)?.[1];
    if (!body) throw new Error("index.html без <body>");
    document.body.innerHTML = body;
  }

  it.each(Object.keys(fixtureStates).filter((n) => n !== "start"))(
    "фікстура %s: монтується без помилок і прибирається",
    async (name) => {
      vi.useFakeTimers();
      mountIndexHtml();
      const app = await boot({ params: new URLSearchParams(), state: fixture(name) });
      expect(document.querySelector("#topbar .tb")).not.toBeNull();
      expect(document.querySelector("#timeline .tl")).not.toBeNull();
      expect(document.querySelector("#topbar .tb-status__label")?.textContent).toBe(
        STATUS_LABELS[fixture(name).status],
      );
      app.destroy();
      expect(document.querySelector(".tb, .tl")).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
      expect(errors).not.toHaveBeenCalled();
    },
  );

  it("«Новий проєкт» у топбарі повертає на старт", async () => {
    mountIndexHtml();
    const app = await boot({ params: new URLSearchParams(), state: fixture("awaitingBrand") });
    document.querySelector<HTMLButtonElement>("#topbar .tb-new")?.click();
    expect(document.getElementById("app")?.dataset.route).toBe("start");
    expect(document.querySelector(".tb, .tl")).toBeNull();
    app.destroy();
    expect(errors).not.toHaveBeenCalled();
  });
});
