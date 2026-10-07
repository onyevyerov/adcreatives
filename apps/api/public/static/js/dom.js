// @ts-check
/**
 * DOM-хелпери. Тексти з сайтів клієнтів потрапляють у DOM лише через `textContent` і
 * `setAttribute`; вставка HTML-рядків у проєкті заборонена.
 */

/** @typedef {Node | string | number | null | undefined | false} ChildLeaf */
/** Дитина `h()`: вузол, текст або (вкладений) масив; `null`/`undefined`/`false` пропускаються. @typedef {ChildLeaf | ChildLeaf[] | ChildLeaf[][]} Child */
/**
 * Атрибути `h()`:
 * - `text` — `textContent`;
 * - `on<event>` з функцією — `addEventListener` (`onclick`, `onInput`, `onkeydown`…);
 * - `style` — об'єкт (`camelCase`, `kebab-case` або `--змінна`), через `style.setProperty`;
 * - `value`, `checked`, `selected`, `muted` — властивості елемента (`muted` ще й атрибут);
 * - `true` → порожній атрибут; `null`/`undefined`/`false` — пропуск; решта → `setAttribute`.
 * @typedef {Record<string, unknown>} Attrs
 */

const PROPS = new Set(["value", "checked", "selected", "muted"]);

/**
 * @param {Element} node
 * @param {Attrs | null | undefined} attrs
 */
function applyAttrs(node, attrs) {
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "text") node.textContent = String(v);
    else if (k.startsWith("on") && typeof v === "function") {
      node.addEventListener(k.slice(2).toLowerCase(), /** @type {EventListener} */ (v));
    } else if (k === "style" && typeof v === "object") {
      const style = /** @type {HTMLElement} */ (node).style;
      for (const [prop, val] of Object.entries(/** @type {Record<string, unknown>} */ (v))) {
        if (val === null || val === undefined) continue;
        const name = prop.startsWith("--") ? prop : prop.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
        style.setProperty(name, String(val));
      }
    } else if (PROPS.has(k)) {
      /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (node))[k] = v;
      if (k === "muted" && v) node.setAttribute("muted", "");
    } else node.setAttribute(k, v === true ? "" : String(v));
  }
}

/**
 * @param {Node} node
 * @param {Child[]} children
 */
function append(node, children) {
  for (const c of children.flat(Number.POSITIVE_INFINITY)) {
    if (c === null || c === undefined || c === false) continue;
    node.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

/**
 * Створює HTML-елемент (як `el()` з попереднього index.html).
 * @template {keyof HTMLElementTagNameMap} K
 * @param {K} tag
 * @param {Attrs | null} [attrs]
 * @param {...Child} children
 * @returns {HTMLElementTagNameMap[K]}
 */
export function h(tag, attrs, ...children) {
  const node = document.createElement(tag);
  applyAttrs(node, attrs);
  append(node, children);
  return node;
}

/**
 * Створює SVG-елемент (декоративні гліфи, хвильова форма).
 * @template {keyof SVGElementTagNameMap} K
 * @param {K} tag
 * @param {Attrs | null} [attrs]
 * @param {...Child} children
 * @returns {SVGElementTagNameMap[K]}
 */
export function svg(tag, attrs, ...children) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  applyAttrs(node, attrs);
  append(node, children);
  return node;
}

/**
 * Ставить `textContent`, лише якщо він змінився (без зайвих мутацій DOM).
 * @param {Node} node
 * @param {unknown} value
 */
export function text(node, value) {
  const s = value === null || value === undefined ? "" : String(value);
  if (node.textContent !== s) node.textContent = s;
}

/**
 * Прибирає всіх нащадків.
 * @param {Node} node
 */
export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/**
 * Текст із переносами рядків → вузли з `<br>` між рядками.
 * @param {string} value
 * @returns {Node[]}
 */
export function lines(value) {
  /** @type {Node[]} */
  const out = [];
  String(value)
    .split("\n")
    .forEach((line, i) => {
      if (i > 0) out.push(document.createElement("br"));
      out.push(document.createTextNode(line));
    });
  return out;
}
