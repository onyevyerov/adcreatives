// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDevActions } from "../../public/static/dev/dev-actions.js";
import { brandPayload } from "../../public/static/dev/fixture-events.js";
import { fixtureStates } from "../../public/static/dev/fixture-states.js";
import type { BrandCheckpointPayload, UiState } from "../../public/static/js/contracts.js";
import { createStore } from "../../public/static/js/store.js";
import {
  contrast,
  googleFontsHref,
  hexColor,
  linkUrl,
  mediaUrl,
  mount,
  NEED_MORE_PHOTOS,
  selectedFormats,
  textOn,
  toggleFormat,
} from "../../public/static/js/views/cp-brand.js";

type Kit = BrandCheckpointPayload["brandkit"];

function awaitingBrand(): UiState {
  const s = fixtureStates.awaitingBrand;
  if (!s) throw new Error("немає фікстури awaitingBrand");
  return s;
}

/** Стан awaiting_brand з підміненим payload / бренд-кітом. */
function withPayload(patch: Partial<BrandCheckpointPayload> = {}, kit: Partial<Kit> = {}): UiState {
  const s = awaitingBrand();
  const entry = s.checkpoints.brand;
  if (!entry) throw new Error("немає checkpoints.brand");
  const payload: BrandCheckpointPayload = {
    ...brandPayload,
    ...patch,
    brandkit: { ...brandPayload.brandkit, ...kit },
  };
  return { ...s, checkpoints: { ...s.checkpoints, brand: { ...entry, payload } } };
}

const cleanups: Array<() => void> = [];

// <link> Google Fonts у тестах не завантажуємо (мережі немає).
type HappySettings = { disableCSSFileLoading: boolean; handleDisabledFileLoadingAsSuccess: boolean };
const happy = (globalThis as unknown as { window: { happyDOM?: { settings: HappySettings } } }).window
  .happyDOM;
if (happy) {
  happy.settings.disableCSSFileLoading = true;
  happy.settings.handleDisabledFileLoadingAsSuccess = true;
}

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
  document.body.textContent = "";
  for (const link of document.head.querySelectorAll("link[data-cb-font]")) link.remove();
  vi.restoreAllMocks();
});

function setup(state: UiState = awaitingBrand()) {
  const el = document.createElement("main");
  el.id = "stage";
  document.body.append(el);
  const store = createStore(state);
  const actions = createDevActions(store);
  const view = mount(el, { store, actions });
  const off = store.subscribe((s, prev) => view.update(s, prev));
  cleanups.push(() => {
    off();
    view.destroy();
  });
  const $ = <T extends Element = HTMLElement>(sel: string) => {
    const node = el.querySelector<T>(sel);
    if (!node) throw new Error(`немає ${sel}`);
    return node;
  };
  const $$ = <T extends Element = HTMLElement>(sel: string) => [...el.querySelectorAll<T>(sel)];
  const called = (name: string) => actions.calls.filter((c) => c.name === name).map((c) => c.args);
  return { el, store, actions, view, $, $$, called };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const pressed = (nodes: HTMLElement[]) =>
  nodes.filter((n) => n.getAttribute("aria-pressed") === "true").map((n) => n.textContent);

describe("cp-brand · рендер payload фікстури (S2)", () => {
  it("шапка: eyebrow з ромбом і ревізією, «Правки» і «Затвердити →» активні", () => {
    const { $ } = setup();
    expect($(".cb-eyebrow").classList.contains("eyebrow")).toBe(true);
    expect($(".cb-eyebrow").textContent).toBe("Чекпоінт 1 / 3 · Бренд-кіт · ревізія 1");
    expect($(".cb-eyebrow .diamond").className).toBe("diamond diamond--open diamond--ring");
    const edit = $<HTMLButtonElement>(".cb-edit");
    const approve = $<HTMLButtonElement>(".cb-approve");
    expect(edit.className).toContain("btn--ghost");
    expect(edit.textContent).toBe("Правки");
    expect(approve.className).toContain("btn--primary");
    expect(approve.textContent).toBe("Затвердити→");
    expect(edit.disabled).toBe(false);
    expect(approve.disabled).toBe(false);
  });

  it("ідентичність: назва display-brand, tagline, мета з confidence у %", () => {
    const { $ } = setup();
    expect($(".cb-name").classList.contains("display-brand")).toBe(true);
    expect($(".cb-name").textContent).toBe("Зерно");
    expect($(".cb-tagline").textContent).toBe("Кава, яку обсмажуємо самі");
    expect($(".cb-meta").textContent).toBe("кав'ярня · Львів · UK / EN · впевненість 80%");
  });

  it("рядки spec-row у порядку ТЗ", () => {
    const { $$ } = setup();
    const rows = $$(".spec-row");
    expect(rows.map((r) => r.dataset.row)).toEqual([
      "palette",
      "fonts",
      "logo",
      "voice",
      "services",
      "facts",
      "geo",
      "photos",
    ]);
    expect(rows.map((r) => r.querySelector(".spec-row__label")?.textContent)).toEqual([
      "Палітра",
      "Шрифти",
      "Лого",
      "Голос",
      "Послуги",
      "Факти",
      "Гео",
      "Фото",
    ]);
  });

  it("палітра: 5 свотчів з hex усередині, текст — textOnDark/textOnLight за контрастом; нижче текстові кольори", () => {
    const { $$ } = setup();
    const swatches = $$(".cb-swatch");
    expect(swatches.map((s) => s.querySelector(".cb-swatch__hex")?.textContent)).toEqual([
      "#6B3E26",
      "#C89F7A",
      "#E85D2A",
      "#FFF8F0",
      "#F3E6D8",
    ]);
    const byKey = Object.fromEntries(swatches.map((s) => [s.dataset.key, s]));
    expect(byKey.primary?.style.getPropertyValue("background")).toMatch(/#6B3E26|rgb\(107, 62, 38\)/i);
    expect(byKey.primary?.style.getPropertyValue("color")).toMatch(/#FFFFFF|rgb\(255, 255, 255\)/i);
    expect(byKey.background?.style.getPropertyValue("color")).toMatch(/#1E1410|rgb\(30, 20, 16\)/i);
    const textColors = $$(".cb-textcolor").map((n) => n.textContent);
    expect(textColors).toEqual(["Текст на темному#FFFFFF", "Текст на світлому#1E1410"]);
  });

  it("шрифти: «Аа» шрифтом бренду", () => {
    const { $ } = setup();
    const heading = $('.cb-font[data-role="heading"] .cb-font__sample');
    const body = $('.cb-font[data-role="body"] .cb-font__sample');
    expect(heading.textContent).toBe("Аа");
    expect(heading.style.getPropertyValue("font-family")).toContain("Montserrat");
    expect(heading.style.getPropertyValue("font-weight")).toBe("800");
    expect(body.style.getPropertyValue("font-family")).toContain("Inter");
    expect($('.cb-font[data-role="heading"] .cb-font__family').textContent).toBe("Montserrat");
    expect($('.cb-font[data-role="heading"] .cb-font__meta').textContent).toBe(
      "Заголовки · 700, 800 · з сайту",
    );
  });

  it("лого: тайл кандидата, обраний — is-on і бейдж ✓", () => {
    const { $$ } = setup();
    const tiles = $$<HTMLButtonElement>(".cb-logo");
    expect(tiles).toHaveLength(1);
    const tile = tiles[0] as HTMLButtonElement;
    expect(tile.dataset.asset).toBe("a02");
    expect(tile.classList.contains("is-on")).toBe(true);
    expect(tile.getAttribute("aria-pressed")).toBe("true");
    expect(tile.querySelector(".cb-logo__badge")?.textContent).toBe("✓");
    expect(tile.querySelector("img")?.getAttribute("src")).toBe(brandPayload.logoCandidates[0]?.url);
  });

  it("голос, послуги, гео", () => {
    const { $ } = setup();
    expect($(".cb-row--voice .cb-lead").textContent).toBe("Говоримо як бариста з постійним гостем.");
    expect($(".cb-row--voice .cb-tags").textContent).toBe("теплий · дружній · розмовний");
    const services = [...$(".cb-services").children].map((li) => li.textContent);
    expect(services).toEqual(["Капучино75 грнСпешелті еспресо з молоком", "СніданкиДо 12:00"]);
    expect($(".cb-row--geo .cb-lead").textContent).toBe("Львів, вул. Руська, 1");
    expect($(".cb-row--geo .cb-sub").textContent).toBe("щодня 8:00–21:00");
  });

  it("факти: мітка «id · вид · сайт», цитата, посилання target=_blank rel=noopener noreferrer", () => {
    const { $$ } = setup();
    const facts = $$(".cb-fact");
    expect(facts.map((f) => f.dataset.fact)).toEqual(["f1", "f2"]);
    const f1 = facts[0] as HTMLElement;
    expect(f1.classList.contains("card")).toBe(true);
    expect(f1.querySelector(".cb-fact__label")?.textContent).toBe("f1 · ціна · сайт");
    expect(f1.querySelector(".cb-fact__text")?.textContent).toBe("Капучино — 75 грн");
    expect(f1.querySelector(".cb-fact__quote")?.textContent).toBe("«Капучино — 75 грн.»");
    const link = f1.querySelector("a") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("https://zerno.example.com/uk/");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.textContent).toBe("zerno.example.com/uk/ ↗");
  });

  it("факт від клієнта — «від вас», без посилання", () => {
    const { $ } = setup(
      withPayload(
        {},
        {
          facts: [
            {
              id: "c1",
              kind: "guarantee",
              text: "Повернемо гроші",
              source: "client",
              sourceUrl: null,
              quote: null,
            },
          ],
        },
      ),
    );
    expect($(".cb-fact__label").textContent).toBe("c1 · гарантія · від вас");
    expect($(".cb-fact").classList.contains("cb-fact--client")).toBe(true);
    expect($(".cb-fact").querySelector("a")).toBeNull();
  });

  it("фото: тайли photos + «Додати фото» з прихованим input[type=file]", () => {
    const { $, $$ } = setup();
    const photos = $$(".cb-photo:not(.cb-photo--add)");
    expect(photos.map((p) => p.dataset.asset)).toEqual(["a01"]);
    expect(photos[0]?.querySelector("img")?.getAttribute("src")).toBe(brandPayload.photos[0]?.url);
    expect($(".cb-photo--add").textContent).toContain("Додати фото");
    const input = $<HTMLInputElement>('.cb-photos input[type="file"]');
    expect(input.hidden).toBe(true);
    expect(input.multiple).toBe(true);
    expect(input.getAttribute("accept")).toBe("image/*,.heic,.heif");
  });

  it("панель «Ваші рішення»: без питань (навіть якщо вони є в старому кіті), формати C6, мова — сегмент", () => {
    const { $, $$ } = setup();
    expect($(".cb-decisions__title").textContent).toBe("Ваші рішення");
    expect($(".cb-decisions__title").classList.contains("display-s")).toBe(true);
    expect(brandPayload.brandkit.questions.length).toBeGreaterThan(0);
    expect($$("[data-question]")).toEqual([]);
    expect($$(".cb-decisions .chip")).toEqual([]);

    const tiles = $$(".cb-fmt");
    expect(tiles.map((t) => t.dataset.format)).toEqual(["vertical", "square", "landscape"]);
    expect(tiles.map((t) => t.querySelector(".cb-fmt__ratio")?.textContent)).toEqual(["9:16", "1:1", "16:9"]);
    expect(tiles.map((t) => t.querySelector(".cb-fmt__name")?.textContent)).toEqual([
      "Вертикальне",
      "Квадрат",
      "Горизонтальне",
    ]);
    expect(tiles.map((t) => t.getAttribute("aria-pressed"))).toEqual(["true", "false", "false"]);
    expect(tiles[0]?.classList.contains("is-on")).toBe(true);

    const langs = $$(".cb-lang");
    expect($(".cb-seg").classList.contains("seg")).toBe(true);
    expect(langs.map((l) => l.textContent)).toEqual(["Українська", "English"]);
    expect(pressed(langs)).toEqual(["Українська"]);
  });
});

describe("cp-brand · варіанти payload", () => {
  it("без кандидатів лого — textFallback шрифтом і кольором бренду", () => {
    const { $, $$ } = setup(
      withPayload(
        { logoCandidates: [] },
        {
          logo: { assetId: null, type: "text", needsBackground: false, textFallback: "ЗЕРНО" },
          logoCandidates: [],
        },
      ),
    );
    expect($$("button.cb-logo")).toHaveLength(0);
    const text = $(".cb-logo--text .cb-logo__text");
    expect(text.textContent).toBe("ЗЕРНО");
    expect(text.style.getPropertyValue("font-family")).toContain("Montserrat");
    expect(text.style.getPropertyValue("color")).toMatch(/#6B3E26|rgb\(107, 62, 38\)/i);
  });

  it("needMorePhotos — рядок з точкою --accent; без нього рядка немає", () => {
    const first = setup();
    const warn = first.$(".cb-warn");
    expect(warn.textContent).toBe(NEED_MORE_PHOTOS);
    expect(warn.querySelector(".dot.dot--accent")).not.toBeNull();

    const second = setup(withPayload({ needMorePhotos: false }));
    expect(second.el.querySelector(".cb-warn")).toBeNull();
  });

  it("мова — лише якщо languageOptions.length > 1", () => {
    const { el } = setup(
      withPayload({ languageOptions: [{ lang: "uk", url: "https://zerno.example.com/uk/" }] }),
    );
    expect(el.querySelector(".cb-seg")).toBeNull();
    expect(el.querySelector('[data-group="language"]')).toBeNull();
  });

  it("fixes[] — окремим рядком дрібним mono", () => {
    const { $ } = setup(withPayload({}, { fixes: ["Акцент затемнено для контрасту 4.5:1"] }));
    expect($(".cb-row--fixes .spec-row__label").textContent).toBe("Виправлено");
    expect($(".cb-fixes").textContent).toBe("Акцент затемнено для контрасту 4.5:1");
  });

  it("некоректні дані сайту не потрапляють у style, src і href", () => {
    const { $, $$ } = setup(
      withPayload(
        {
          logoCandidates: [{ assetId: "x1", url: "javascript:alert(1)" }],
          photos: [{ assetId: "p1", url: "//evil.example.com/a.png" }],
        },
        {
          palette: { ...brandPayload.brandkit.palette, primary: "red;background:url(x)" },
          typography: {
            ...brandPayload.brandkit.typography,
            heading: { family: 'Evil"; } body { x', weights: [700], origin: "site" },
          },
          facts: [
            {
              id: "f9",
              kind: "claim",
              text: "Найкращі",
              source: "site",
              sourceUrl: "javascript:alert(1)",
              quote: null,
            },
          ],
        },
      ),
    );
    const primary = $('.cb-swatch[data-key="primary"]');
    expect(primary.getAttribute("style")).toBeNull();
    expect(primary.querySelector(".cb-swatch__hex")?.textContent).toBe("—");
    expect($('button.cb-logo[data-asset="x1"]').querySelector("img")).toBeNull();
    expect($('.cb-photo[data-asset="p1"]').querySelector("img")).toBeNull();
    expect($('.cb-fact[data-fact="f9"]').querySelector("a")).toBeNull();
    const heading = $('.cb-font[data-role="heading"] .cb-font__sample');
    expect(heading.style.getPropertyValue("font-family")).not.toContain("Evil");
    expect($$("[onclick], [onerror], [onload]")).toHaveLength(0);
  });
});

describe("cp-brand · дії", () => {
  it("«Затвердити» → approve, «Правки» → startEdit", async () => {
    const { $, called } = setup();
    $<HTMLButtonElement>(".cb-approve").click();
    await flush();
    $<HTMLButtonElement>(".cb-edit").click();
    expect(called("approve")).toEqual([[1]]);
    expect(called("startEdit")).toHaveLength(1);
  });

  it("клік на іншого кандидата лого → setLogo(assetId); обраний — без дії", async () => {
    const { $, called } = setup(
      withPayload({
        logoCandidates: [
          { assetId: "a02", url: "/files/p1/a02.svg" },
          { assetId: "a07", url: "/files/p1/a07.png" },
        ],
      }),
    );
    $<HTMLButtonElement>('.cb-logo[data-asset="a02"]').click();
    $<HTMLButtonElement>('.cb-logo[data-asset="a07"]').click();
    await flush();
    expect(called("setLogo")).toEqual([["a07"]]);
  });

  it("тайли форматів → setFormats з мультивибором у канонічному порядку", () => {
    const { $, called } = setup();
    $<HTMLButtonElement>('.cb-fmt[data-format="landscape"]').click();
    $<HTMLButtonElement>('.cb-fmt[data-format="square"]').click();
    expect(called("setFormats")).toEqual([
      [["vertical", "landscape"]],
      [["vertical", "square", "landscape"]],
    ]);
    $<HTMLButtonElement>('.cb-fmt[data-format="vertical"]').click();
    expect(called("setFormats").at(-1)).toEqual([["square", "landscape"]]);
  });

  it("не можна зняти останній формат", () => {
    const { $, called } = setup();
    const vertical = $<HTMLButtonElement>('.cb-fmt[data-format="vertical"]');
    expect(vertical.title).toBe("Потрібен хоча б один формат");
    vertical.click();
    expect(called("setFormats")).toEqual([]);
    expect(vertical.getAttribute("aria-pressed")).toBe("true");
  });

  it("сегмент мови → setLanguage(lang)", () => {
    const { $, $$, called } = setup();
    $<HTMLButtonElement>('.cb-lang[data-lang="uk"]').click();
    $<HTMLButtonElement>('.cb-lang[data-lang="en"]').click();
    expect(called("setLanguage")).toEqual([["en"]]);
    expect(pressed($$(".cb-lang"))).toEqual(["English"]);
  });

  it("«Додати фото» відкриває input, вибір файлів → uploadPhotos", async () => {
    const { $, called } = setup();
    const input = $<HTMLInputElement>('.cb-photos input[type="file"]');
    const open = vi.spyOn(input, "click");
    $<HTMLButtonElement>(".cb-photo--add").click();
    expect(open).toHaveBeenCalledOnce();
    const files = [new File(["x"], "a.jpg", { type: "image/jpeg" }), new File(["y"], "b.png")];
    Object.defineProperty(input, "files", { configurable: true, value: files });
    input.dispatchEvent(new Event("change"));
    await flush();
    expect(called("uploadPhotos")).toEqual([[["a.jpg", "b.png"]]]);
  });

  it("поза awaiting_brand / не open — усі контроли неактивні й не кличуть дій", async () => {
    const { $, $$, store, called } = setup();
    const entry = store.getState().checkpoints.brand;
    if (!entry) throw new Error("немає checkpoints.brand");
    store.setState((s) => ({
      checkpoints: { ...s.checkpoints, brand: { ...entry, state: "approved" } },
    }));
    const controls = $$<HTMLButtonElement>("button");
    expect(controls.length).toBeGreaterThan(5);
    expect(controls.every((b) => b.disabled)).toBe(true);
    expect($(".cb-eyebrow .diamond").className).toBe("diamond diamond--done");
    $<HTMLButtonElement>(".cb-approve").click();
    $<HTMLButtonElement>('.cb-fmt[data-format="square"]').click();
    await flush();
    expect(called("approve")).toEqual([]);
    expect(called("setFormats")).toEqual([]);

    store.setState((s) => ({
      status: "scripting",
      checkpoints: { ...s.checkpoints, brand: { ...entry, state: "open" } },
    }));
    expect($<HTMLButtonElement>(".cb-approve").disabled).toBe(true);
    store.setState({ status: "awaiting_brand" });
    expect($<HTMLButtonElement>(".cb-approve").disabled).toBe(false);
  });
});

describe("cp-brand · Google Fonts", () => {
  it("<link> на heading/body family без дублікатів у document.head", () => {
    setup();
    setup();
    const links = [...document.head.querySelectorAll<HTMLLinkElement>("link[data-cb-font]")];
    expect(links.map((l) => l.dataset.cbFont)).toEqual(["Montserrat", "Inter"]);
    expect(links.map((l) => l.getAttribute("href"))).toEqual([
      "https://fonts.googleapis.com/css2?family=Montserrat:wght@700;800&display=swap",
      "https://fonts.googleapis.com/css2?family=Inter:wght@400;600&display=swap",
    ]);
    expect(links.every((l) => l.getAttribute("rel") === "stylesheet")).toBe(true);
  });

  it("однакове сімейство для heading і body — один <link> з усіма вагами; назва кодується", () => {
    setup(
      withPayload(
        {},
        {
          typography: {
            heading: { family: "Playfair Display", weights: [700], origin: "substitute" },
            body: { family: "Playfair Display", weights: [400, 700], origin: "substitute" },
            mono: null,
            detected: [],
          },
        },
      ),
    );
    const links = [...document.head.querySelectorAll("link[data-cb-font]")];
    expect(links.map((l) => l.getAttribute("href"))).toEqual([
      "https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;700&display=swap",
    ]);
  });
});

describe("cp-brand · інкрементальний update", () => {
  it("той самий payload — вузли не перестворюються", () => {
    const { $, store } = setup();
    const name = $(".cb-name");
    const swatch = $(".cb-swatch");
    const tile = $(".cb-fmt");
    store.setState({ totalUsd: 9.99 });
    store.setState((s) => ({ ui: { ...s.ui, notice: "x", draft: "abc" } }));
    store.setState((s) => ({ feed: [...s.feed] }));
    expect($(".cb-name")).toBe(name);
    expect($(".cb-swatch")).toBe(swatch);
    expect($(".cb-fmt")).toBe(tile);
  });

  it("ui.pendingFormats лише перемикає класи й aria-pressed тайлів", () => {
    const { $, $$, store } = setup();
    const tiles = $$(".cb-fmt");
    const name = $(".cb-name");
    store.setState((s) => ({ ui: { ...s.ui, pendingFormats: ["square", "landscape"] } }));
    const after = $$(".cb-fmt");
    expect(after).toEqual(tiles);
    expect(after.every((t, i) => t === tiles[i])).toBe(true);
    expect(after.map((t) => t.getAttribute("aria-pressed"))).toEqual(["false", "true", "true"]);
    expect(after.map((t) => t.classList.contains("is-on"))).toEqual([false, true, true]);
    expect($(".cb-name")).toBe(name);

    store.setState((s) => ({ ui: { ...s.ui, pendingFormats: null } }));
    expect($$(".cb-fmt").map((t) => t.getAttribute("aria-pressed"))).toEqual(["true", "false", "false"]);
  });

  it("нова ревізія перебудовує секції й оновлює eyebrow", () => {
    const { $, store } = setup();
    const name = $(".cb-name");
    const entry = store.getState().checkpoints.brand;
    if (!entry) throw new Error("немає checkpoints.brand");
    const payload = {
      ...brandPayload,
      brandkit: { ...brandPayload.brandkit, identity: { ...brandPayload.brandkit.identity, name: "Зерно+" } },
    };
    store.setState((s) => ({ checkpoints: { ...s.checkpoints, brand: { ...entry, rev: 2, payload } } }));
    expect($(".cb-name")).not.toBe(name);
    expect($(".cb-name").textContent).toBe("Зерно+");
    expect($(".cb-eyebrow").textContent).toBe("Чекпоінт 1 / 3 · Бренд-кіт · ревізія 2");
  });
});

describe("cp-brand · чисті функції", () => {
  it("hexColor / textOn / contrast", () => {
    expect(hexColor("#abc")).toBe("#ABC");
    expect(hexColor("#6b3e26")).toBe("#6B3E26");
    expect(hexColor("red")).toBeNull();
    expect(hexColor("#12345")).toBeNull();
    expect(hexColor("#123456;x")).toBeNull();
    expect(contrast("#000000", "#FFFFFF")).toBeCloseTo(21, 5);
    const palette = brandPayload.brandkit.palette;
    expect(textOn("#6B3E26", palette)).toBe("#FFFFFF");
    expect(textOn("#FFF8F0", palette)).toBe("#1E1410");
  });

  it("mediaUrl / linkUrl", () => {
    expect(mediaUrl("/files/p1/a.png")).toBe("/files/p1/a.png");
    expect(mediaUrl("https://cdn.example.com/a.png")).toBe("https://cdn.example.com/a.png");
    expect(mediaUrl("javascript:alert(1)")).toBeNull();
    expect(mediaUrl("data:image/png;base64,xx")).toBeNull();
    expect(mediaUrl("//evil.example.com/a.png")).toBeNull();
    expect(mediaUrl("/files\\..\\x")).toBeNull();
    expect(linkUrl("http://zerno.example.com")).toBe("http://zerno.example.com/");
    expect(linkUrl("ftp://x")).toBeNull();
    expect(linkUrl(null)).toBeNull();
  });

  it("googleFontsHref кодує назву", () => {
    expect(googleFontsHref("Roboto Slab", [700, 400, 400, 1000])).toBe(
      "https://fonts.googleapis.com/css2?family=Roboto+Slab:wght@400;700&display=swap",
    );
  });

  it("selectedFormats / toggleFormat", () => {
    const state = awaitingBrand();
    expect(selectedFormats(state, brandPayload)).toEqual(["vertical"]);
    expect(
      selectedFormats({ ui: { ...state.ui, pendingFormats: ["landscape", "vertical"] } }, brandPayload),
    ).toEqual(["vertical", "landscape"]);
    expect(toggleFormat(["vertical"], "vertical")).toBeNull();
    expect(toggleFormat(["landscape"], "vertical")).toEqual(["vertical", "landscape"]);
  });
});
