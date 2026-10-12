/**
 * Код, що виконується всередині сторінки (page.evaluate). Звичайний JS без
 * транспіляції: файл читається як текст і вставляється у сторінку, тож тут не можна
 * імпортувати модулі. Реєструє `globalThis.__adc` з функціями підготовки й витягування.
 */
globalThis.__adc = (() => {
  const CONSENT_SELECTORS = [
    "#onetrust-accept-btn-handler",
    "#onetrust-reject-all-handler",
    "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll",
    "#CybotCookiebotDialogBodyButtonAccept",
    "#cookie-accept",
    "#accept-cookies",
    "#acceptCookies",
    ".cc-allow",
    ".cc-dismiss",
    ".cc-btn.cc-allow",
    ".cookie-accept",
    ".cookies-accept",
    ".js-cookie-accept",
    ".cmplz-accept",
    ".cky-btn-accept",
    ".fc-cta-consent",
    ".qc-cmp2-summary-buttons button:last-child",
    "[data-cookiefirst-action='accept']",
    "[data-testid='uc-accept-all-button']",
    "[data-action='accept-cookies']",
    "[aria-label*='accept' i][class*='cookie' i]",
  ];

  /** Тексти кнопок згоди/закриття (укр., англ., рос., пол.). */
  const CONSENT_TEXT =
    /^(accept( all)?( cookies)?|allow( all)?( cookies)?|i agree|agree|got it|ok|okay|i understand|understood|continue|close|прийняти( все| усі| всі)?|приймаю|погоджуюсь|погоджуюся|згоден|згодна|зрозуміло|дозволити( все)?|добре|закрити|принять( все)?|принимаю|согласен|понятно|хорошо|закрыть|akceptuj(ę)?( wszystkie)?|zgadzam się|✕|×|x)$/i;

  const CONSENT_CONTAINER = /cookie|consent|gdpr|privacy|cmp|onetrust|cookiebot|usercentrics/i;
  const POPUP_HINT =
    /cookie|consent|gdpr|popup|pop-up|modal|newsletter|subscribe|overlay|lightbox|dialog|banner|promo|interstitial/i;

  const SOCIAL = [
    ["instagram", /(^|\.)instagram\.com$/],
    ["facebook", /(^|\.)(facebook\.com|fb\.com|fb\.me)$/],
    ["tiktok", /(^|\.)tiktok\.com$/],
    ["youtube", /(^|\.)(youtube\.com|youtu\.be)$/],
    ["telegram", /(^|\.)(t\.me|telegram\.me)$/],
    ["linkedin", /(^|\.)linkedin\.com$/],
    ["x", /(^|\.)(twitter\.com|x\.com)$/],
    ["pinterest", /(^|\.)pinterest\.[a-z.]+$/],
    ["viber", /(^|\.)viber\.com$/],
    ["whatsapp", /(^|\.)(wa\.me|whatsapp\.com)$/],
    ["threads", /(^|\.)threads\.(net|com)$/],
  ];

  const clean = (s, max = 500) =>
    String(s || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, max);

  const isVisible = (el) => {
    if (!el?.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) > 0.05;
  };

  const abs = (u) => {
    try {
      return new URL(u, document.baseURI).href;
    } catch {
      return null;
    }
  };

  const labelOf = (el) =>
    clean(el.innerText || el.value || el.getAttribute("aria-label") || el.title || "", 80);

  function clickables(root) {
    return Array.from(
      root.querySelectorAll("button, a, [role='button'], input[type='button'], input[type='submit']"),
    ).filter(isVisible);
  }

  /** Натискає кнопку згоди cookie-банера/закриття поп-апа. Повертає кількість кліків. */
  function dismissConsent() {
    let clicked = 0;
    for (const sel of CONSENT_SELECTORS) {
      let el = null;
      try {
        el = document.querySelector(sel);
      } catch {
        el = null;
      }
      if (el && isVisible(el)) {
        el.click();
        clicked++;
      }
    }
    // Кнопки з типовим текстом усередині контейнерів cookie/consent або фіксованих оверлеїв.
    for (const el of clickables(document)) {
      const text = labelOf(el);
      if (!text || !CONSENT_TEXT.test(text)) continue;
      let node = el;
      let inside = false;
      for (let i = 0; node && i < 8; i++, node = node.parentElement) {
        const marker = `${node.id || ""} ${typeof node.className === "string" ? node.className : ""} ${node.getAttribute?.("aria-label") || ""} ${node.getAttribute?.("role") || ""}`;
        const pos = getComputedStyle(node).position;
        if (
          CONSENT_CONTAINER.test(marker) ||
          POPUP_HINT.test(marker) ||
          pos === "fixed" ||
          node.getAttribute?.("role") === "dialog"
        ) {
          inside = true;
          break;
        }
      }
      if (!inside) continue;
      // Посилання з адресою (не «#») не клікаємо — це навігація.
      if (el.tagName === "A") {
        const href = el.getAttribute("href") || "";
        if (href && !href.startsWith("#") && !href.startsWith("javascript:")) continue;
      }
      try {
        el.click();
        clicked++;
      } catch {
        // ігноруємо
      }
    }
    return clicked;
  }

  /** Ховає фіксовані оверлеї (cookie, поп-апи, чати), не чіпаючи вузьку шапку. */
  function hideOverlays() {
    const vw = innerWidth;
    const vh = innerHeight;
    let hidden = 0;
    const all = document.body ? document.body.querySelectorAll("*") : [];
    let checked = 0;
    for (const el of all) {
      if (++checked > 5000) break;
      const cs = getComputedStyle(el);
      if (cs.position !== "fixed" && cs.position !== "sticky") continue;
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      const r = el.getBoundingClientRect();
      const area =
        (Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0)) *
          Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0))) /
        (vw * vh);
      const marker = `${el.id || ""} ${typeof el.className === "string" ? el.className : ""} ${el.getAttribute("role") || ""} ${el.getAttribute("aria-label") || ""}`;
      const isHeaderLike =
        el.tagName === "HEADER" || el.tagName === "NAV" || /header|navbar|nav-bar|menu/i.test(marker);
      const cookieLike = CONSENT_CONTAINER.test(marker) || /cookie/i.test(clean(el.innerText, 400));
      const popupLike =
        POPUP_HINT.test(marker) ||
        el.getAttribute("role") === "dialog" ||
        el.getAttribute("aria-modal") === "true";
      const chatLike = /chat|widget|messenger|callback|jivo|tawk|intercom|crisp|binotel|ringostat/i.test(
        marker,
      );
      const covers = area > 0.3;
      if (
        (cookieLike || popupLike || chatLike || (covers && cs.position === "fixed")) &&
        !(isHeaderLike && !cookieLike && r.height < vh * 0.25)
      ) {
        el.style.setProperty("display", "none", "important");
        // Текст cookie-банерів і чатів не належить до змісту сторінки.
        if (cookieLike || chatLike) el.setAttribute("data-adc-hidden", "");
        hidden++;
      }
    }
    for (const el of [document.documentElement, document.body]) {
      if (!el) continue;
      if (getComputedStyle(el).overflowY === "hidden") el.style.setProperty("overflow", "auto", "important");
    }
    return hidden;
  }

  /** Плавно прокручує до кінця (для lazy-load), потім повертається нагору. */
  async function autoScroll(opts) {
    const maxSteps = opts?.maxSteps ?? 40;
    const delay = opts?.delay ?? 120;
    const maxHeight = opts?.maxHeight ?? 30000;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let y = 0;
    for (let i = 0; i < maxSteps; i++) {
      y += Math.round(innerHeight * 0.8);
      window.scrollTo(0, y);
      await sleep(delay);
      const height = document.documentElement.scrollHeight;
      if (y + innerHeight >= height || y >= maxHeight) break;
    }
    await sleep(delay * 2);
    window.scrollTo(0, 0);
    await sleep(delay);
    return document.documentElement.scrollHeight;
  }

  async function waitForFonts(timeoutMs) {
    if (!document.fonts?.ready) return true;
    return Promise.race([
      document.fonts.ready.then(() => true),
      new Promise((r) => setTimeout(() => r(false), timeoutMs ?? 3000)),
    ]);
  }

  // ---------- витягування даних ----------

  let colorCtx = null;
  const colorCache = new Map();

  /** Будь-який CSS-колір (oklch, color(), lab…) → rgba через піксель canvas. */
  const viaCanvas = (color) => {
    if (colorCache.has(color)) return colorCache.get(color);
    let out = null;
    try {
      if (!colorCtx) {
        const canvas = document.createElement("canvas");
        canvas.width = 1;
        canvas.height = 1;
        colorCtx = canvas.getContext("2d", { willReadFrequently: true });
      }
      colorCtx.clearRect(0, 0, 1, 1);
      colorCtx.fillStyle = "rgba(0, 0, 0, 0)";
      colorCtx.fillStyle = color;
      colorCtx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = colorCtx.getImageData(0, 0, 1, 1).data;
      out = `rgba(${r}, ${g}, ${b}, ${a / 255})`;
    } catch {
      out = null;
    }
    colorCache.set(color, out);
    return out;
  };

  const RGB_RE = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)/;

  const toHex = (color) => {
    if (!color || color === "transparent" || color === "none") return null;
    const m = RGB_RE.exec(color) || RGB_RE.exec(viaCanvas(color) || "");
    if (!m) return null;
    let alpha = 1;
    if (m[4] !== undefined)
      alpha = m[4].endsWith("%") ? Number.parseFloat(m[4]) / 100 : Number.parseFloat(m[4]);
    if (alpha < 0.5) return null;
    const hex = (v) =>
      Math.max(0, Math.min(255, Math.round(Number(v))))
        .toString(16)
        .padStart(2, "0");
    return `#${hex(m[1])}${hex(m[2])}${hex(m[3])}`.toUpperCase();
  };

  function cssVars() {
    const names = new Set();
    const visit = (rules) => {
      for (const rule of rules) {
        if (names.size >= 120) return;
        if (rule.cssRules && !rule.selectorText) {
          try {
            visit(rule.cssRules);
          } catch {
            // ігноруємо
          }
          continue;
        }
        const sel = rule.selectorText || "";
        if (!/(^|,)\s*(:root|html)\s*(,|$)/.test(sel)) continue;
        for (const prop of rule.style) if (prop.startsWith("--")) names.add(prop);
      }
    };
    for (const sheet of document.styleSheets) {
      try {
        visit(sheet.cssRules);
      } catch {
        // крос-доменні стилі недоступні
      }
    }
    const root = getComputedStyle(document.documentElement);
    const out = {};
    for (const name of names) {
      const v = root.getPropertyValue(name).trim();
      if (v && v.length <= 200) out[name] = v;
    }
    return out;
  }

  const BUTTON_SEL =
    "button, [role='button'], input[type='submit'], input[type='button'], a[class*='btn' i], a[class*='button' i]";

  function design() {
    const colors = {};
    const add = (role, value, n = 1) => {
      if (!value) return;
      const key = `${role}|${value}`;
      colors[key] = (colors[key] || 0) + n;
    };
    const vw = innerWidth;
    add("background", toHex(getComputedStyle(document.documentElement).backgroundColor), 3);
    add("background", toHex(getComputedStyle(document.body).backgroundColor), 5);
    let n = 0;
    for (const el of document.body.querySelectorAll(
      "section, header, footer, main, div, nav, article, aside",
    )) {
      if (++n > 3000) break;
      const r = el.getBoundingClientRect();
      if (r.width < vw * 0.5 || r.height < 80) continue;
      add("background", toHex(getComputedStyle(el).backgroundColor));
    }
    const sample = (sel, limit, fn) => {
      let i = 0;
      for (const el of document.querySelectorAll(sel)) {
        if (i >= limit) break;
        if (!isVisible(el)) continue;
        i++;
        fn(el, getComputedStyle(el));
      }
    };
    sample("h1, h2, h3", 60, (_el, cs) => add("heading", toHex(cs.color)));
    sample("p, li", 300, (_el, cs) => add("text", toHex(cs.color)));
    const radii = {};
    sample(BUTTON_SEL, 80, (_el, cs) => {
      add("button", toHex(cs.backgroundColor));
      add("buttonText", toHex(cs.color));
      const radius = cs.borderTopLeftRadius;
      if (radius && toHex(cs.backgroundColor)) radii[radius] = (radii[radius] || 0) + 1;
    });
    sample("a[href]", 300, (el, cs) => {
      if (el.matches(BUTTON_SEL)) return;
      add("link", toHex(cs.color));
    });

    const fontOf = (el) => {
      if (!el) return null;
      const cs = getComputedStyle(el);
      const family = clean((cs.fontFamily || "").split(",")[0].replace(/["']/g, ""), 80);
      const w =
        cs.fontWeight === "bold"
          ? 700
          : cs.fontWeight === "normal"
            ? 400
            : Number.parseInt(cs.fontWeight, 10);
      return family ? { family, weight: Number.isFinite(w) ? w : 400 } : null;
    };
    const firstVisible = (sel) => Array.from(document.querySelectorAll(sel)).find(isVisible) || null;
    const fonts = [];
    const pushFont = (role, el) => {
      const f = fontOf(el);
      if (f) fonts.push({ role, ...f });
    };
    pushFont("h1", firstVisible("h1"));
    pushFont("h2", firstVisible("h2"));
    pushFont("body", firstVisible("main p, article p, p") || document.body);
    pushFont("button", firstVisible(BUTTON_SEL));

    return {
      cssVars: cssVars(),
      colors: Object.entries(colors).map(([k, count]) => {
        const [role, value] = k.split("|");
        return { role, value, count };
      }),
      fonts,
      radii,
    };
  }

  /** Найбільший варіант із srcset. */
  function largestFromSrcset(srcset) {
    if (!srcset) return null;
    let best = null;
    let bestScore = -1;
    for (const part of srcset.split(/,\s+(?=\S)/)) {
      const [url, desc] = part.trim().split(/\s+/);
      if (!url || url.startsWith("data:")) continue;
      let score = 1;
      if (desc?.endsWith("w")) score = Number.parseFloat(desc);
      else if (desc?.endsWith("x")) score = Number.parseFloat(desc) * 1000;
      if (score > bestScore) {
        bestScore = score;
        best = url;
      }
    }
    return best;
  }

  const inHeader = (el) =>
    !!el.closest("header, [role='banner'], [class*='header' i], [id*='header' i], nav");
  const LOGO_RE = /logo|brand/i;

  function logoMarker(el) {
    const parts = [
      el.getAttribute("src"),
      el.getAttribute("alt"),
      el.id,
      typeof el.className === "string" ? el.className : el.getAttribute("class"),
      el.getAttribute("aria-label"),
    ];
    const link = el.closest("a");
    if (link) parts.push(link.id, link.className, link.getAttribute("aria-label"));
    const parent = el.parentElement;
    if (parent) parts.push(parent.id, typeof parent.className === "string" ? parent.className : "");
    return parts.filter(Boolean).join(" ");
  }

  function contextOf(el) {
    const fig = el.closest("figure");
    const cap = fig?.querySelector("figcaption");
    if (cap) return clean(cap.innerText, 200);
    let node = el.parentElement;
    for (let i = 0; node && i < 6; i++, node = node.parentElement) {
      const h = node.querySelector("h1, h2, h3, h4");
      if (h && clean(h.innerText)) {
        const p = node.querySelector("p");
        return clean(`${clean(h.innerText, 120)}${p ? ` — ${clean(p.innerText, 160)}` : ""}`, 240);
      }
    }
    return null;
  }

  function images() {
    const out = [];
    const seen = new Set();
    const push = (item) => {
      if (!item.url || seen.has(`${item.kind}|${item.url}`)) return;
      seen.add(`${item.kind}|${item.url}`);
      out.push(item);
    };
    const scrollY = window.scrollY;
    for (const img of document.querySelectorAll("img")) {
      const r = img.getBoundingClientRect();
      const picture = img.closest("picture");
      let candidate =
        largestFromSrcset(img.getAttribute("data-srcset") || img.getAttribute("data-lazy-srcset")) ||
        largestFromSrcset(img.getAttribute("srcset"));
      if (picture) {
        for (const source of picture.querySelectorAll("source")) {
          const c = largestFromSrcset(source.getAttribute("srcset") || source.getAttribute("data-srcset"));
          if (c && !candidate) candidate = c;
        }
      }
      const raw =
        candidate ||
        img.getAttribute("data-src") ||
        img.getAttribute("data-lazy-src") ||
        img.getAttribute("data-original") ||
        (img.currentSrc && !img.currentSrc.startsWith("data:") ? img.currentSrc : null) ||
        img.getAttribute("src");
      if (!raw || raw.startsWith("data:")) continue;
      const url = abs(raw);
      if (!url) continue;
      const marker = logoMarker(img);
      const header = inHeader(img);
      const isLogo = header && (LOGO_RE.test(marker) || !!img.closest("a[href='/'], a[href='./']"));
      const nw = img.naturalWidth || 0;
      const nh = img.naturalHeight || 0;
      if (!isLogo) {
        if ((nw && nw < 2) || (nh && nh < 2)) continue;
        if (/\.svg(\?|$)/i.test(url)) continue;
        if (Math.max(r.width, nw) < 150 && Math.max(r.height, nh) < 150) continue;
      }
      push({
        url,
        kind: isLogo ? "logo" : "photo",
        alt: clean(img.getAttribute("alt"), 200) || null,
        context: isLogo ? null : contextOf(img),
        width: Math.round(r.width),
        height: Math.round(r.height),
        naturalWidth: nw,
        naturalHeight: nh,
        top: Math.round(r.top + scrollY),
        svg: null,
      });
    }
    // Вбудовані SVG-лого в шапці.
    for (const svg of document.querySelectorAll("header svg, [role='banner'] svg, [class*='header' i] svg")) {
      const marker = `${logoMarker(svg)} ${svg.querySelector("title")?.textContent || ""}`;
      if (!LOGO_RE.test(marker) && !svg.closest("a[href='/'], a[href='./']")) continue;
      const r = svg.getBoundingClientRect();
      if (r.width < 24 || r.height < 12) continue;
      const clone = svg.cloneNode(true);
      if (!clone.getAttribute("xmlns")) clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      if (!clone.getAttribute("width")) clone.setAttribute("width", String(Math.round(r.width)));
      if (!clone.getAttribute("height")) clone.setAttribute("height", String(Math.round(r.height)));
      const markup = clone.outerHTML;
      if (markup.length > 200000) continue;
      push({
        url: `inline-svg:${out.length}`,
        kind: "logo",
        alt: clean(svg.getAttribute("aria-label") || svg.querySelector("title")?.textContent, 200) || null,
        context: null,
        width: Math.round(r.width),
        height: Math.round(r.height),
        naturalWidth: 0,
        naturalHeight: 0,
        top: Math.round(r.top + scrollY),
        svg: markup,
      });
    }
    // CSS-фони великих блоків.
    let n = 0;
    for (const el of document.body.querySelectorAll("*")) {
      if (++n > 4000) break;
      const bg = getComputedStyle(el).backgroundImage;
      if (!bg || bg === "none" || !bg.includes("url(")) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 600) continue;
      const m = /url\(\s*["']?([^"')]+)["']?\s*\)/.exec(bg);
      if (!m || m[1].startsWith("data:")) continue;
      const url = abs(m[1]);
      if (!url) continue;
      push({
        url,
        kind: "background",
        alt: clean(el.getAttribute("aria-label"), 200) || null,
        context: contextOf(el) || clean(el.innerText, 200) || null,
        width: Math.round(r.width),
        height: Math.round(r.height),
        naturalWidth: 0,
        naturalHeight: 0,
        top: Math.round(r.top + scrollY),
        svg: null,
      });
    }
    for (const link of document.querySelectorAll(
      "link[rel~='apple-touch-icon'], link[rel~='apple-touch-icon-precomposed']",
    )) {
      const url = abs(link.getAttribute("href"));
      if (url)
        push({
          url,
          kind: "icon",
          alt: null,
          context: null,
          width: 0,
          height: 0,
          naturalWidth: 0,
          naturalHeight: 0,
          top: 0,
          svg: null,
        });
    }
    const og = document.querySelector("meta[property='og:image'], meta[name='og:image']");
    const ogUrl = og ? abs(og.getAttribute("content")) : null;
    if (ogUrl)
      push({
        url: ogUrl,
        kind: "og",
        alt: null,
        context: null,
        width: 0,
        height: 0,
        naturalWidth: 0,
        naturalHeight: 0,
        top: 0,
        svg: null,
      });
    return out;
  }

  function jsonLd() {
    const out = [];
    for (const s of document.querySelectorAll("script[type='application/ld+json']")) {
      try {
        out.push(JSON.parse(s.textContent || ""));
      } catch {
        // битий JSON-LD пропускаємо
      }
    }
    return out;
  }

  // ---------- текст сторінки ----------

  const MAX_TEXT = 20000;

  /** Теги без тексту для читача. */
  const SKIP_TAGS = new Set([
    "SCRIPT",
    "STYLE",
    "NOSCRIPT",
    "TEMPLATE",
    "SVG",
    "CANVAS",
    "IFRAME",
    "OBJECT",
    "EMBED",
    "VIDEO",
    "AUDIO",
    "SELECT",
    "OPTION",
    "DATALIST",
    "TEXTAREA",
    "INPUT",
    "IMG",
    "PICTURE",
    "MAP",
    "HEAD",
  ]);

  /** Блокові теги — для елементів без computed style (приховані, display: none). */
  const BLOCK_TAGS = new Set([
    "ADDRESS",
    "ARTICLE",
    "ASIDE",
    "BLOCKQUOTE",
    "BODY",
    "CAPTION",
    "DD",
    "DETAILS",
    "DIALOG",
    "DIV",
    "DL",
    "DT",
    "FIELDSET",
    "FIGCAPTION",
    "FIGURE",
    "FOOTER",
    "FORM",
    "HEADER",
    "HGROUP",
    "HR",
    "LEGEND",
    "LI",
    "MAIN",
    "NAV",
    "OL",
    "P",
    "PRE",
    "SECTION",
    "SUMMARY",
    "TABLE",
    "TBODY",
    "TD",
    "TFOOT",
    "TH",
    "THEAD",
    "TR",
    "UL",
  ]);

  const CHROME_ROLES = new Set(["navigation", "banner", "contentinfo"]);

  /** Шапка, навігація, футер, бічна колонка. header/footer усередині main/article/section — частина змісту. */
  const isChrome = (el) => {
    const tag = el.tagName;
    if (tag === "NAV" || tag === "ASIDE") return true;
    if (CHROME_ROLES.has(el.getAttribute("role"))) return true;
    return (tag === "HEADER" || tag === "FOOTER") && !el.parentElement?.closest("main, article, section");
  };

  /**
   * Як `isChrome`, але для тексту: шапка з h1 — це перший екран (hero), а не лише логотип і меню.
   * Її текст читаємо (меню в ній — `nav` — однаково пропускається); для кліків вона лишається шапкою.
   */
  const isTextChrome = (el) => isChrome(el) && !(el.tagName === "HEADER" && el.querySelector("h1"));

  /**
   * Піддерево не дає тексту: службові теги, шапка/футер, aria-hidden, сховані нами банери й чати.
   * Усередині демо-блоку (мок продукту) меню й aria-hidden — частина картинки, їх читаємо.
   */
  const skipText = (el, demo = false) =>
    SKIP_TAGS.has(el.tagName.toUpperCase()) ||
    el.hasAttribute("data-adc-hidden") ||
    (!demo && (isTextChrome(el) || el.getAttribute("aria-hidden") === "true"));

  /** Елемент лежить у шапці/футері/навігації, діалозі або схованому нами оверлеї. */
  const inChrome = (el) => {
    for (let node = el; node && node !== document.body; node = node.parentElement) {
      if (isChrome(node) || node.hasAttribute("data-adc-hidden")) return true;
      if (
        node.tagName === "DIALOG" ||
        node.getAttribute("role") === "dialog" ||
        node.getAttribute("aria-modal") === "true"
      )
        return true;
    }
    return false;
  };

  const headingLevel = (el) => {
    if (/^H[1-6]$/.test(el.tagName)) return Number(el.tagName[1]);
    if (el.getAttribute("role") === "heading") {
      const level = Number.parseInt(el.getAttribute("aria-level") || "2", 10);
      return level >= 1 && level <= 6 ? level : 2;
    }
    return 0;
  };

  /**
   * Як елемент ділить текст: "block" — окремий рядок, "spaced" — inline-block/inline-flex
   * (сусіди відокремлюються пробілом, щоб не склеїлись слова), "inline" — потік тексту.
   * Для прихованих елементів computed style немає — тоді за тегом.
   */
  const flowOf = (el) => {
    let display = "";
    try {
      display = getComputedStyle(el).display;
    } catch {
      display = "";
    }
    if (!display || display === "none") return BLOCK_TAGS.has(el.tagName) ? "block" : "inline";
    if (display === "contents" || display === "inline") return "inline";
    if (display.startsWith("inline") || display.startsWith("ruby")) return "spaced";
    return "block";
  };

  /** Пункти списків і визначень: окремі рядки без порожнього рядка між ними. */
  const ITEM_TAGS = new Set(["LI", "DT", "DD"]);

  /** Класи елемента рядком; camelCase розбитий дефісом (`FaqItem` → `Faq-Item`), щоб працювали межі слів. */
  const classOf = (el) =>
    String((typeof el.className === "string" ? el.className : el.getAttribute?.("class")) || "").replace(
      /([a-z])([A-Z])/g,
      "$1-$2",
    );

  // ---------- демо-дані: мок продукту на лендингу ----------

  /** Маркер для евристик: id, класи, роль, aria-label, data-атрибути (camelCase → через дефіс). */
  const markerOf = (el) => {
    const parts = [el.id, classOf(el), el.getAttribute("role"), el.getAttribute("aria-label")];
    for (const a of el.attributes) {
      if (!a.name.startsWith("data-") || a.name.startsWith("data-adc")) continue;
      parts.push(a.name.slice(5));
      // Лише значення-ідентифікатори: у звичайному тексті атрибута «sample» чи «report» — не маркер.
      if (/^[\w-]{1,40}$/.test(a.value)) parts.push(a.value);
    }
    return parts
      .filter(Boolean)
      .join(" ")
      .replace(/([a-z])([A-Z])/g, "$1-$2");
  };

  /** Мок звіту, дашборду, вікна застосунку; демо, приклад, зразок результату. */
  const DEMO_HINT =
    /(?:^|[^a-z])(?:(?:demo|mock|mockup|preview|sample|example|report|dashboard)s?|app-?(?:ui|window|frame|screen|shell|mock)|browser-?(?:window|frame|mock)|product-?(?:ui|shot|preview|demo)|fake-?(?:ui|app))(?![a-z])/i;
  /** Прев'ю записів блогу й новин — звичайний зміст, а не демо. */
  const DEMO_NOT = /(?:^|[^a-z])(?:blog|post|news|article)/i;
  /** Копії слайдів каруселей і бігучих рядків: aria-hidden дублікати справжнього тексту. */
  const CLONE_HINT =
    /slick|swiper|carousel|slider|slide|marquee|ticker|clone|duplicate|glide|splide|owl|embla/i;

  const cloneLike = (el) => {
    for (let node = el, i = 0; node && node !== document.body && i < 4; i++, node = node.parentElement)
      if (CLONE_HINT.test(markerOf(node))) return true;
    return false;
  };

  /**
   * Корінь демо-блоку: мок звіту/дашборду на лендингу (маркер demo/mock/report/…) або декоративна
   * копія інтерфейсу, схована від скрінрідерів (`aria-hidden`), але видима на сторінці. Блок із h1/h2 —
   * це секція з маркетинговим текстом навколо мока, а не мок: її обходимо звичайно, мок знайдеться глибше.
   */
  const isDemoRoot = (el) => {
    if (SKIP_TAGS.has(el.tagName.toUpperCase()) || isTextChrome(el) || el.hasAttribute("data-adc-hidden"))
      return false;
    const hidden = el.getAttribute("aria-hidden") === "true";
    const marker = markerOf(el);
    const hinted = DEMO_HINT.test(marker) && !DEMO_NOT.test(marker);
    if (!hinted && !(hidden && isVisible(el))) return false;
    if (hidden && cloneLike(el)) return false;
    if (el.querySelector("h1, h2")) return false;
    const len = (el.textContent || "").trim().length;
    return len >= 8 && len <= 6000;
  };

  /**
   * Знімки розкритого змісту (вкладки, акордеони з одним відкритим пунктом), зроблені
   * під час розкриття. Запис виводиться один раз: там, де обхід уперше дійде до регіону, або одразу
   * після тригера (вкладка, кнопка питання), якщо регіону вже немає в DOM.
   */
  const snapshots = { byAnchor: new Map(), byRegion: new Map() };

  const remember = (map, el, entry) => {
    const list = map.get(el);
    if (list) list.push(entry);
    else map.set(el, [entry]);
  };

  /**
   * Блоковий текст піддерева в порядку документа. Заголовок — рядок `## …` (кількість `#` — рівень);
   * абзаци й блоки відділені порожнім рядком (елемент `""`); пункти списків і рядки таблиць
   * (`клітинка | клітинка`) — окремі рядки підряд; inline-текст склеюється пробілом. Демо-блок
   * (мок продукту) — рядки з префіксом `> `.
   */
  function blockLines(root, opts) {
    const lines = [];
    const useSnapshots = opts?.snapshots === true;
    const demo = opts?.demo === true;
    const findDemo = !demo && !opts?.childrenOnly;
    const limit = opts?.limit ?? MAX_TEXT;
    let buf = "";
    let size = 0;
    let visited = 0;
    /** Глибина пунктів списку: усередині пункту абзаци не розділяються порожнім рядком. */
    let tight = 0;

    const push = (line) => {
      if (line === "" && (lines.length === 0 || lines.at(-1) === "")) return;
      lines.push(line);
      size += line.length + 1;
    };
    const flush = () => {
      const t = buf.replace(/\s+/g, " ").trim();
      buf = "";
      if (t) push(t);
    };
    /** Межа абзацу — порожній рядок (усередині пункту списку — лише перенос). */
    const para = () => {
      flush();
      if (!tight) push("");
    };
    const emit = (entries) => {
      if (!entries) return;
      for (const entry of entries) {
        if (entry.done) continue;
        entry.done = true;
        para();
        for (const line of entry.lines) push(line);
        para();
      }
    };
    /** Текст елемента одним рядком (заголовок, клітинка таблиці). */
    const flat = (el) =>
      blockLines(el, { limit: 2000, childrenOnly: true, demo }).join(" ").replace(/\s+/g, " ").trim();

    const walk = (node) => {
      if (size > limit || ++visited > 40000) return;
      if (node.nodeType === 3) {
        buf += node.data;
        return;
      }
      if (node.nodeType !== 1) return;
      const el = node;
      if (useSnapshots) emit(snapshots.byRegion.get(el));
      if (findDemo && isDemoRoot(el)) {
        const quoted = blockLines(el, { limit: 4000, demo: true }).filter(Boolean);
        if (quoted.length >= 2) {
          para();
          for (const line of quoted) push(`> ${line}`);
          para();
          if (useSnapshots) emit(snapshots.byAnchor.get(el));
          return;
        }
      }
      if (skipText(el, demo)) return;
      // Тригер зі знімком (вкладка, питання) — окремий рядок, навіть якщо він inline-block.
      if (useSnapshots && snapshots.byAnchor.has(el)) flush();
      if (el.tagName === "BR") {
        flush();
        return;
      }
      const level = headingLevel(el);
      if (level) {
        para();
        const t = flat(el);
        // У демо-блоці заголовок картки — звичайний рядок мока.
        if (t) push(demo ? t : `${"#".repeat(level)} ${t}`);
        para();
      } else if (el.tagName === "TR") {
        flush();
        const cells = Array.from(el.children)
          .filter((c) => (c.tagName === "TD" || c.tagName === "TH") && !skipText(c, demo))
          .map(flat)
          .filter(Boolean);
        if (cells.length) push(cells.join(" | "));
      } else {
        const flow = flowOf(el);
        const item = flow === "block" && ITEM_TAGS.has(el.tagName);
        if (item) {
          flush();
          tight++;
        } else if (flow === "block") para();
        else if (flow === "spaced") buf += " ";
        for (const child of el.childNodes) walk(child);
        if (item) {
          flush();
          tight--;
        } else if (flow === "block") para();
        else if (flow === "spaced") buf += " ";
      }
      if (useSnapshots) emit(snapshots.byAnchor.get(el));
    };

    if (opts?.childrenOnly) for (const child of root.childNodes) walk(child);
    else walk(root);
    flush();
    while (lines.at(-1) === "") lines.pop();
    return lines;
  }

  /**
   * Основний текст сторінки без шапки/футера/навігації, з розкритими вкладками й акордеонами:
   * абзаци через порожній рядок, демо-дані — рядки `> …`.
   */
  function mainText() {
    const lines = blockLines(document.body, { snapshots: true });
    // Решта знімків, чиї регіон і тригер зникли з DOM.
    for (const list of snapshots.byAnchor.values())
      for (const entry of list) {
        if (entry.done) continue;
        entry.done = true;
        lines.push("", ...entry.lines);
      }
    // Рядок мока, що дослівно повторює звичайний текст (копія слайда, той самий список), — зайвий.
    const plain = new Set(lines.filter((l) => l && !l.startsWith("> ")));
    const out = [];
    const seen = new Set();
    let last = "";
    let size = 0;
    for (const line of lines) {
      if (line === "") {
        if (out.length && out.at(-1) !== "") out.push("");
        continue;
      }
      if (!/[\p{L}\p{N}]/u.test(line)) continue;
      if (line.startsWith("> ") && plain.has(line.slice(2))) continue;
      // Повтори (мобільна й десктопна версії блоку, знімок і живий DOM) — один раз; короткі
      // мітки на кшталт «$10» чи «Так» можуть законно повторюватись у різних картках.
      if (line.length >= 4) {
        if (seen.has(line)) continue;
        seen.add(line);
      } else if (last === line) continue;
      out.push(line);
      last = line;
      size += line.length + 1;
      if (size > MAX_TEXT) break;
    }
    while (out.at(-1) === "") out.pop();
    return out.join("\n").slice(0, MAX_TEXT);
  }

  // ---------- розкриття згорнутого ----------

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  /** Тригер веде на іншу сторінку або відправляє форму — не клікаємо. */
  const leavesPage = (el) => {
    const link = el.closest("a[href]");
    if (link) {
      const href = (link.getAttribute("href") || "").trim();
      if (href && !href.startsWith("#") && !/^javascript:/i.test(href)) return true;
    }
    if (el.tagName === "BUTTON" && el.form && (el.getAttribute("type") || "submit") !== "button") return true;
    return el.tagName === "INPUT";
  };

  /** Кнопка-розкривачка змісту: видима, поза шапкою/футером/діалогами, не меню й не перехід. */
  const isExpander = (el) => {
    if (inChrome(el) || leavesPage(el) || !isVisible(el)) return false;
    const role = el.getAttribute("role");
    if (role === "tab" || role === "combobox" || role === "menuitem" || role === "option") return false;
    const popup = el.getAttribute("aria-haspopup");
    return !popup || popup === "false";
  };

  const controlled = (el) => {
    for (const id of (el.getAttribute("aria-controls") || "").split(/\s+/)) {
      const target = id ? document.getElementById(id) : null;
      if (target) return target;
    }
    return null;
  };

  /** Панель за `href="#id"` чи `data-target`/`data-bs-target` (Bootstrap collapse і tabs). */
  const targetOf = (el) => {
    for (const v of [
      el.getAttribute("href"),
      el.getAttribute("data-target"),
      el.getAttribute("data-bs-target"),
    ]) {
      if (!v || !/^#[\w-]+$/.test(v)) continue;
      const target = document.getElementById(v.slice(1));
      if (target) return target;
    }
    return null;
  };

  /** Регіон, який відкриває тригер: aria-controls/data-target або найближчий предок із текстом, ширшим за тригер. */
  const regionOf = (el) => {
    const target = controlled(el) || targetOf(el);
    if (target) return target;
    const own = (el.textContent || "").trim().length;
    let node = el.parentElement;
    for (let i = 0; node && node !== document.body && i < 3; i++, node = node.parentElement) {
      const len = (node.textContent || "").trim().length;
      if (len > own + 1) return len <= 4000 ? node : null;
    }
    return null;
  };

  const PANEL_SEL = [
    "[role='tabpanel']",
    "[class*='tab-content' i]",
    "[class*='tab-pane' i]",
    "[class*='tab-panel' i]",
    "[class*='tabpanel' i]",
    "[class*='tabs-content' i]",
    "[class*='tabs-panel' i]",
    "[class*='tabs__content' i]",
    "[class*='tabs__panel' i]",
  ].join(", ");

  /** Активна панель вкладки: aria-controls/href, або видима панель (tabpanel, tab-content, tab-pane) поруч зі списком. */
  const panelOf = (tab, list) => {
    const target = controlled(tab) || targetOf(tab);
    if (target) return target;
    let scope = list;
    for (let i = 0; scope && i < 5; i++, scope = scope.parentElement) {
      const panel = Array.from(scope.querySelectorAll(PANEL_SEL)).find(
        (p) => !p.contains(list) && isVisible(p),
      );
      if (panel) return panel;
      if (scope === document.body) break;
    }
    return null;
  };

  /** Знімок тексту регіону після кліку на тригер. */
  const snapshot = (anchor, region) => {
    if (!region) return;
    const lines = blockLines(region, { limit: 6000 });
    if (!lines.length) return;
    const entry = { lines, done: false };
    remember(snapshots.byAnchor, anchor, entry);
    remember(snapshots.byRegion, region, entry);
  };

  /**
   * Запасний клік подіями в самій сторінці, якщо Playwright не зміг клікнути (тригер перекритий
   * чи рухається). Повна послідовність: частина бібліотек (Radix Tabs) слухає mousedown, а не click.
   */
  const press = (el) => {
    const init = { bubbles: true, cancelable: true, view: window, button: 0 };
    const pointer = (type) => {
      try {
        el.dispatchEvent(new PointerEvent(type, { ...init, pointerType: "mouse", isPrimary: true }));
      } catch {
        // PointerEvent недоступний — лишаються mouse-події
      }
    };
    pointer("pointerdown");
    el.dispatchEvent(new MouseEvent("mousedown", init));
    try {
      el.focus({ preventScroll: true });
    } catch {
      // ігноруємо
    }
    pointer("pointerup");
    el.dispatchEvent(new MouseEvent("mouseup", init));
    el.click();
  };

  /** Класи акордеонів, згортань, FAQ і вкладок: accordion-button, faq__question, collapsed, nav-tabs… */
  const EXPAND_CLASS = /(?:^|[^a-z])(?:accordion|collaps(?:e|ed|ible|ing)?|faqs?|tabs?)(?![a-z])/i;
  const TAB_CLASS = /(?:^|[^a-z])tabs?(?![a-z])/i;
  /** Панель зі змістом (а не заголовок, що її відкриває); `collapse` — панель Bootstrap, `collapsed` — тригер. */
  const PANEL_CLASS = /(?:^|[^a-z])(?:content|body|panel|pane|answer|collapse)(?![a-z])/i;
  const OPEN_CLASS =
    /(?:^|[\s_-])(?:is-)?(?:open|opened|active|expanded|show|shown|current|selected)(?:$|\s)/i;
  /** Інтерактивні елементи всередині контейнера з класом акордеона чи вкладок. */
  const INTERACTIVE =
    "button, [role='button'], [role='tab'], summary, a[href^='#'], [data-toggle], [data-bs-toggle], [tabindex]:not([tabindex='-1'])";

  /** Схоже на клікабельний тригер: кнопка/посилання/tabindex, onclick або курсор-рука. */
  const triggerLike = (el) => {
    if (el.matches(INTERACTIVE) || el.hasAttribute("onclick")) return true;
    try {
      return getComputedStyle(el).cursor === "pointer";
    } catch {
      return false;
    }
  };

  /** Тригер лежить у панелі зі змістом (кнопка «Детальніше» всередині відповіді) — це не заголовок. */
  const inPanel = (el, scope) => {
    for (
      let node = el.parentElement;
      node && node !== scope && node !== document.body;
      node = node.parentElement
    ) {
      const role = node.getAttribute("role");
      if (role === "tabpanel" || role === "region" || PANEL_CLASS.test(classOf(node))) return true;
    }
    return false;
  };

  /** Тригер без ARIA вже розкритий: стан open/active у нього чи предків, або видима відповідь одразу після нього. */
  const looksOpen = (el) => {
    if (/(?:^|\s)collapsed(?:$|\s)/i.test(classOf(el))) return false;
    for (let node = el, i = 0; node && node !== document.body && i < 3; i++, node = node.parentElement) {
      if (node.getAttribute("aria-expanded") === "true" || node.getAttribute("aria-selected") === "true")
        return true;
      const state = node.getAttribute("data-state");
      if (state === "open" || state === "active") return true;
      if (OPEN_CLASS.test(classOf(node))) return true;
    }
    // Кнопка в обгортці-заголовку (h3, .accordion-header): відповідь — сусід обгортки.
    let base = el;
    const wrap = el.parentElement;
    if (
      !el.nextElementSibling &&
      wrap?.childElementCount === 1 &&
      (headingLevel(wrap) || /head|title|question|trigger|toggle/i.test(classOf(wrap)))
    )
      base = wrap;
    const next = base.nextElementSibling;
    // Сусід того ж типу — наступне питання, а не відповідь.
    if (!next || (next.tagName === base.tagName && classOf(next) === classOf(base))) return false;
    return isVisible(next) && clean(next.innerText).length > 0;
  };

  /** Вкладка за класом (без ARIA) зараз активна. */
  const activeTab = (el) =>
    el.getAttribute("aria-selected") === "true" ||
    el.getAttribute("data-state") === "active" ||
    OPEN_CLASS.test(classOf(el)) ||
    (el.parentElement?.tagName === "LI" && OPEN_CLASS.test(classOf(el.parentElement)));

  /** Список вкладок без ARIA (клас tabs, tab-list, nav-tabs) для тригера, або null. */
  const tabListOf = (el) => {
    let node = el.parentElement;
    for (let i = 0; node && node !== document.body && i < 3; i++, node = node.parentElement) {
      const cls = classOf(node);
      if (TAB_CLASS.test(cls) && !PANEL_CLASS.test(cls)) return node;
    }
    return TAB_CLASS.test(classOf(el)) ? el.parentElement : null;
  };

  const byDocument = (a, b) => {
    if (a === b) return 0;
    return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  };

  /** Тригери поточного плану: id → { el, kind, list }. Playwright клікає їх за атрибутом `data-adc-x`. */
  const registry = new Map();
  let planSeq = 0;
  let planScrollY = 0;

  const register = (el, kind, list = null) => {
    const id = String(++planSeq);
    el.setAttribute("data-adc-x", id);
    registry.set(id, { el, kind, list });
    return { id, kind };
  };

  /**
   * План розкриття згорнутого змісту перед збором тексту. `<details>` відкриває одразу. Тригери —
   * `[aria-expanded="false"]`, заголовки акордеонів/FAQ/згортань за класами `accordion|collapse|faq|tab`,
   * вкладки `[role="tab"]` і вкладки за класами — позначає `data-adc-x` і повертає кроки в порядку
   * документа: не більше `maxClicks` кліків разом із поверненням початкової вкладки. Шапка, меню,
   * футер, діалоги, переходи на інші сторінки й уже розкриті пункти не клікаються.
   */
  function expandPlan(opts) {
    const maxClicks = opts?.maxClicks ?? 40;
    registry.clear();
    for (const el of document.querySelectorAll("[data-adc-x]")) el.removeAttribute("data-adc-x");
    planScrollY = window.scrollY;
    let details = 0;
    for (const d of document.body.querySelectorAll("details:not([open])")) {
      if (inChrome(d)) continue;
      d.open = true;
      details++;
    }

    const toggles = new Set();
    /** Уже розкриті пункти: знімаємо одразу — клік по сусідньому пункту може їх закрити й прибрати з DOM. */
    const opened = new Set();
    for (const el of document.body.querySelectorAll("[aria-expanded]")) {
      if (!isExpander(el)) continue;
      if (el.getAttribute("aria-expanded") === "false") toggles.add(el);
      else if (el.getAttribute("aria-expanded") === "true") opened.add(el);
    }

    // Вкладки: [role=tab] групуються за tablist, вкладки за класами — за контейнером із класом tabs.
    const groups = new Map();
    const addTab = (list, tab) => {
      if (!groups.has(list)) groups.set(list, new Set());
      groups.get(list).add(tab);
    };
    for (const tab of document.body.querySelectorAll("[role='tab']")) {
      if (inChrome(tab) || leavesPage(tab) || !isVisible(tab)) continue;
      const list = tab.closest("[role='tablist']") || tab.parentElement;
      if (list) addTab(list, tab);
    }

    // Акордеони, FAQ і вкладки без ARIA — за класами.
    let scanned = 0;
    for (const scope of document.body.querySelectorAll("[class]")) {
      if (++scanned > 8000) break;
      const cls = classOf(scope);
      if (!EXPAND_CLASS.test(cls) || PANEL_CLASS.test(cls) || inChrome(scope)) continue;
      const inner = Array.from(scope.querySelectorAll(INTERACTIVE)).slice(0, 80);
      const candidates = inner.length === 0 && triggerLike(scope) ? [scope] : inner;
      for (const el of candidates) {
        if (toggles.has(el) || el.hasAttribute("aria-expanded") || el.tagName === "SUMMARY") continue;
        if (el.getAttribute("role") === "tab") continue;
        if (!isExpander(el) || inPanel(el, scope) || PANEL_CLASS.test(classOf(el))) continue;
        const text = clean(el.innerText, 300);
        if (!text || text.length > 200) continue;
        const list = tabListOf(el);
        if (list) addTab(list, el);
        else if (looksOpen(el)) opened.add(el);
        else toggles.add(el);
      }
    }
    for (const el of opened) snapshot(el, regionOf(el));

    const units = [];
    for (const [list, set] of groups) {
      const tabs = [...set].sort(byDocument);
      if (tabs.length < 2) {
        // Одинока «вкладка» за класом (accordion-tab) — звичайна розкривачка.
        for (const t of tabs) if (t.getAttribute("role") !== "tab" && !looksOpen(t)) toggles.add(t);
        continue;
      }
      // Початкова вкладка вже показує свою панель: її не клікаємо, а повертаємо наприкінці.
      const initial = tabs.find(activeTab) ?? null;
      units.push({ at: tabs[0], list, initial, tabs: tabs.filter((t) => t !== initial) });
    }
    // Вкладений тригер (заголовок у клікабельному пункті) — клікаємо лише найглибший.
    const flat = [...toggles];
    for (const el of flat) {
      if (!flat.some((o) => o !== el && el.contains(o))) units.push({ at: el, toggle: el });
    }
    units.sort((a, b) => byDocument(a.at, b.at));

    const steps = [];
    let budget = maxClicks;
    for (const unit of units) {
      if (budget <= 0) break;
      if (unit.toggle) {
        steps.push(register(unit.toggle, "toggle"));
        budget--;
        continue;
      }
      const restore = unit.initial ? 1 : 0;
      const take = Math.min(unit.tabs.length, budget - restore);
      if (take < 1) continue;
      for (const tab of unit.tabs.slice(0, take)) steps.push(register(tab, "tab", unit.list));
      // Повертаємо вкладку за замовчуванням — скриншот має показати сторінку такою, як її бачить відвідувач.
      if (unit.initial) steps.push(register(unit.initial, "restore", unit.list));
      budget -= take + restore;
    }
    return { details, steps };
  }

  /** Перед кліком: тригер ще в DOM, видимий і досі згорнутий (сусідній клік міг його розкрити чи прибрати). */
  function expandBefore(id) {
    const item = registry.get(id);
    if (!item?.el.isConnected || !isVisible(item.el)) return false;
    if (item.kind !== "toggle") return true;
    const state = item.el.getAttribute("aria-expanded");
    if (state !== null) return state === "false";
    return !looksOpen(item.el);
  }

  function expandPress(id) {
    const item = registry.get(id);
    if (!item?.el.isConnected) return false;
    press(item.el);
    return true;
  }

  /**
   * Після кліку: коротка пауза і знімок регіону (акордеон з одним відкритим пунктом закриє
   * попередню відповідь, вкладка замінить панель).
   */
  async function expandAfter(args) {
    await wait(args?.wait ?? 80);
    const item = registry.get(args?.id);
    if (!item || item.kind === "restore") return false;
    snapshot(item.el, item.kind === "tab" ? panelOf(item.el, item.list) : regionOf(item.el));
    return true;
  }

  /** Наприкінці: пауза, поки домалюється зміст, прибирання позначок і повернення прокрутки. */
  async function expandFinish(args) {
    if (args?.settle) await wait(args.settle);
    for (const el of document.querySelectorAll("[data-adc-x]")) el.removeAttribute("data-adc-x");
    registry.clear();
    window.scrollTo(0, planScrollY);
    return true;
  }

  function extract(opts) {
    const meta = (sel) => clean(document.querySelector(sel)?.getAttribute("content"), 1000) || null;
    const og = {};
    for (const m of document.querySelectorAll(
      "meta[property^='og:'], meta[name^='og:'], meta[name^='twitter:']",
    )) {
      const key = m.getAttribute("property") || m.getAttribute("name");
      const value = clean(m.getAttribute("content"), 1000);
      if (key && value && !(key in og)) og[key] = value;
    }
    const headings = [];
    for (const h of document.querySelectorAll("h1, h2, h3, h4, h5, h6")) {
      if (headings.length >= 80) break;
      if (!isVisible(h)) continue;
      const text = clean(h.innerText, 300);
      if (text) headings.push({ level: Number(h.tagName.slice(1)), text });
    }
    const buttons = [];
    for (const b of document.querySelectorAll(BUTTON_SEL)) {
      if (buttons.length >= 40) break;
      if (!isVisible(b)) continue;
      const t = labelOf(b);
      if (t && t.length <= 60 && !buttons.includes(t)) buttons.push(t);
    }
    const nav = [];
    const navSeen = new Set();
    for (const a of document.querySelectorAll("nav a[href], header a[href], [role='navigation'] a[href]")) {
      if (nav.length >= 60) break;
      const url = abs(a.getAttribute("href"));
      const text = clean(a.innerText || a.getAttribute("aria-label") || a.title, 80);
      if (!url || !text || navSeen.has(url)) continue;
      navSeen.add(url);
      nav.push({ text, url });
    }
    const links = [];
    const linkSeen = new Set();
    for (const a of document.querySelectorAll("a[href]")) {
      if (links.length >= 600) break;
      const href = a.getAttribute("href") || "";
      if (/^(mailto|tel|javascript|sms|viber|whatsapp):/i.test(href) || href.startsWith("#")) continue;
      const url = abs(href);
      if (!url || linkSeen.has(url)) continue;
      linkSeen.add(url);
      links.push({
        url,
        text: clean(a.innerText || a.getAttribute("aria-label") || a.title, 120),
        inNav: !!a.closest("nav, header, [role='navigation']"),
      });
    }
    const hreflang = [];
    for (const l of document.querySelectorAll("link[rel='alternate'][hreflang]")) {
      const href = abs(l.getAttribute("href"));
      if (href) hreflang.push({ hreflang: l.getAttribute("hreflang") || "", href });
    }
    const phones = [];
    const emails = [];
    const socials = [];
    for (const a of document.querySelectorAll("a[href]")) {
      const href = a.getAttribute("href") || "";
      if (/^tel:/i.test(href)) phones.push(decodeURIComponent(href.slice(4)));
      else if (/^mailto:/i.test(href)) emails.push(decodeURIComponent(href.slice(7).split("?")[0]));
      else {
        try {
          const u = new URL(href, document.baseURI);
          const host = u.hostname.toLowerCase();
          const net = SOCIAL.find(([, re]) => re.test(host));
          if (net && u.pathname.length > 1 && !/\/(sharer|share|intent|dialog)/i.test(u.pathname))
            socials.push({ network: net[0], url: u.href });
        } catch {
          // ігноруємо
        }
      }
    }
    const addresses = [];
    for (const el of document.querySelectorAll("address, [itemprop='address'], [class*='address' i]")) {
      if (addresses.length >= 10) break;
      const t = clean(el.innerText, 300);
      if (t.length >= 8 && !addresses.includes(t)) addresses.push(t);
    }
    return {
      url: location.href,
      title: clean(document.title, 300),
      description: meta("meta[name='description']"),
      lang: document.documentElement.getAttribute("lang") || null,
      og,
      jsonLd: jsonLd(),
      headings,
      buttons,
      nav,
      links,
      hreflang,
      text: mainText(),
      contacts: { phones, emails, socials, addresses, bodyText: clean(document.body?.innerText, 50000) },
      design: opts?.withDesign === false ? null : design(),
      images: images(),
      docHeight: document.documentElement.scrollHeight,
    };
  }

  return {
    dismissConsent,
    hideOverlays,
    autoScroll,
    waitForFonts,
    expandPlan,
    expandBefore,
    expandPress,
    expandAfter,
    expandFinish,
    extract,
  };
})();
