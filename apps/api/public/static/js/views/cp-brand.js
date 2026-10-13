// @ts-check
/**
 * B6 · Чекпоінт 1 — бренд-кіт (S2, S6, C6, C7, X2).
 *
 * Шапка (eyebrow з ромбом і ревізією, «Правки», «Затвердити →»), ідентичність бренду, рядки
 * специфікації (палітра, шрифти, лого, голос, послуги, факти, гео, фото, виправлення) і панель
 * «Ваші рішення» (питання, формати, мова).
 *
 * Інкрементальність: секції будуються заново лише при новому payload / ревізії. Решта змін
 * (`ui.pendingFormats`, статус, стан чекпоінта) лише перемикає класи, `aria-pressed` і `disabled`,
 * тож скрол сцени й фокус не скидаються.
 *
 * Безпека: усі тексти бренд-кіта (дані з сайтів клієнтів) — через `h()`/`textContent`/
 * `setAttribute`; кольори проходять `hexColor`, URL зображень — `mediaUrl`, посилання — `linkUrl`,
 * назви шрифтів — `fontFamily` (інакше в стилі/URL нічого не потрапляє).
 */
import { FORMAT_LABELS, FORMATS } from "../contracts.js";
import { clear, h, text } from "../dom.js";

/** @typedef {import("../contracts.js").UiState} UiState */
/** @typedef {import("../contracts.js").Actions} Actions */
/** @typedef {import("../contracts.js").Format} Format */
/** @typedef {import("../contracts.js").CheckpointEntry} CheckpointEntry */
/** @typedef {import("../contracts.js").BrandCheckpointPayload} BrandCheckpointPayload */
/** @typedef {BrandCheckpointPayload["brandkit"]} BrandKitFile */
/** @typedef {BrandKitFile["typography"]["heading"]} FontChoice */
/** @typedef {BrandKitFile["facts"][number]} Fact */
/** @typedef {HTMLButtonElement | HTMLInputElement} Control */

// ───────────── Підписи ─────────────

/** Назви форматів на тайлах (C6). @type {Record<Format, string>} */
export const FORMAT_NAMES = { vertical: "Вертикальне", square: "Квадрат", landscape: "Горизонтальне" };

/** Свотчі палітри (текстові кольори — окремим рядком нижче). */
export const SWATCHES = /** @type {const} */ ([
  ["primary", "Основний"],
  ["secondary", "Вторинний"],
  ["accent", "Акцент"],
  ["background", "Фон"],
  ["surface", "Поверхня"],
]);

/** @type {Record<Fact["kind"], string>} */
export const FACT_KINDS = {
  price: "ціна",
  discount: "знижка",
  number: "число",
  guarantee: "гарантія",
  date: "дата",
  claim: "твердження",
};

/** @type {Record<Fact["source"], string>} */
const FACT_SOURCES = { site: "сайт", client: "від вас" };

/** @type {Record<BrandKitFile["voice"]["formality"], string>} */
const FORMALITY = { formal: "офіційний", neutral: "нейтральний", casual: "розмовний" };

/** @type {Record<string, string>} */
export const LANGUAGE_NAMES = { uk: "Українська", en: "English" };

export const NEED_MORE_PHOTOS = "Придатних фото замало — додайте, будь ласка, ще.";
const ONE_FORMAT = "Потрібен хоча б один формат";
const PHOTO_ACCEPT = "image/*,.heic,.heif";
const FONTS_CSS = "https://fonts.googleapis.com/css2";

// ───────────── Валідація даних payload ─────────────

/**
 * Колір для `style`: лише `#rgb` / `#rrggbb`, інакше null.
 * @param {unknown} value
 * @returns {string | null}
 */
export function hexColor(value) {
  if (typeof value !== "string") return null;
  const v = value.trim();
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(v) ? v.toUpperCase() : null;
}

/** @param {string} hex валідний `#rgb`/`#rrggbb` @returns {number} відносна яскравість (WCAG) */
function luminance(hex) {
  const raw = hex.slice(1);
  const full = raw.length === 3 ? [...raw].map((c) => c + c).join("") : raw;
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = Number.parseInt(full.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

/**
 * Контраст двох кольорів (WCAG, 1…21).
 * @param {string} a
 * @param {string} b
 */
export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

/**
 * Колір тексту на свотчі: `textOnDark` чи `textOnLight` бренду — що контрастніше.
 * @param {string} bg валідний колір свотча
 * @param {BrandKitFile["palette"]} palette
 */
export function textOn(bg, palette) {
  const dark = hexColor(palette.textOnDark) ?? "#FFFFFF";
  const light = hexColor(palette.textOnLight) ?? "#151412";
  return contrast(bg, dark) >= contrast(bg, light) ? dark : light;
}

/**
 * URL зображення: лише відносні `/files/…` (і `/static/…` фікстур) або http(s).
 * @param {unknown} value
 * @returns {string | null}
 */
export function mediaUrl(value) {
  if (typeof value !== "string" || value.includes("\\")) return null;
  if (/^\/(?:files|static)\//.test(value)) return value;
  return linkUrl(value);
}

/**
 * Зовнішнє посилання: лише абсолютні http(s).
 * @param {unknown} value
 * @returns {string | null}
 */
export function linkUrl(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Назва сімейства Google Fonts (латиниця, цифри, пробіли, дефіс), інакше null.
 * @param {unknown} value
 * @returns {string | null}
 */
export function fontFamily(value) {
  if (typeof value !== "string") return null;
  const v = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9 -]{0,63}$/.test(v) ? v : null;
}

/** @param {readonly unknown[]} weights @returns {number[]} цілі 100…900 без повторів за зростанням */
function cleanWeights(weights) {
  const list = weights.filter(
    /** @returns {w is number} */ (w) => typeof w === "number" && Number.isInteger(w) && w >= 100 && w <= 900,
  );
  return [...new Set(list)].sort((a, b) => a - b);
}

/**
 * URL таблиці стилів Google Fonts для сімейства (назва кодується).
 * @param {string} family валідна назва (див. `fontFamily`)
 * @param {readonly number[]} weights
 */
export function googleFontsHref(family, weights) {
  const name = encodeURIComponent(family).replace(/%20/g, "+");
  const w = cleanWeights(weights);
  return `${FONTS_CSS}?family=${name}${w.length > 0 ? `:wght@${w.join(";")}` : ""}&display=swap`;
}

/**
 * Підключає шрифти бренду в `document.head` — по одному `<link>` на сімейство (збій одного
 * не ламає інше), без дублікатів за `href`.
 * @param {Document} doc
 * @param {readonly FontChoice[]} choices
 */
export function ensureBrandFonts(doc, choices) {
  /** @type {Map<string, number[]>} */
  const byFamily = new Map();
  for (const choice of choices) {
    const family = fontFamily(choice?.family);
    if (!family) continue;
    byFamily.set(family, [...(byFamily.get(family) ?? []), ...(choice.weights ?? [])]);
  }
  const existing = new Set(
    [...doc.head.querySelectorAll('link[rel="stylesheet"]')].map((l) => l.getAttribute("href")),
  );
  for (const [family, weights] of byFamily) {
    const href = googleFontsHref(family, weights);
    if (existing.has(href)) continue;
    existing.add(href);
    doc.head.append(h("link", { rel: "stylesheet", href, "data-cb-font": family }));
  }
}

/** @param {string | null} family @returns {string} значення `font-family` з фолбеком */
const fontStack = (family) => (family ? `"${family}", var(--f-ui)` : "var(--f-ui)");

/**
 * Дописує вузли (масиви розгортаються, `null` пропускається).
 * @param {Node} node
 * @param {...(Node | null | Node[])} children
 */
function put(node, ...children) {
  for (const c of children.flat()) if (c) node.appendChild(c);
}

/** @param {string} href @returns {string} «хост/шлях ↗» для підпису посилання */
function linkLabel(href) {
  const url = new URL(href);
  const path = url.pathname === "/" ? "" : url.pathname;
  return `${url.host}${path}`;
}

// ───────────── Стан ─────────────

/**
 * Payload бренд-кіта з поточного стану або null.
 * @param {Pick<UiState, "checkpoints">} state
 * @returns {BrandCheckpointPayload | null}
 */
export function brandPayloadOf(state) {
  const payload = state.checkpoints.brand?.payload;
  return payload?.checkpoint === "brand" ? payload : null;
}

/**
 * Чи можна діяти на екрані: статус `awaiting_brand` і чекпоінт відкритий.
 * @param {Pick<UiState, "status" | "checkpoints">} state
 */
export function isActive(state) {
  return state.status === "awaiting_brand" && state.checkpoints.brand?.state === "open";
}

/**
 * Поточний вибір форматів: незавершений вибір клієнта або формати з payload.
 * @param {Pick<UiState, "ui">} state
 * @param {BrandCheckpointPayload | null} payload
 * @returns {Format[]}
 */
export function selectedFormats(state, payload) {
  const list = state.ui.pendingFormats ?? payload?.formats ?? [];
  return FORMATS.filter((f) => list.includes(f));
}

/**
 * Перемикає формат; останній обраний зняти не можна (повертає null).
 * @param {readonly Format[]} current
 * @param {Format} format
 * @returns {Format[] | null}
 */
export function toggleFormat(current, format) {
  const next = current.includes(format) ? current.filter((f) => f !== format) : [...current, format];
  return next.length === 0 ? null : FORMATS.filter((f) => next.includes(f));
}

// ───────────── View ─────────────

/** @type {import("../contracts.js").MountFn} */
export function mount(el, ctx) {
  const { actions } = ctx;
  const doc = el.ownerDocument;

  /** Кнопки й поля, активні лише на відкритому чекпоінті. @type {Set<Control>} */
  const controls = new Set();
  /** Дії в процесі (захист від подвійного натискання). @type {Set<Control>} */
  const pending = new Set();
  let active = false;

  /** @param {Control} c */
  const applyDisabled = (c) => {
    const off = !active || pending.has(c);
    if (c.disabled !== off) c.disabled = off;
  };
  const applyActive = () => {
    for (const c of controls) applyDisabled(c);
  };

  /**
   * Реєструє контрол і вішає обробник; async-дії блокують контрол до завершення.
   * @template {Control} T
   * @param {T} c
   * @param {(e: Event) => unknown} handler
   * @param {string} [event]
   * @returns {T}
   */
  function control(c, handler, event = "click") {
    controls.add(c);
    c.addEventListener(event, async (e) => {
      if (!active || pending.has(c)) return;
      const result = handler(e);
      if (!(result instanceof Promise)) return;
      pending.add(c);
      applyDisabled(c);
      try {
        await result;
      } catch (err) {
        console.error("[cp-brand]", err);
      } finally {
        pending.delete(c);
        applyDisabled(c);
      }
    });
    applyDisabled(c);
    return c;
  }

  // ── Шапка ──
  const diamond = h("span", { class: "diamond", "aria-hidden": "true" });
  const eyebrowText = h("span");
  const editBtn = control(
    h("button", { type: "button", class: "btn btn--ghost cb-edit", text: "Правки" }),
    () => actions.startEdit(),
  );
  const approveBtn = control(
    h(
      "button",
      { type: "button", class: "btn btn--primary cb-approve" },
      "Затвердити",
      h("span", { "aria-hidden": "true", text: "→" }),
    ),
    () => actions.approve(),
  );
  const head = h(
    "header",
    { class: "cb-head" },
    h("p", { class: "eyebrow cb-eyebrow" }, diamond, eyebrowText),
    h("div", { class: "cb-head__actions" }, editBtn, approveBtn),
  );

  const hero = h("div", { class: "cb-hero" });
  const specs = h("div", { class: "cb-specs" });
  const decisions = h("section", { class: "cb-decisions", "aria-labelledby": "cb-decisions-title" });
  const empty = h("p", { class: "cb-empty body-l", text: "Бренд-кіт ще збирається…" });
  const root = h("section", { class: "cb adc-enter" }, head, empty, hero, specs, decisions);
  el.append(root);

  /** Тайли форматів для патчу без перебудови. @type {Map<Format, HTMLButtonElement>} */
  const formatTiles = new Map();
  /** @type {string | null} */
  let language = null;

  /** @type {{ payload: BrandCheckpointPayload | null, rev: number | null, formats: string, cpState: string | null } | null} */
  let shown = null;

  /** @param {BrandCheckpointPayload} payload */
  function renderHero(payload) {
    const { identity, languageVersions, confidence } = payload.brandkit;
    const langs = languageVersions.length > 0 ? languageVersions.map((v) => v.lang) : [identity.language];
    const meta = [
      identity.category,
      identity.city,
      [...new Set(langs.map((l) => String(l).toUpperCase()))].join(" / "),
      Number.isFinite(confidence) ? `впевненість ${Math.round(confidence * 100)}%` : null,
    ].filter((v) => typeof v === "string" && v.trim() !== "");
    clear(hero);
    put(
      hero,
      h("h1", { class: "display-brand cb-name", text: identity.name }),
      identity.tagline ? h("p", { class: "body-l cb-tagline", text: identity.tagline }) : null,
      h("p", { class: "mono cb-meta", text: meta.join(" · ") }),
    );
  }

  /**
   * @param {string} label
   * @param {string} key
   * @param {...import("../dom.js").Child} content
   */
  const specRow = (label, key, ...content) =>
    h(
      "div",
      { class: `spec-row cb-row cb-row--${key}`, "data-row": key },
      h("div", { class: "spec-row__label", text: label }),
      h("div", { class: "cb-row__body" }, ...content),
    );

  /** @param {BrandKitFile} kit */
  function paletteRow(kit) {
    const { palette } = kit;
    const swatches = SWATCHES.map(([key, name]) => {
      const color = hexColor(palette[key]);
      return h(
        "div",
        {
          class: `cb-swatch${color ? "" : " stripes"}`,
          "data-key": key,
          style: color ? { background: color, color: textOn(color, palette) } : null,
        },
        h("span", { class: "cb-swatch__name", text: name }),
        h("span", { class: "cb-swatch__hex", text: color ?? "—" }),
      );
    });
    const textColors = /** @type {const} */ ([
      ["textOnDark", "Текст на темному"],
      ["textOnLight", "Текст на світлому"],
    ]).map(([key, name]) => {
      const color = hexColor(palette[key]);
      return h(
        "span",
        { class: "cb-textcolor", "data-key": key },
        h("span", {
          class: "cb-textcolor__chip",
          "aria-hidden": "true",
          style: color ? { background: color } : null,
        }),
        h("span", { text: name }),
        h("span", { class: "cb-textcolor__hex", text: color ?? "—" }),
      );
    });
    return specRow(
      "Палітра",
      "palette",
      h("div", { class: "cb-swatches" }, swatches),
      h("div", { class: "cb-textcolors" }, textColors),
    );
  }

  /** @param {BrandKitFile} kit */
  function fontsRow(kit) {
    const { heading, body } = kit.typography;
    ensureBrandFonts(doc, [heading, body]);
    /** @param {FontChoice} f @param {"heading" | "body"} key @param {string} role @param {"max" | "min"} pick */
    const sample = (f, key, role, pick) => {
      const family = fontFamily(f.family);
      const weights = cleanWeights(f.weights ?? []);
      const weight = (pick === "max" ? weights.at(-1) : weights[0]) ?? 400;
      return h(
        "div",
        { class: "cb-font", "data-role": key },
        h("span", {
          class: "cb-font__sample",
          "aria-hidden": "true",
          text: "Аа",
          style: { fontFamily: fontStack(family), fontWeight: weight },
        }),
        h("span", { class: "cb-font__family", text: f.family }),
        h("span", {
          class: "cb-font__meta",
          text: [role, weights.join(", "), f.origin === "site" ? "з сайту" : "замінник"]
            .filter(Boolean)
            .join(" · "),
        }),
      );
    };
    return specRow(
      "Шрифти",
      "fonts",
      h(
        "div",
        { class: "cb-fonts" },
        sample(heading, "heading", "Заголовки", "max"),
        sample(body, "body", "Текст", "min"),
      ),
    );
  }

  /** @param {BrandCheckpointPayload} payload */
  function logoRow(payload) {
    const kit = payload.brandkit;
    const bg = hexColor(kit.palette.background);
    const tileStyle = bg ? { background: bg } : null;
    if (payload.logoCandidates.length === 0) {
      const family = fontFamily(kit.typography.heading.family);
      const weight = cleanWeights(kit.typography.heading.weights ?? []).at(-1) ?? 700;
      const ink = hexColor(kit.palette.primary);
      return specRow(
        "Лого",
        "logo",
        h(
          "div",
          { class: "cb-logos" },
          h(
            "div",
            { class: "cb-logo cb-logo--text", style: tileStyle },
            h("span", {
              class: "cb-logo__text",
              text: kit.logo.textFallback || kit.identity.name,
              style: { fontFamily: fontStack(family), fontWeight: weight, color: ink },
            }),
          ),
        ),
        h("p", { class: "cb-note", text: "Зображення лого не знайдено — у ролику буде текстове." }),
      );
    }
    const tiles = payload.logoCandidates.map((cand) => {
      const chosen = cand.assetId === kit.logo.assetId;
      const src = mediaUrl(cand.url);
      const tile = h(
        "button",
        {
          type: "button",
          class: `cb-logo${chosen ? " is-on" : ""}${src ? "" : " stripes"}`,
          "data-asset": cand.assetId,
          "aria-pressed": String(chosen),
          "aria-label": `Лого-кандидат ${cand.assetId}`,
          style: src ? tileStyle : null,
        },
        src
          ? h("img", { class: "cb-logo__img", src, alt: "", loading: "lazy", decoding: "async" })
          : h("span", { class: "cb-logo__caption", text: `кандидат ${cand.assetId}` }),
        chosen ? h("span", { class: "cb-logo__badge", "aria-hidden": "true", text: "✓" }) : null,
      );
      return control(tile, () => (chosen ? undefined : actions.setLogo(cand.assetId)));
    });
    return specRow("Лого", "logo", h("div", { class: "cb-logos" }, tiles));
  }

  /** @param {BrandKitFile} kit */
  function voiceRow(kit) {
    const { voice, audience } = kit;
    const tags = [...voice.tone, FORMALITY[voice.formality] ?? voice.formality].filter(Boolean);
    return specRow(
      "Голос",
      "voice",
      voice.description ? h("p", { class: "cb-lead", text: voice.description }) : null,
      tags.length > 0 ? h("p", { class: "cb-tags mono", text: tags.join(" · ") }) : null,
      audience ? h("p", { class: "cb-sub", text: `Аудиторія: ${audience}` }) : null,
    );
  }

  /** @param {BrandKitFile} kit */
  function servicesRow(kit) {
    const items = kit.offerings.map((o) =>
      h(
        "li",
        { class: "cb-service" },
        h(
          "div",
          { class: "cb-service__head" },
          h("span", { class: "cb-service__name", text: o.name }),
          o.price ? h("span", { class: "cb-service__price mono", text: o.price }) : null,
        ),
        o.description ? h("span", { class: "cb-sub", text: o.description }) : null,
      ),
    );
    return specRow(
      "Послуги",
      "services",
      items.length > 0 ? h("ul", { class: "cb-services" }, items) : h("p", { class: "cb-sub", text: "—" }),
    );
  }

  /** @param {Fact} fact */
  function factCard(fact) {
    const href = fact.source === "site" ? linkUrl(fact.sourceUrl) : null;
    return h(
      "div",
      { class: `card cb-fact cb-fact--${fact.source}`, "data-fact": fact.id },
      h("span", {
        class: "cb-fact__label",
        text: [fact.id, FACT_KINDS[fact.kind] ?? fact.kind, FACT_SOURCES[fact.source] ?? fact.source].join(
          " · ",
        ),
      }),
      h("span", { class: "cb-fact__text", text: fact.text }),
      fact.quote ? h("span", { class: "cb-fact__quote", text: `«${fact.quote}»` }) : null,
      href
        ? h("a", {
            class: "cb-fact__link",
            href,
            target: "_blank",
            rel: "noopener noreferrer",
            text: `${linkLabel(href)} ↗`,
          })
        : null,
    );
  }

  /** @param {BrandKitFile} kit */
  function factsRow(kit) {
    return specRow(
      "Факти",
      "facts",
      kit.facts.length > 0
        ? h("div", { class: "cb-facts" }, kit.facts.map(factCard))
        : h("p", { class: "cb-sub", text: "Фактів на сайті не знайдено — додайте їх у діалозі." }),
    );
  }

  /** @param {BrandKitFile} kit */
  function geoRow(kit) {
    const { location, identity } = kit;
    const place = location.address ?? location.city ?? identity.city;
    const extra = [
      location.hours,
      identity.serviceArea ? `зона обслуговування: ${identity.serviceArea}` : null,
    ].filter(Boolean);
    return specRow(
      "Гео",
      "geo",
      h("p", { class: "cb-lead", text: place ?? "—" }),
      extra.length > 0 ? h("p", { class: "cb-sub", text: extra.join(" · ") }) : null,
    );
  }

  /** @param {BrandCheckpointPayload} payload */
  function photosRow(payload) {
    const input = h("input", {
      type: "file",
      class: "cb-file",
      accept: PHOTO_ACCEPT,
      multiple: true,
      hidden: true,
      tabindex: "-1",
      "aria-hidden": "true",
    });
    input.addEventListener("change", async () => {
      const files = Array.from(input.files ?? []);
      input.value = "";
      if (!active || files.length === 0) return;
      try {
        await actions.uploadPhotos(files);
      } catch (err) {
        console.error("[cp-brand] uploadPhotos", err);
      }
    });
    const add = control(
      h(
        "button",
        { type: "button", class: "cb-photo cb-photo--add" },
        h("span", { class: "cb-photo__plus", "aria-hidden": "true", text: "+" }),
        "Додати фото",
      ),
      () => input.click(),
    );
    const tiles = payload.photos.map((p) => {
      const src = mediaUrl(p.url);
      return h(
        "div",
        { class: `cb-photo${src ? "" : " stripes"}`, "data-asset": p.assetId },
        src ? h("img", { class: "cb-photo__img", src, alt: "", loading: "lazy", decoding: "async" }) : null,
      );
    });
    return specRow(
      "Фото",
      "photos",
      h("div", { class: "cb-photos" }, tiles, add, input),
      payload.needMorePhotos
        ? h(
            "p",
            { class: "cb-warn" },
            h("span", { class: "dot dot--accent", "aria-hidden": "true" }),
            NEED_MORE_PHOTOS,
          )
        : null,
    );
  }

  /** @param {BrandKitFile} kit */
  function fixesRow(kit) {
    const list = (kit.fixes ?? []).filter((f) => typeof f === "string" && f.trim() !== "");
    if (list.length === 0) return null;
    return specRow(
      "Виправлено",
      "fixes",
      h(
        "ul",
        { class: "cb-fixes" },
        list.map((f) => h("li", { text: f })),
      ),
    );
  }

  /** @param {BrandCheckpointPayload} payload */
  function renderSpecs(payload) {
    const kit = payload.brandkit;
    clear(specs);
    put(
      specs,
      paletteRow(kit),
      fontsRow(kit),
      logoRow(payload),
      voiceRow(kit),
      servicesRow(kit),
      factsRow(kit),
      geoRow(kit),
      photosRow(payload),
      fixesRow(kit),
    );
  }

  /** @param {Format} format */
  function formatTile(format) {
    const tile = h(
      "button",
      { type: "button", class: "cb-fmt", "data-format": format, "aria-pressed": "false" },
      h("span", { class: `cb-fmt__glyph cb-fmt__glyph--${format}`, "aria-hidden": "true" }),
      h("span", { class: "cb-fmt__ratio", text: FORMAT_LABELS[format] }),
      h("span", { class: "cb-fmt__name", text: FORMAT_NAMES[format] }),
    );
    return control(tile, () => {
      const state = ctx.store.getState();
      const next = toggleFormat(selectedFormats(state, brandPayloadOf(state)), format);
      if (next) actions.setFormats(next);
    });
  }

  /** @param {readonly Format[]} chosen */
  function markFormats(chosen) {
    for (const [format, tile] of formatTiles) {
      const on = chosen.includes(format);
      const last = on && chosen.length === 1;
      tile.classList.toggle("is-on", on);
      tile.setAttribute("aria-pressed", String(on));
      if (last) tile.title = ONE_FORMAT;
      else tile.removeAttribute("title");
    }
  }

  /** @param {BrandCheckpointPayload} payload */
  function languageGroup(payload) {
    const options = payload.languageOptions;
    if (options.length <= 1) return null;
    const langs = options.map((o) => o.lang);
    const kitLang = payload.brandkit.identity.language;
    const current = language ?? (langs.includes(kitLang) ? kitLang : (langs[0] ?? null));
    const buttons = options.map((o) =>
      control(
        h("button", {
          type: "button",
          class: "seg__opt cb-lang",
          "data-lang": o.lang,
          "aria-pressed": String(o.lang === current),
          text: LANGUAGE_NAMES[o.lang] ?? o.lang.toUpperCase(),
        }),
        () => {
          const was = language ?? current;
          if (was === o.lang) return;
          language = o.lang;
          for (const b of buttons) b.setAttribute("aria-pressed", String(b.dataset.lang === o.lang));
          actions.setLanguage(o.lang);
        },
      ),
    );
    return h(
      "div",
      { class: "cb-group", "data-group": "language" },
      h("p", { class: "label-s", text: "Мова відео" }),
      h("div", { class: "seg cb-seg", role: "group", "aria-label": "Мова відео" }, buttons),
    );
  }

  /** @param {BrandCheckpointPayload} payload @param {UiState} state */
  function renderDecisions(payload, state) {
    clear(decisions);
    formatTiles.clear();
    for (const f of FORMATS) formatTiles.set(f, formatTile(f));
    markFormats(selectedFormats(state, payload));
    put(
      decisions,
      h("h2", { class: "display-s cb-decisions__title", id: "cb-decisions-title", text: "Ваші рішення" }),
      h(
        "div",
        { class: "cb-group", "data-group": "formats" },
        h("p", { class: "label-s", text: "Формати" }),
        h("div", { class: "cb-fmts", role: "group", "aria-label": "Формати" }, [...formatTiles.values()]),
      ),
      languageGroup(payload),
    );
  }

  /** Прибирає контроли, яких більше немає в DOM (після перебудови секцій). */
  function pruneControls() {
    for (const c of controls) if (!root.contains(c)) controls.delete(c);
  }

  /** @param {UiState} state */
  function render(state) {
    const entry = state.checkpoints.brand;
    const payload = brandPayloadOf(state);
    const rev = entry?.rev ?? null;
    const chosen = selectedFormats(state, payload);
    const formatsKey = chosen.join(",");
    const cpState = entry?.state ?? null;

    if (!shown || shown.payload !== payload || shown.rev !== rev) {
      if (!shown || shown.rev !== rev) language = null;
      active = isActive(state);
      empty.hidden = payload !== null;
      for (const node of [hero, specs, decisions]) node.hidden = payload === null;
      if (payload) {
        renderHero(payload);
        renderSpecs(payload);
        renderDecisions(payload, state);
      } else {
        clear(hero);
        clear(specs);
        clear(decisions);
        formatTiles.clear();
      }
      pruneControls();
      text(eyebrowText, `Чекпоінт 1 / 3 · Бренд-кіт${rev !== null ? ` · ревізія ${rev}` : ""}`);
    } else if (shown.formats !== formatsKey) {
      markFormats(chosen);
    }

    const nextActive = isActive(state);
    if (nextActive !== active || !shown || shown.cpState !== cpState) {
      active = nextActive;
      diamond.className = `diamond ${
        cpState === "approved"
          ? "diamond--done"
          : cpState === "superseded"
            ? "diamond--stale"
            : active
              ? "diamond--open diamond--ring"
              : ""
      }`.trim();
      root.classList.toggle("is-active", active);
    }
    applyActive();
    shown = { payload, rev, formats: formatsKey, cpState };
  }

  render(ctx.store.getState());

  return {
    update: (state) => render(state),
    destroy() {
      controls.clear();
      pending.clear();
      formatTiles.clear();
      root.remove();
    },
  };
}
