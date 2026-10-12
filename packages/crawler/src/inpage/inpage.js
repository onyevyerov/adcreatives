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

  /** Піддерево не дає тексту: службові теги, шапка/футер, aria-hidden, сховані нами банери й чати. */
  const skipText = (el) =>
    SKIP_TAGS.has(el.tagName.toUpperCase()) ||
    isChrome(el) ||
    el.getAttribute("aria-hidden") === "true" ||
    el.hasAttribute("data-adc-hidden");

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

  /**
   * Знімки розкритого змісту (вкладки, акордеони з одним відкритим пунктом), зроблені
   * в `expand`. Запис виводиться один раз: там, де обхід уперше дійде до регіону, або одразу
   * після тригера (вкладка, кнопка питання), якщо регіону вже немає в DOM.
   */
  const snapshots = { byAnchor: new Map(), byRegion: new Map() };

  const remember = (map, el, entry) => {
    const list = map.get(el);
    if (list) list.push(entry);
    else map.set(el, [entry]);
  };

  /**
   * Блоковий текст піддерева в порядку документа: заголовок — рядок `## …` (кількість `#` —
   * рівень), абзаци, пункти списків і блоки — окремі рядки, рядок таблиці — `клітинка | клітинка`.
   * Між блоками завжди перенос рядка, тож тексти сусідніх блоків не склеюються.
   */
  function blockLines(root, opts) {
    const lines = [];
    const useSnapshots = opts?.snapshots === true;
    const limit = opts?.limit ?? MAX_TEXT;
    let buf = "";
    let size = 0;
    let visited = 0;

    const push = (line) => {
      lines.push(line);
      size += line.length + 1;
    };
    const flush = () => {
      const t = buf.replace(/\s+/g, " ").trim();
      buf = "";
      if (t) push(t);
    };
    const emit = (entries) => {
      if (!entries) return;
      for (const entry of entries) {
        if (entry.done) continue;
        entry.done = true;
        flush();
        for (const line of entry.lines) push(line);
      }
    };
    /** Текст елемента одним рядком (заголовок, клітинка таблиці). */
    const flat = (el) =>
      blockLines(el, { limit: 2000, childrenOnly: true }).join(" ").replace(/\s+/g, " ").trim();

    const walk = (node) => {
      if (size > limit || ++visited > 40000) return;
      if (node.nodeType === 3) {
        buf += node.data;
        return;
      }
      if (node.nodeType !== 1) return;
      const el = node;
      if (useSnapshots) emit(snapshots.byRegion.get(el));
      if (skipText(el)) return;
      if (el.tagName === "BR") {
        flush();
        return;
      }
      const level = headingLevel(el);
      if (level) {
        flush();
        const t = flat(el);
        if (t) push(`${"#".repeat(level)} ${t}`);
      } else if (el.tagName === "TR") {
        flush();
        const cells = Array.from(el.children)
          .filter((c) => (c.tagName === "TD" || c.tagName === "TH") && !skipText(c))
          .map(flat)
          .filter(Boolean);
        if (cells.length) push(cells.join(" | "));
      } else {
        const flow = flowOf(el);
        if (flow === "block") flush();
        else if (flow === "spaced") buf += " ";
        for (const child of el.childNodes) walk(child);
        if (flow === "block") flush();
        else if (flow === "spaced") buf += " ";
      }
      if (useSnapshots) emit(snapshots.byAnchor.get(el));
    };

    if (opts?.childrenOnly) for (const child of root.childNodes) walk(child);
    else walk(root);
    flush();
    return lines;
  }

  /** Основний текст сторінки без шапки/футера/навігації, з розкритими вкладками й акордеонами. */
  function mainText() {
    const lines = blockLines(document.body, { snapshots: true });
    // Решта знімків, чиї регіон і тригер зникли з DOM.
    for (const list of snapshots.byAnchor.values())
      for (const entry of list) {
        if (entry.done) continue;
        entry.done = true;
        lines.push(...entry.lines);
      }
    const out = [];
    const seen = new Set();
    let size = 0;
    for (const line of lines) {
      if (!/[\p{L}\p{N}]/u.test(line)) continue;
      // Повтори (мобільна й десктопна версії блоку, знімок і живий DOM) — один раз; короткі
      // мітки на кшталт «$10» чи «Так» можуть законно повторюватись у різних картках.
      if (line.length >= 4) {
        if (seen.has(line)) continue;
        seen.add(line);
      } else if (out.at(-1) === line) continue;
      out.push(line);
      size += line.length + 1;
      if (size > MAX_TEXT) break;
    }
    return out.join("\n").slice(0, MAX_TEXT);
  }

  // ---------- розкриття згорнутого ----------

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

  /** Регіон, який відкриває тригер: aria-controls або найближчий предок із текстом, ширшим за тригер. */
  const regionOf = (el) => {
    const target = controlled(el);
    if (target) return target;
    const own = (el.textContent || "").trim().length;
    let node = el.parentElement;
    for (let i = 0; node && node !== document.body && i < 3; i++, node = node.parentElement) {
      const len = (node.textContent || "").trim().length;
      if (len > own + 1) return len <= 4000 ? node : null;
    }
    return null;
  };

  /** Активна панель вкладки: aria-controls або видимий [role=tabpanel] поруч зі списком вкладок. */
  const panelOf = (tab, list) => {
    const target = controlled(tab);
    if (target) return target;
    let scope = list.parentElement;
    for (let i = 0; scope && i < 4; i++, scope = scope.parentElement) {
      const panel = Array.from(scope.querySelectorAll("[role='tabpanel']")).find(isVisible);
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

  /** Повна послідовність подій кліку: частина бібліотек (Radix Tabs) слухає mousedown, а не click. */
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

  /**
   * Розкриває згорнутий зміст перед збором тексту: `<details>` → open; кліки по
   * `[aria-expanded="false"]` поза шапкою/навігацією/футером (≤ maxClicks, без переходів на інші
   * сторінки); кожну вкладку `[role="tab"]` активує по черзі й знімає текст її панелі.
   * Після кліку — коротка пауза і знімок регіону (акордеон з одним відкритим пунктом закриє
   * попередню відповідь), наприкінці — пауза `settle`, поки домалюється зміст.
   */
  async function expand(opts) {
    const maxClicks = opts?.maxClicks ?? 40;
    const maxTabs = opts?.maxTabs ?? 40;
    const step = opts?.step ?? 80;
    const settle = opts?.settle ?? 400;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const scrollY = window.scrollY;
    let details = 0;
    let clicked = 0;
    let tabs = 0;

    for (const d of document.body.querySelectorAll("details:not([open])")) {
      if (inChrome(d)) continue;
      d.open = true;
      details++;
    }

    const triggers = Array.from(document.body.querySelectorAll("[aria-expanded='false']"))
      .filter(isExpander)
      .slice(0, maxClicks);
    for (const el of triggers) {
      // Сусідній клік міг уже розкрити цей пункт або прибрати його з DOM.
      if (!el.isConnected || el.getAttribute("aria-expanded") !== "false") continue;
      try {
        el.click();
      } catch {
        continue;
      }
      clicked++;
      await sleep(step);
      snapshot(el, regionOf(el));
    }

    const groups = new Map();
    for (const tab of document.body.querySelectorAll("[role='tab']")) {
      if (inChrome(tab) || leavesPage(tab) || !isVisible(tab)) continue;
      const list = tab.closest("[role='tablist']") || tab.parentElement;
      if (!list) continue;
      if (!groups.has(list)) groups.set(list, []);
      groups.get(list).push(tab);
    }
    for (const [list, group] of groups) {
      if (group.length < 2) continue;
      const initial = group.find((t) => t.getAttribute("aria-selected") === "true");
      for (const tab of group) {
        if (tabs >= maxTabs) break;
        try {
          press(tab);
        } catch {
          continue;
        }
        tabs++;
        await sleep(step * 2);
        snapshot(tab, panelOf(tab, list));
      }
      // Повертаємо вкладку за замовчуванням — скриншот має показати сторінку такою, як її бачить відвідувач.
      if (initial?.isConnected) {
        try {
          press(initial);
        } catch {
          // ігноруємо
        }
      }
    }

    if (details || clicked || tabs) await sleep(settle);
    window.scrollTo(0, scrollY);
    return { details, clicked, tabs };
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

  return { dismissConsent, hideOverlays, autoScroll, waitForFonts, expand, extract };
})();
