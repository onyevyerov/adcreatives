// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableCSSFileLoading":true,"handleDisabledFileLoadingAsSuccess":true}}
/**
 * B10 · Інтеграція: справжній index.html + app.js + шар даних у режимі `?mock=1`.
 * Повний прохід від старту до «Готово», ревізія після видачі, помилка й «Спробувати ще раз».
 * Крок 0 акаунтів: у mock-режимі акаунт фейковий (Олена, 12) і мережі немає зовсім; переходи
 * між маршрутами зупиняють і відновлюють потік проєкту.
 * Таймери mock-бекенду — фейкові, тож тест іде за мілісекунди реального часу.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { boot } from "../../public/static/js/app.js";
import type { UiState } from "../../public/static/js/contracts.js";
import { DEFAULT_PUBLIC_DIR } from "../../src/config.ts";

type App = Awaited<ReturnType<typeof boot>>;

/** Розмітка <body> справжнього index.html (у тесті innerHTML дозволено; у public — ні). */
function mountIndexHtml() {
  const html = readFileSync(path.join(DEFAULT_PUBLIC_DIR, "index.html"), "utf8");
  const body = /<body>([\s\S]*)<\/body>/.exec(html)?.[1];
  if (!body) throw new Error("index.html без <body>");
  document.body.innerHTML = body;
}

function $<T extends Element = HTMLElement>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`немає ${selector}`);
  return el;
}

/** Крутить фейкові таймери, доки `pred` не стане істинним. */
async function until(app: App, pred: (s: UiState) => boolean, label: string, maxMs = 300_000) {
  for (let t = 0; t <= maxMs; t += 100) {
    if (pred(app.store.getState())) return;
    await vi.advanceTimersByTimeAsync(100);
  }
  const s = app.store.getState();
  throw new Error(`не дочекались «${label}»: status=${s.status} rev=${s.rev}`);
}

/** Клік по кнопці, яка має бути активною. */
function click(selector: string) {
  const btn = $<HTMLButtonElement>(selector);
  expect(btn.disabled, `${selector} disabled`).toBe(false);
  btn.click();
}

/** Видача ревізії `rev` завершена: обидва відео і підсумок витрат (вони йдуть після state). */
const delivered = (s: UiState, rev: number) =>
  s.status === "delivered" &&
  s.rev === rev &&
  s.artifacts.videos.filter((v) => v.rev === rev).length === 2 &&
  s.breakdown !== null &&
  s.feed.at(-1)?.kind === "message";

/** Екран сцени: `data-view` або клас кореня. */
const stage = () => $("#stage").firstElementChild;

/** Повідомлення з композера: введення → submit форми. */
async function compose(text: string) {
  const input = $<HTMLTextAreaElement>(".ch-composer__input");
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  $<HTMLFormElement>(".ch-composer").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await vi.advanceTimersByTimeAsync(0);
}

let app: App | null = null;
const errors = vi.spyOn(console, "error");
/** У mock-режимі мережі немає: будь-який fetch — помилка тесту. */
const network = vi.fn(async (url: string) => {
  throw new Error(`fetch у mock-режимі: ${url}`);
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  vi.stubGlobal("fetch", network);
  history.replaceState(null, "", "/");
  mountIndexHtml();
});

afterEach(() => {
  app?.destroy();
  app = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.textContent = "";
  errors.mockClear();
  network.mockClear();
});

describe("повний прохід у ?mock=1", () => {
  it("старт → бренд-кіт → тексти → розкадровка → готово → ревізія 2", async () => {
    app = await boot({ params: new URLSearchParams("mock=1&speed=10") });
    const a = app;

    // Старт; акаунт — фейковий me без мережі.
    expect($("#app").dataset.route).toBe("start");
    expect($("#workspace").hidden).toBe(true);
    await until(a, (s) => s.account.meStatus === "ready", "me");
    expect(a.store.getState().account.me).toMatchObject({ balance: 12, user: { name: "Олена Коваль" } });
    const url = $<HTMLInputElement>('#start input[name="url"]');
    url.value = "zerno.example.com";
    url.dispatchEvent(new Event("input", { bubbles: true }));
    $<HTMLFormElement>(".st-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await until(a, (s) => s.route === "project", "робочий простір");
    expect(location.search).toContain("project=");
    expect($("#start").hidden).toBe(true);
    expect($("#workspace").hidden).toBe(false);
    expect($("#chat").textContent).toContain("zerno.example.com");

    // Робочі стани до чекпоінта 1.
    await until(a, (s) => s.status === "crawling", "crawling");
    expect(stage()?.getAttribute("data-view")).toBe("progress");
    expect($("#topbar").textContent).toContain("сканую сайт");

    // Чекпоінт 1 — бренд-кіт.
    await until(
      a,
      (s) => s.status === "awaiting_brand" && s.checkpoints.brand?.state === "open",
      "чекпоінт 1",
    );
    expect(stage()?.classList.contains("cb")).toBe(true);
    expect($("#stage").textContent).toContain("Зерно");
    expect($("#chat").textContent).toContain("Чекпоінт 1");
    click("#stage .cb-approve");

    // Чекпоінт 2 — тексти.
    await until(
      a,
      (s) => s.status === "awaiting_script" && s.checkpoints.script?.state === "open",
      "чекпоінт 2",
    );
    expect(a.store.getState().checkpoints.brand?.state).toBe("approved");
    expect(stage()?.classList.contains("cs")).toBe(true);
    click("#stage .cs-approve");

    // Чекпоінт 3 — розкадровка.
    await until(a, (s) => s.status === "directing", "directing");
    expect(stage()?.getAttribute("data-view")).toBe("progress");
    await until(
      a,
      (s) => s.status === "awaiting_storyboard" && s.checkpoints.storyboard?.state === "open",
      "чекпоінт 3",
    );
    expect(stage()?.classList.contains("cd")).toBe(true);
    expect(document.querySelectorAll("#stage .cd-scene").length).toBe(3);
    expect(document.querySelector("#stage audio")).not.toBeNull();
    click("#stage .cd-approve");

    // Рендер → готово.
    await until(a, (s) => s.status === "rendering", "rendering");
    await until(a, (s) => delivered(s, 1), "delivered");
    expect(stage()?.classList.contains("dn")).toBe(true);
    const video = $<HTMLVideoElement>("#stage video");
    expect(video.getAttribute("src")).toContain("sample.mp4");
    expect($(".dn-eyebrow").textContent).toBe("Готово · ревізія 1");
    expect(document.querySelectorAll("#stage a[download]").length).toBe(3); // 9:16, 1:1, постер
    expect($("#topbar").textContent).toContain("готово");
    const total = a.store.getState().totalUsd;
    expect(total).toBeGreaterThan(0);
    expect($(".dn-cost--total").textContent).toContain(`$${total.toFixed(2)}`);

    // Перемикання формату не перестворює <video>.
    click('#stage .dn-format[data-format="square"]');
    await vi.advanceTimersByTimeAsync(0);
    expect(a.store.getState().ui.doneFormat).toBe("square");
    expect($("#stage video")).toBe(video);
    expect(video.getAttribute("src")).toContain("sample-1x1.mp4");

    // Ревізія після видачі: повідомлення → revising → чекпоінт 3 (ревізія 2) → готово.
    await compose("Зроби заголовок першої сцени коротшим");
    expect($("#chat").textContent).toContain("Зроби заголовок першої сцени коротшим");
    await until(a, (s) => s.status === "revising", "revising");
    expect($("#stage").textContent).toContain("Вношу правки");
    // Подія checkpoint іде після state, тож чекаємо саме payload ревізії 2.
    await until(
      a,
      (s) => s.status === "awaiting_storyboard" && s.checkpoints.storyboard?.rev === 2,
      "чекпоінт 3, ревізія 2",
    );
    expect($("#stage").textContent).toContain("змінено");
    click("#stage .cd-approve");
    await until(a, (s) => delivered(s, 2), "готово, ревізія 2");
    expect($(".dn-eyebrow").textContent).toBe("Готово · ревізія 2");
    expect(new Set(a.store.getState().artifacts.videos.map((v) => v.rev))).toEqual(new Set([1, 2]));
    expect($<HTMLVideoElement>("#stage video").getAttribute("src")).toContain("rev=2");

    // Новий проєкт → старт; акаунт лишається.
    click("#topbar .btn--ghost");
    await vi.advanceTimersByTimeAsync(0);
    expect($("#app").dataset.route).toBe("start");
    expect(a.store.getState().account.meStatus).toBe("ready");
    expect(network).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
  });

  it("помилка на етапі сцен → «Спробувати ще раз» → чекпоінт 3", async () => {
    app = await boot({ params: new URLSearchParams("mock=1&speed=10&jump=script&fail=1") });
    const a = app;
    await until(
      a,
      (s) => s.status === "awaiting_script" && s.checkpoints.script?.state === "open",
      "чекпоінт 2",
    );
    click("#stage .cs-approve");
    await until(a, (s) => s.status === "failed", "failed");
    expect(stage()?.getAttribute("data-view")).toBe("failed");
    expect($("#stage").textContent).toContain("не відповіла вчасно");
    expect($("#chat").textContent).toContain("не відповіла вчасно");
    click('#stage [data-action="retry"]');
    await until(a, (s) => s.status === "directing", "directing після retry");
    expect(a.store.getState().error).toBeNull();
    await until(a, (s) => s.status === "awaiting_storyboard", "чекпоінт 3");
    expect(stage()?.classList.contains("cd")).toBe(true);
    expect(errors).not.toHaveBeenCalled();
  });

  it("?jump=delivered одразу показує «Готово»", async () => {
    app = await boot({ params: new URLSearchParams("mock=1&jump=delivered") });
    await until(app, (s) => delivered(s, 1), "delivered");
    expect(stage()?.classList.contains("dn")).toBe(true);
    expect(document.querySelectorAll("#stage .dn-scrub__seg").length).toBe(3);
    expect(errors).not.toHaveBeenCalled();
  });

  it("проєкт → кабінет → «назад» у браузері: потік зупиняється і відновлюється", async () => {
    app = await boot({ params: new URLSearchParams("mock=1&speed=10&jump=delivered") });
    const a = app;
    await until(a, (s) => delivered(s, 1) && s.account.meStatus === "ready", "delivered");
    a.actions.navigate({ route: "cabinet", section: "balance" });
    expect(location.search).toBe("?mock=1&speed=10&cabinet=balance");
    expect($("#app").dataset.route).toBe("cabinet");
    expect($("#workspace").hidden).toBe(true);
    expect($("#cabinet").hidden).toBe(false);
    expect($("#stage").childNodes.length).toBe(0);
    // Потік стоїть: таймери mock-бекенду не міняють стан.
    const parked = a.store.getState();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(a.store.getState().feed).toBe(parked.feed);

    history.replaceState(null, "", "/?mock=1&speed=10&project=p1");
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect($("#app").dataset.route).toBe("project");
    expect($("#cab-main").childNodes.length).toBe(0);
    await until(a, (s) => s.status === "awaiting_brand", "потік відновлено");
    expect(stage()?.classList.contains("cb")).toBe(true);
    expect(network).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
  });
});

describe("безпека статики", () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const p = path.join(dir, name);
      return statSync(p).isDirectory() ? files(p) : [p];
    });
  const sources = files(DEFAULT_PUBLIC_DIR).filter((f) => /\.(js|html|css)$/.test(f));

  it("немає innerHTML, eval, new Function і інлайнових on*-атрибутів", () => {
    expect(sources.length).toBeGreaterThan(20);
    for (const f of sources) {
      const src = readFileSync(f, "utf8");
      const rel = path.relative(DEFAULT_PUBLIC_DIR, f);
      expect(src, rel).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
      expect(src, rel).not.toMatch(/\beval\s*\(|new Function\s*\(/);
      if (f.endsWith(".html")) expect(src, rel).not.toMatch(/<[^>]+\son[a-z]+\s*=/i);
    }
  });
});
