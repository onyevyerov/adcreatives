// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableCSSFileLoading":true,"handleDisabledFileLoadingAsSuccess":true}}
import { describe, expect, it } from "vitest";
import { createDevActions } from "../../public/static/dev/dev-actions.js";
import { ADMIN_ME, accountFixture } from "../../public/static/dev/fixtures/_base.js";
import type { UiState, UsageState } from "../../public/static/js/contracts.js";
import { stateForUrl } from "../../public/static/js/data/account.js";
import * as accountApi from "../../public/static/js/data/account-api.js";
import { initialAdmin, initialUsage } from "../../public/static/js/initial.js";
import {
  presetRange,
  USAGE_PAGE_SIZE,
  USAGE_PRESETS,
  USAGE_SEARCH_DEBOUNCE_MS,
  usageQuery,
} from "../../public/static/js/lib/usage.js";
import { ADMIN_TABS, routeFromUrl, urlForRoute } from "../../public/static/js/router.js";
import { createStore } from "../../public/static/js/store.js";
import { mount } from "../../public/static/js/views/admin.js";

/** Крок 0 вкладки «Використання»: стан, хелпери, маршрут, точка монтування. */

describe("initial.js — admin.usage", () => {
  it("30 днів, chat, usd desc, сторінка 1, решта порожня", () => {
    const now = new Date("2026-10-22T15:00:00Z");
    const expected: UsageState = {
      preset: "30d",
      range: { from: "2026-09-23", to: "2026-10-22" },
      source: "chat",
      rangeError: false,
      loading: false,
      error: false,
      summary: null,
      users: [],
      usersSort: { key: "usd", order: "desc" },
      expandedUserId: null,
      userProjects: { q: "", sort: { key: "usd", order: "desc" }, page: 1, data: null, loading: false },
      all: { q: "", sort: { key: "usd", order: "desc" }, page: 1, data: null, loading: false },
      expandedProjectId: null,
    };
    expect(initialUsage(now)).toEqual(expected);
    const admin = initialAdmin();
    expect(admin.usage.preset).toBe("30d");
    expect(admin.usage.range).toEqual(presetRange("30d", new Date()));
  });
});

describe("lib/usage.js", () => {
  it("константи", () => {
    expect(USAGE_PRESETS).toEqual(["7d", "30d", "month", "all", "custom"]);
    expect(USAGE_PAGE_SIZE).toBe(25);
    expect(USAGE_SEARCH_DEBOUNCE_MS).toBe(300);
  });

  it.each([
    ["7d", "2026-10-22T15:00:00Z", { from: "2026-10-16", to: "2026-10-22" }],
    ["30d", "2026-10-22T15:00:00Z", { from: "2026-09-23", to: "2026-10-22" }],
    ["month", "2026-10-22T15:00:00Z", { from: "2026-10-01", to: "2026-10-22" }],
    // межі дня й місяця — за UTC, не за локальним часом
    ["month", "2026-11-01T00:30:00Z", { from: "2026-11-01", to: "2026-11-01" }],
    ["month", "2026-10-31T23:59:59Z", { from: "2026-10-01", to: "2026-10-31" }],
    ["7d", "2026-03-02T01:00:00Z", { from: "2026-02-24", to: "2026-03-02" }],
    ["all", "2026-10-22T15:00:00Z", { from: null, to: null }],
    ["custom", "2026-10-22T15:00:00Z", { from: null, to: null }],
  ] as const)("presetRange(%s, %s)", (preset, iso, range) => {
    expect(presetRange(preset, new Date(iso))).toEqual(range);
  });

  it("usageQuery: без порожніх значень, дефолтний chat не передається", () => {
    expect(usageQuery({ range: { from: null, to: null }, source: "chat" })).toEqual({});
    expect(usageQuery({ range: { from: "2026-10-01", to: null }, source: "chat" })).toEqual({
      from: "2026-10-01",
    });
    expect(usageQuery({ range: { from: "2026-10-01", to: "2026-10-22" }, source: "eval" })).toEqual({
      from: "2026-10-01",
      to: "2026-10-22",
      source: "eval",
    });
    expect(usageQuery({ range: { from: null, to: "2026-10-22" }, source: "all" })).toEqual({
      to: "2026-10-22",
      source: "all",
    });
  });
});

describe("account-api.js — /api/admin/usage", () => {
  it("посилання на CSV — з параметрами без порожніх", () => {
    expect(accountApi.adminUsageCsvHref({})).toBe("/api/admin/usage/projects.csv");
    expect(accountApi.adminUsageCsvHref({ from: "2026-10-01", source: "eval", search: "" })).toBe(
      "/api/admin/usage/projects.csv?from=2026-10-01&source=eval",
    );
  });
});

describe("router.js — ?admin=usage", () => {
  it("розбирається й збирається назад", () => {
    expect(ADMIN_TABS).toContain("usage");
    const route = routeFromUrl(new URLSearchParams("admin=usage"));
    expect(route).toEqual({ route: "admin", tab: "usage" });
    expect(urlForRoute(route)).toBe("/?admin=usage");
    expect(stateForUrl(new URLSearchParams("admin=usage")).admin.tab).toBe("usage");
  });
});

describe("views/admin.js — вкладка «Використання»", () => {
  function mountAdmin(tab: UiState["admin"]["tab"]) {
    const host = document.createElement("div");
    document.body.append(host);
    const s = accountFixture({ route: "admin", account: { me: ADMIN_ME } });
    const store = createStore<UiState>({ ...s, admin: { ...s.admin, tab } });
    const view = mount(host, { store, actions: createDevActions(store) });
    store.subscribe((next, prev) => view.update(next, prev));
    return { host, store, view };
  }

  it("є вкладка без лічильника; при першому показі монтується вигляд вкладки", () => {
    const { host, store, view } = mountAdmin("users");
    const tab = [...host.querySelectorAll<HTMLElement>('[role="tab"]')].find(
      (t) => t.dataset.tab === "usage",
    );
    expect(tab?.textContent).toBe("Використання");
    const section = host.querySelector<HTMLElement>(".adm-usage");
    expect(section?.hidden).toBe(true);
    store.setState((st) => ({ admin: { ...st.admin, tab: "usage" } }));
    expect(section?.hidden).toBe(false);
    expect(section?.querySelector(".adu")).not.toBeNull();
    expect(host.querySelector<HTMLElement>(".adm-users")?.hidden).toBe(true);
    view.destroy();
    expect(host.children.length).toBe(0);
  });
});
