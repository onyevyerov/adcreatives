// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDevActions } from "../../public/static/dev/dev-actions.js";
import { segments } from "../../public/static/dev/fixture-events.js";
import { fixtureStates } from "../../public/static/dev/fixture-states.js";
import type { UiState } from "../../public/static/js/contracts.js";
import { reduce, reduceAll } from "../../public/static/js/data/reduce.js";
import { initialState } from "../../public/static/js/initial.js";
import { createStore } from "../../public/static/js/store.js";
import * as failed from "../../public/static/js/views/failed.js";
import * as sp from "../../public/static/js/views/stage-progress.js";
import { DEFAULT_PUBLIC_DIR } from "../../src/config.ts";

const STATIC_DIR = path.join(DEFAULT_PUBLIC_DIR, "static");

function fixture(name: string): UiState {
  const s = fixtureStates[name];
  if (!s) throw new Error(`немає фікстури ${name}`);
  return s;
}

type StoredEvent = (typeof segments.toStoryboard)[number];

/** Стан після подій сегмента до першої (включно), що задовольняє `pred`. */
function playUntil(base: UiState, events: StoredEvent[], pred: (e: StoredEvent["event"]) => boolean) {
  const i = events.findIndex((e) => pred(e.event));
  if (i < 0) throw new Error("подію не знайдено");
  return reduceAll(base, events.slice(0, i + 1));
}

const byLabel = (label: string) => (e: StoredEvent["event"]) => e.type === "progress" && e.label === label;

let seq = 0;
/** Подія progress через справжній редьюсер. */
function progress(
  s: UiState,
  stage: string,
  label: string,
  done: number | null = null,
  total: number | null = null,
) {
  seq += 1;
  // Час — після останньої події стану (фікстура має власний годинник, не Date.now()).
  const last = Math.max(0, ...s.feed.map((i) => Date.parse(i.at)), s.busySince ? Date.parse(s.busySince) : 0);
  return reduce(
    s,
    // biome-ignore lint/suspicious/noExplicitAny: stage — CostStage, у тесті довільний рядок зі схеми
    { type: "progress", stage: stage as any, label, done, total, at: new Date(last + 1000).toISOString() },
    `t-${seq}`,
  );
}

describe("views/stage-progress.js", () => {
  let host: HTMLElement;
  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
  });
  afterEach(() => {
    document.body.textContent = "";
  });

  function mountWith(state: UiState, mount = sp.mount) {
    const store = createStore(state);
    const actions = createDevActions(store);
    const view = mount(host, { store, actions });
    store.subscribe((s, prev) => view.update(s, prev));
    return { store, actions, view };
  }

  const q = (sel: string) => host.querySelector<HTMLElement>(sel);
  const qa = (sel: string) => [...host.querySelectorAll<HTMLElement>(sel)];
  const barValue = (el: HTMLElement | null) => Number(el?.style.getPropertyValue("--bar-value"));

  it("intake: eyebrow «01 — Сайт», заголовок з пульсуючою крапкою, хост і рядок очікування", () => {
    const { view } = mountWith({ ...initialState("project", "p1"), site: "zerno.example.com" });
    expect(q(".sp")?.dataset.status).toBe("intake");
    expect(q(".sp-eyebrow")?.textContent).toBe("01 — Сайт");
    expect(q(".sp-eyebrow")?.classList.contains("eyebrow")).toBe(true);
    const title = q("h1.sp-title");
    expect(title?.classList.contains("display-l")).toBe(true);
    expect(q(".sp-title__text")?.textContent).toBe("Приймаю проєкт");
    const dot = q("h1 .sp-pulse");
    expect(dot?.classList.contains("accent-dot")).toBe(true);
    expect(dot?.getAttribute("aria-hidden")).toBe("true");
    expect(q(".sp-host")?.textContent).toBe("zerno.example.com");
    expect(q(".sp-host")?.classList.contains("display-m")).toBe(true);
    expect(qa(".sp-log__row")).toHaveLength(1);
    expect(q(".sp-log__row .spinner")).not.toBeNull();
    view.destroy();
    expect(host.children.length).toBe(0);
  });

  it("crawling (X5): хост display-m, numeral done/total, смуга, мітка", () => {
    const { view } = mountWith(fixture("crawling"));
    expect(q(".sp-eyebrow")?.textContent).toBe("01 — Сайт");
    const title = q("h1.sp-title");
    expect(title?.classList.contains("display-m")).toBe(true);
    expect(title?.classList.contains("display-l")).toBe(false);
    expect(q(".sp-title__text")?.textContent).toBe("zerno.example.com");
    expect(q("h1 .sp-pulse")).not.toBeNull();
    const numeral = q(".sp-numeral");
    expect(numeral?.classList.contains("numeral")).toBe(true);
    expect(numeral?.textContent).toBe("4/7");
    expect(q(".sp-numeral .numeral__unit")?.textContent).toBe("/7");
    expect(barValue(q(".sp-bar"))).toBeCloseTo(4 / 7);
    expect(q(".sp-bar")?.classList.contains("bar")).toBe(true);
    expect(q(".sp-bar .bar__fill")).not.toBeNull();
    expect(q(".sp-caption")?.textContent).toBe("Сканую сайт… 4/7 сторінок · ліміт 120 с");
    view.destroy();
  });

  it("crawling без done/total: невідома смуга, без одиниці", () => {
    const { store, view } = mountWith(fixture("crawling"));
    store.setState({ progress: { stage: "crawl", label: "Сканую сайт…", done: null, total: null } });
    expect(q(".sp-numeral .numeral__unit")?.hidden).toBe(true);
    expect(q(".sp-bar")?.classList.contains("sp-bar--unknown")).toBe(true);
    view.destroy();
  });

  it("update не перестворює вузли при зміні лічильника", () => {
    const { store, view } = mountWith(fixture("crawling"));
    const root = q(".sp");
    const numeral = q(".sp-numeral");
    const bar = q(".sp-bar");
    const caption = q(".sp-caption");
    const title = q("h1");
    store.setState((s) => progress(s, "crawl", "Сканую сайт… 5/7 сторінок", 5, 7));
    expect(q(".sp")).toBe(root);
    expect(q(".sp-numeral")).toBe(numeral);
    expect(q(".sp-bar")).toBe(bar);
    expect(q(".sp-caption")).toBe(caption);
    expect(q("h1")).toBe(title);
    expect(numeral?.textContent).toBe("5/7");
    expect(barValue(bar)).toBeCloseTo(5 / 7);
    expect(caption?.textContent).toContain("5/7 сторінок");
    view.destroy();
  });

  it("brandkit: eyebrow «02 — Бренд-кіт», остання мітка зі спінером", () => {
    const { view } = mountWith(fixture("brandkit"));
    expect(q(".sp-eyebrow")?.textContent).toBe("02 — Бренд-кіт");
    expect(q(".sp-title__text")?.textContent).toBe("Збираю бренд-кіт");
    const rows = qa(".sp-log__row");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain("Збираю бренд-кіт…");
    expect(rows[0]?.dataset.state).toBe("active");
    expect(rows[0]?.querySelector(".spinner")).not.toBeNull();
    view.destroy();
  });

  it("stageLog: попередні з ✓, остання зі спінером; нова мітка додає рядок, старі вузли лишаються", () => {
    const base = { ...fixture("brandkit"), status: "scripting" as const, stageLog: [], progress: null };
    const { store, view } = mountWith(base);
    expect(q(".sp-eyebrow")?.textContent).toBe("03 — Сценарій");
    expect(q(".sp-title__text")?.textContent).toBe("Пишу сценарій");
    // До першого progress — рядок-заглушка зі спінером.
    expect(qa(".sp-log__row")).toHaveLength(1);
    store.setState((s) => progress(s, "storyboard", "Пишу сценарій…"));
    store.setState((s) => progress(s, "storyboard", "Перевіряю факти…", 1, 3));
    const first = qa(".sp-log__row")[0];
    store.setState((s) => progress(s, "storyboard", "Оформлюю сцени…", 2, 3));
    const rows = qa(".sp-log__row");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toBe(first);
    expect(rows.map((r) => r.dataset.state)).toEqual(["done", "done", "active"]);
    expect(rows[0]?.querySelector(".sp-log__mark")?.textContent).toBe("✓");
    expect(rows[1]?.querySelector(".sp-log__mark")?.textContent).toBe("✓");
    expect(rows[2]?.querySelector(".spinner")).not.toBeNull();
    expect(rows[2]?.querySelector(".sp-log__count")?.textContent).toBe("2/3");
    expect(rows[0]?.querySelector(".sp-log__count")?.textContent).toBe("");
    view.destroy();
  });

  it("зміна статусу перебудовує лише тіло, корінь лишається", () => {
    const { store, view } = mountWith(fixture("brandkit"));
    const root = q(".sp");
    const body = q(".sp-body");
    store.setState({ status: "scripting", stageLog: [], progress: null });
    expect(q(".sp")).toBe(root);
    expect(q(".sp-body")).not.toBe(body);
    expect(q(".sp")?.dataset.status).toBe("scripting");
    expect(q(".sp-eyebrow")?.textContent).toBe("03 — Сценарій");
    view.destroy();
  });

  describe("directing — дві гілки", () => {
    const branch = (key: string) => q(`.sp-branch[data-branch="${key}"]`);
    const status = (key: string) => branch(key)?.querySelector(".sp-branch__status")?.textContent;
    const caption = (key: string) => branch(key)?.querySelector(".sp-caption")?.textContent;
    const bar = (key: string) => branch(key)?.querySelector<HTMLElement>(".sp-bar") ?? null;

    it("фікстура: сцени 2/3, музика пишеться", () => {
      const { view } = mountWith(fixture("directing"));
      expect(q(".sp-eyebrow")?.textContent).toBe("04 — Сцени і музика");
      expect(q(".sp-title__text")?.textContent).toBe("Генерую сцени і музику");
      expect(branch("scenes")?.querySelector("h2")?.textContent).toBe("Сцени");
      expect(branch("music")?.querySelector("h2")?.textContent).toBe("Музика");
      expect(branch("scenes")?.dataset.state).toBe("running");
      expect(status("scenes")).toBe("2/3");
      expect(barValue(bar("scenes"))).toBeCloseTo(2 / 3);
      expect(caption("scenes")).toBe("Генерую сцени… 2/3");
      expect(branch("music")?.dataset.state).toBe("running");
      expect(caption("music")).toBe("Пишу музику…");
      expect(bar("music")?.classList.contains("sp-bar--unknown")).toBe(true);
      view.destroy();
    });

    it("музика «готово» після progress audio done = total; сцени не скидаються, вузли ті самі", () => {
      const { store, view } = mountWith(fixture("directing"));
      const scenesEl = branch("scenes");
      const musicEl = branch("music");
      store.setState((s) => progress(s, "audio", "Музику записано", 1, 1));
      expect(branch("scenes")).toBe(scenesEl);
      expect(branch("music")).toBe(musicEl);
      expect(branch("music")?.dataset.state).toBe("done");
      expect(status("music")).toBe("готово");
      expect(barValue(bar("music"))).toBe(1);
      // `progress` тепер описує audio, але гілка «Сцени» тримає свій останній стан.
      expect(status("scenes")).toBe("2/3");
      store.setState((s) => progress(s, "codegen", "Генерую сцени… 3/3", 3, 3));
      expect(status("scenes")).toBe("3/3");
      expect(status("music")).toBe("готово");
      store.setState((s) => progress(s, "check", "Знімаю кадри сцен… 2/6", 2, 6));
      expect(caption("scenes")).toBe("Знімаю кадри сцен… 2/6");
      expect(status("scenes")).toBe("2/6");
      store.setState((s) => progress(s, "qa", "Перевіряю кадри…"));
      expect(caption("scenes")).toBe("Перевіряю кадри…");
      // Без лічильника смуга лишається на останньому відомому значенні гілки.
      expect(barValue(bar("scenes"))).toBeCloseTo(2 / 6);
      view.destroy();
    });

    it("музика «готово» за artifact music", () => {
      const { store, view } = mountWith(fixture("directing"));
      const s = store.getState();
      // Останній audio-рядок ще не done = total, тож без артефакту — пишеться.
      expect(branch("music")?.dataset.state).toBe("running");
      const noAudio = { ...s, feed: s.feed.filter((i) => !(i.kind === "progress" && i.stage === "audio")) };
      store.setState({ feed: noAudio.feed });
      expect(branch("music")?.dataset.state).toBe("pending");
      store.setState({ artifacts: { ...s.artifacts, music: "/files/p1/music.mp3" } });
      expect(branch("music")?.dataset.state).toBe("done");
      expect(status("music")).toBe("готово");
      view.destroy();
    });

    it("справжня послідовність фікстури через reduce: гілки в кожній точці", () => {
      const base = fixture("awaitingScript");
      const events = segments.toStoryboard;
      const at = (label: string) => sp.directingBranches(playUntil(base, events, byLabel(label)));

      let b = at("Генерую сцени і музику…");
      expect(b.scenes.state).toBe("running");
      expect(b.music.state).toBe("pending");

      b = at("Пишу музику…");
      expect(b.scenes.label).toBe("Генерую сцени і музику…");
      expect(b.music).toMatchObject({ state: "running", label: "Пишу музику…" });

      b = at("Генерую сцени… 1/3");
      expect(b.scenes).toMatchObject({ done: 1, total: 3 });
      expect(b.music.state).toBe("running");

      b = at("Музику записано");
      expect(b.scenes).toMatchObject({ done: 2, total: 3 });
      expect(b.music.state).toBe("done");

      b = at("Знімаю кадри сцен… 4/6");
      expect(b.scenes).toMatchObject({ state: "running", done: 4, total: 6 });
      expect(b.music.state).toBe("done");
    });

    it("гілки рахуються лише в поточному busy-стані (повтор після помилки)", () => {
      const failedState = fixture("failed");
      // До retry: у стрічці є рядки directing з невдалої спроби.
      const afterRetry = reduceAll(failedState, segments.retry.slice(0, 3));
      expect(afterRetry.status).toBe("directing");
      const b = sp.directingBranches(afterRetry);
      expect(b.scenes.label).toBe("Генерую сцени і музику…");
      expect(b.music.state).toBe("pending");
    });

    it("ревізія без audio: музика з чекпоінта 3 — «без змін»", () => {
      const base = fixture("revising");
      const s = reduceAll(
        base,
        segments.revisionAfterDelivery.filter((e) => e.event.type === "state").slice(1, 2),
      );
      expect(s.status).toBe("directing");
      expect(s.prevStatus).toBe("revising");
      expect(sp.directingBranches(s).music.state).toBe("kept");
    });
  });

  describe("rendering", () => {
    it("фікстура: 50%, смуга, «9:16 · 1080×1920 · h264 · формат 1 з 2»", () => {
      const { view } = mountWith(fixture("rendering"));
      expect(q(".sp-eyebrow")?.textContent).toBe("05 — Рендер");
      expect(q(".sp-numeral")?.textContent).toBe("50%");
      expect(q(".sp-numeral .numeral__unit")?.textContent).toBe("%");
      expect(barValue(q(".sp-bar"))).toBeCloseTo(0.5);
      expect(q(".sp-caption")?.textContent).toBe("9:16 · 1080×1920 · h264 · формат 1 з 2");
      view.destroy();
    });

    it("другий формат: відсоток, розмір і номер оновлюються на місці", () => {
      const { store, view } = mountWith(fixture("rendering"));
      const numeral = q(".sp-numeral");
      store.setState((s) => progress(s, "render", "Рендерю 9:16… 100%", 100, 100));
      expect(numeral?.textContent).toBe("100%");
      store.setState((s) => progress(s, "render", "Рендерю 1:1… 25%", 25, 100));
      expect(q(".sp-numeral")).toBe(numeral);
      expect(numeral?.textContent).toBe("25%");
      expect(q(".sp-caption")?.textContent).toBe("1:1 · 1080×1080 · h264 · формат 2 з 2");
      view.destroy();
    });

    it("старт рендеру (мітка з усіма форматами) — 0%, формат 1", () => {
      const s = reduce(
        { ...fixture("awaitingStoryboard"), status: "rendering", stageLog: [], progress: null },
        {
          type: "progress",
          stage: "render",
          label: "Рендерю відео (9:16, 1:1, 16:9)…",
          done: null,
          total: null,
          at: new Date().toISOString(),
        },
        "r-0",
      );
      expect(sp.renderInfo(s)).toEqual({ format: "vertical", index: 0, count: 3, percent: 0 });
      const t = progress(s, "render", "Рендерю 16:9… 40%", 40, 100);
      expect(sp.renderInfo(t)).toEqual({ format: "landscape", index: 2, count: 3, percent: 40 });
    });

    it("без мітки старту — формати з чекпоінта 3 (primaryFormat + sheets)", () => {
      const s = {
        ...fixture("rendering"),
        stageLog: [],
        ui: { ...fixture("rendering").ui, pendingFormats: null },
      };
      expect(sp.renderFormatList(s)).toEqual(["vertical", "square"]);
    });
  });

  it("revising: «Вношу правки» і цитата останнього повідомлення клієнта", () => {
    const { store, view } = mountWith(fixture("revising"));
    expect(q(".sp-title__text")?.textContent).toBe("Вношу правки");
    expect(q(".sp-eyebrow")?.textContent).toBe("06 — Готово");
    const quote = q("blockquote.sp-quote");
    expect(quote?.hidden).toBe(false);
    expect(q(".sp-quote__text")?.textContent).toBe("Зроби заголовок першої сцени коротшим");
    expect(qa(".sp-log__row").at(-1)?.textContent).toContain("Вношу правки…");
    // Нове повідомлення клієнта — цитата оновлюється, вузол той самий.
    const s = store.getState();
    store.setState({
      feed: [
        ...s.feed,
        {
          kind: "message",
          id: "u-2",
          at: new Date().toISOString(),
          role: "user",
          text: "І музику тихіше\nбудь ласка",
          buttons: [],
        },
      ],
    });
    expect(q("blockquote.sp-quote")).toBe(quote);
    expect(q(".sp-quote__text")?.textContent).toBe("І музику тихішебудь ласка");
    expect(q(".sp-quote__text br")).not.toBeNull();
    view.destroy();
  });

  it("revising без повідомлення клієнта — цитата схована", () => {
    const s = fixture("revising");
    const { view } = mountWith({
      ...s,
      feed: s.feed.filter((i) => !(i.kind === "message" && i.role === "user")),
    });
    expect(q("blockquote.sp-quote")?.hidden).toBe(true);
    view.destroy();
  });
});

describe("views/failed.js (X4)", () => {
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
    const view = failed.mount(host, { store, actions });
    store.subscribe((s, prev) => view.update(s, prev));
    return { store, actions, view };
  }
  const q = (sel: string) => host.querySelector<HTMLElement>(sel);

  it("eyebrow з етапом, заголовок, лід з ErrorEvent.message", () => {
    const { view } = mountWith(fixture("failed"));
    const eyebrow = q(".sp-failed__eyebrow");
    expect(eyebrow?.textContent).toBe("Помилка · етап codegen");
    expect(eyebrow?.querySelector(".dot.dot--danger")).not.toBeNull();
    const h1 = q("h1");
    expect(h1?.textContent).toBe("Щось пішло не так");
    expect(h1?.classList.contains("display-l")).toBe(true);
    expect(q(".sp-failed__lead")?.textContent).toBe(
      "Модель не відповіла вчасно. Повідомлення, які ви надішлете зараз, я збережу й врахую на наступному погодженні.",
    );
    view.destroy();
    expect(host.children.length).toBe(0);
  });

  it("«Спробувати ще раз» → retry, «Новий проєкт» → newProject", async () => {
    const { actions, view } = mountWith(fixture("failed"));
    const retry = q('button[data-action="retry"]') as HTMLButtonElement;
    expect(retry.textContent).toBe("Спробувати ще раз");
    expect(retry.className).toBe("btn btn--primary");
    const spy = vi.spyOn(actions, "retry");
    retry.click();
    expect(retry.disabled).toBe(true);
    retry.click(); // повторний клік під час запиту ігнорується
    await Promise.resolve();
    await Promise.resolve();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(retry.disabled).toBe(false);
    const fresh = q('button[data-action="new-project"]') as HTMLButtonElement;
    expect(fresh.textContent).toBe("Новий проєкт");
    expect(fresh.className).toBe("btn btn--ghost");
    fresh.click();
    expect(actions.calls.map((c) => c.name)).toEqual(["retry", "newProject"]);
    view.destroy();
  });

  it("неповторна помилка: без «Спробувати ще раз», «Новий проєкт» — primary", () => {
    const s = fixture("failed");
    const { store, view } = mountWith({
      ...s,
      error: { stage: null, message: "сайт недоступний", retryable: false },
    });
    expect(q('button[data-action="retry"]')?.hidden).toBe(true);
    expect(q('button[data-action="new-project"]')?.className).toBe("btn btn--primary");
    expect(q(".sp-failed__eyebrow")?.textContent).toBe("Помилка");
    expect(q(".sp-failed__message")?.textContent).toBe("Сайт недоступний.");
    store.setState({ error: { stage: "render", message: "Таймаут!", retryable: true } });
    expect(q('button[data-action="retry"]')?.hidden).toBe(false);
    expect(q(".sp-failed__eyebrow")?.textContent).toBe("Помилка · етап render");
    expect(q(".sp-failed__message")?.textContent).toBe("Таймаут!");
    view.destroy();
  });

  it("без state.error — запасний текст, кнопка повтору є", () => {
    const { view } = mountWith({ ...fixture("failed"), error: null });
    expect(q(".sp-failed__message")?.textContent).toBe("Етап завершився з помилкою.");
    expect(q('button[data-action="retry"]')?.hidden).toBe(false);
    view.destroy();
  });
});

describe("безпека і рух", () => {
  const files = ["js/views/stage-progress.js", "js/views/failed.js"].map((f) =>
    readFileSync(path.join(STATIC_DIR, f), "utf8"),
  );

  it("без innerHTML, eval та інлайнових on*-атрибутів", () => {
    for (const src of files) {
      expect(src).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|\beval\(|new Function/);
      expect(src).not.toMatch(/setAttribute\(\s*["']on/);
    }
  });

  it("CSS: префікс .sp-, анімації поважають prefers-reduced-motion", () => {
    const css = readFileSync(path.join(STATIC_DIR, "css", "stage-progress.css"), "utf8");
    const classes = [...css.matchAll(/(?<![\w-])\.([a-z][\w-]*)/g)].map((m) => m[1] ?? "");
    const foreign = classes.filter((c) => !c.startsWith("sp-") && c !== "sp" && c !== "bar__fill");
    expect(foreign).toEqual([]);
    // Нескінченні анімації — лише adc-* (вимикаються в base.css) або власні з блоком reduced-motion.
    const own = [...css.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]);
    expect(own).toEqual(["sp-indeterminate"]);
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*sp-bar--unknown[\s\S]*animation: none/,
    );
    expect(css).toMatch(/\.sp-pulse\s*\{[^}]*animation: adc-pulse/);
  });
});
