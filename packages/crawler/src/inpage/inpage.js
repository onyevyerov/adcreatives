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

  const EXCLUDE =
    "header, footer, nav, aside, [role='banner'], [role='contentinfo'], [role='navigation'], script, style, noscript, template, [aria-hidden='true']";

  /** Текст без шапки/футера: усі текстові блоки поза навігацією. */
  function fallbackText() {
    const parts = [];
    const seen = new Set();
    for (const el of document.body.querySelectorAll(
      "h1, h2, h3, h4, h5, h6, p, li, blockquote, figcaption, dd, dt, td, th, address",
    )) {
      if (el.closest(EXCLUDE)) continue;
      if (el.querySelector("p, li, h1, h2, h3, h4")) continue;
      const t = clean(el.innerText, 2000);
      if (t.length < 2 || seen.has(t)) continue;
      seen.add(t);
      parts.push(t);
    }
    return parts.join("\n");
  }

  function mainText(Readability) {
    const fallback = fallbackText();
    let readable = "";
    if (Readability) {
      try {
        const doc = document.cloneNode(true);
        for (const el of doc.querySelectorAll("header, footer, nav, [role='banner'], [role='contentinfo']"))
          el.remove();
        const parsed = new Readability(doc, { charThreshold: 100 }).parse();
        readable = (parsed?.textContent || "")
          .replace(/[ \t ]+/g, " ")
          .replace(/\s*\n\s*/g, "\n")
          .trim();
      } catch {
        readable = "";
      }
    }
    // На лендингах Readability інколи бере лише один блок — тоді краще повний текст.
    const text = readable.length >= fallback.length * 0.5 ? readable : fallback;
    return text.slice(0, 20000);
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
      text: mainText(opts?.Readability),
      contacts: { phones, emails, socials, addresses, bodyText: clean(document.body?.innerText, 50000) },
      design: opts?.withDesign === false ? null : design(),
      images: images(),
      docHeight: document.documentElement.scrollHeight,
    };
  }

  return { dismissConsent, hideOverlays, autoScroll, waitForFonts, extract };
})();
