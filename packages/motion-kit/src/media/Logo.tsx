import type { BrandKit } from "@adc/shared/schemas/brandkit";
import type { AssetRef } from "@adc/shared/types/video";
import { evolvePath, getLength, parsePath, reduceInstructions, serializeInstructions } from "@remotion/paths";
import { type CSSProperties, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Img, spring, staticFile, useCurrentFrame, useDelayRender, useVideoConfig } from "remotion";
import { isDark, readableOn } from "../color.ts";
import { useFormat } from "../format.tsx";
import { springs } from "../motion.ts";
import { BG_ATTR, useQaCheck } from "../qa.tsx";
import { headingWeight, useAssets, useBrand, useTheme } from "../theme.tsx";

export interface LogoProps {
  /** Висота, px (дефолт 120 × unit). */
  size?: number;
  /** Фон, на якому стоїть лого; підкладка — якщо brand.logo.needsBackground. */
  variant?: "auto" | "onDark" | "onLight";
  startFrame?: number;
  style?: CSSProperties;
}

/** Лого бренду; без зображення — brand.logo.textFallback шрифтом heading. */
export function Logo(props: LogoProps) {
  const brand = useBrand();
  const theme = useTheme();
  const assets = useAssets();
  const { unit } = useFormat();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const ref = useRef<HTMLDivElement>(null);
  const size = props.size ?? Math.round(120 * unit);
  const variant = props.variant ?? "auto";
  const asset = brand.logo.assetId ? assets[brand.logo.assetId] : undefined;
  const p =
    props.startFrame === undefined
      ? 1
      : spring({ frame: frame - props.startFrame, fps, config: springs.premium });

  useQaCheck(ref, { component: "Logo", safeArea: true, contrast: !asset });

  const plateColor =
    variant === "onDark" ? "#FFFFFF" : variant === "onLight" ? theme.palette.primary : theme.palette.surface;
  const needsPlate = brand.logo.needsBackground;
  const textColor = needsPlate
    ? readableOn(plateColor, theme.palette)
    : variant === "onDark"
      ? theme.palette.textOnDark
      : variant === "onLight"
        ? theme.palette.textOnLight
        : isDark(theme.palette.background)
          ? theme.palette.textOnDark
          : theme.palette.primary;

  const wrapper: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "center",
    opacity: Math.min(1, p * 1.4),
    transform: `scale(${(0.8 + 0.2 * p).toFixed(4)})`,
    ...(needsPlate
      ? {
          background: plateColor,
          padding: `${Math.round(size * 0.18)}px ${Math.round(size * 0.3)}px`,
          borderRadius: theme.radius.md * unit,
        }
      : {}),
    ...props.style,
  };

  if (asset) {
    const width = Math.round((size * asset.width) / Math.max(1, asset.height));
    return (
      <div ref={ref} {...(needsPlate ? { [BG_ATTR]: plateColor } : {})} style={wrapper}>
        <Img
          src={staticFile(asset.src)}
          style={{ height: size, width, objectFit: "contain", display: "block" }}
        />
      </div>
    );
  }
  return (
    <div
      ref={ref}
      {...(needsPlate ? { [BG_ATTR]: plateColor } : {})}
      style={{
        ...wrapper,
        fontFamily: theme.fonts.heading,
        fontWeight: headingWeight(theme),
        fontSize: Math.round(size * 0.72),
        lineHeight: 1,
        color: textColor,
        whiteSpace: "nowrap",
        letterSpacing: "-0.01em",
      }}
    >
      {brand.logo.textFallback || brand.identity.name}
    </div>
  );
}

// ---------- геометрія векторного лого: useLogoGeometry, LogoPath ----------

/** Геометрія векторного лого: `viewBox` файлу і `d` усіх видимих фігур у його координатах. */
export interface LogoGeometry {
  viewBox: string;
  paths: string[];
}

/** Фігура лого (внутрішнє): шлях і як вона намальована у файлі. */
export interface LogoShape {
  d: string;
  /** Фігура залита (fill не none); інакше — лише контур. */
  filled: boolean;
  fillRule: "nonzero" | "evenodd";
  /** Товщина власного контуру у viewBox-одиницях (з трансформацією); null — контуру немає. */
  strokeWidth: number | null;
}

/** Розібране SVG лого (внутрішнє). */
export interface LogoSvg {
  viewBox: string;
  shapes: LogoShape[];
}

type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

const NUMBER = /[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi;
const numbersIn = (text: string): number[] => (text.match(NUMBER) ?? []).map(Number);
const fmt = (n: number): string => String(Math.round(n * 1000) / 1000);

/** SVG `transform` → матриця (matrix, translate, scale, rotate, skewX, skewY; зліва направо). */
function parseTransform(text: string | undefined): Matrix {
  if (!text) return IDENTITY;
  let m: Matrix = IDENTITY;
  for (const [, fn, args] of text.matchAll(/(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g)) {
    const a = numbersIn(args ?? "");
    const rad = ((a[0] ?? 0) * Math.PI) / 180;
    let t: Matrix = IDENTITY;
    if (fn === "matrix" && a.length >= 6) t = a.slice(0, 6) as Matrix;
    else if (fn === "translate") t = [1, 0, 0, 1, a[0] ?? 0, a[1] ?? 0];
    else if (fn === "scale") t = [a[0] ?? 1, 0, 0, a[1] ?? a[0] ?? 1, 0, 0];
    else if (fn === "rotate") {
      const cx = a[1] ?? 0;
      const cy = a[2] ?? 0;
      const r: Matrix = [Math.cos(rad), Math.sin(rad), -Math.sin(rad), Math.cos(rad), 0, 0];
      t = multiply(multiply([1, 0, 0, 1, cx, cy], r), [1, 0, 0, 1, -cx, -cy]);
    } else if (fn === "skewX") t = [1, 0, Math.tan(rad), 1, 0, 0];
    else if (fn === "skewY") t = [1, Math.tan(rad), 0, 1, 0, 0];
    m = multiply(m, t);
  }
  return m;
}

/** Шлях у координатах після матриці (дуги й короткі криві спершу зводяться до M/L/C/Z). */
function transformPath(d: string, m: Matrix): string {
  if (m.every((v, i) => v === IDENTITY[i])) return d;
  const p = (x: number, y: number) => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] });
  return serializeInstructions(
    reduceInstructions(parsePath(d)).map((ins) => {
      if (ins.type === "Z") return ins;
      if (ins.type === "C") {
        const c1 = p(ins.cp1x, ins.cp1y);
        const c2 = p(ins.cp2x, ins.cp2y);
        const e = p(ins.x, ins.y);
        return { type: "C", cp1x: c1.x, cp1y: c1.y, cp2x: c2.x, cp2y: c2.y, x: e.x, y: e.y };
      }
      const e = p(ins.x, ins.y);
      return { type: ins.type, x: e.x, y: e.y };
    }),
  );
}

function attrsOf(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [, name, dq, sq] of text.matchAll(/([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    if (name) out[name] = dq ?? sq ?? "";
  }
  return out;
}

function declarations(text: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (text ?? "").split(";")) {
    const i = part.indexOf(":");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

/** Прості правила `.class { … }` з `<style>` (так експортують Illustrator і Figma). */
function classRules(svg: string): Map<string, Record<string, string>> {
  const rules = new Map<string, Record<string, string>>();
  for (const [, css] of svg.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) {
    const clean = (css ?? "").replace(/<!\[CDATA\[|\]\]>/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const [, selectors, body] of clean.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      const decl = declarations(body);
      for (const sel of (selectors ?? "").split(",")) {
        const m = sel.trim().match(/^\.([\w-]+)$/);
        if (m?.[1]) rules.set(m[1], { ...rules.get(m[1]), ...decl });
      }
    }
  }
  return rules;
}

/** Контейнери, вміст яких не малюється напряму. */
const NOT_RENDERED = new Set([
  "defs",
  "clipPath",
  "mask",
  "pattern",
  "symbol",
  "marker",
  "linearGradient",
  "radialGradient",
  "filter",
  "title",
  "desc",
  "metadata",
]);
/** Елементи, які не зводяться до шляхів: лого з ними — не векторна геометрія. */
const UNSUPPORTED = new Set(["text", "tspan", "textPath", "image", "use", "foreignObject", "svg"]);
const INHERITED = [
  "fill",
  "stroke",
  "stroke-width",
  "fill-rule",
  "fill-opacity",
  "stroke-opacity",
  "visibility",
];

interface Frame {
  tag: string;
  matrix: Matrix;
  paint: Record<string, string>;
  hidden: boolean;
}

/**
 * SVG-текст лого → viewBox і фігури (внутрішнє; чиста функція, без DOM).
 * path/rect/circle/ellipse/line/polyline/polygon стають шляхами з урахуванням `transform` груп;
 * `<text>`, растр (`<image>`), `<use>`, вкладений `<svg>` — null (лого не зводиться до шляхів).
 * Вміст defs/clipPath/mask/… і приховані елементи пропускаються; фон-прямокутник на весь viewBox — теж.
 */
export function parseLogoSvg(svg: string): LogoSvg | null {
  const rules = classRules(svg);
  const text = svg
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "")
    .replace(/<\?[\s\S]*?\?>/g, "")
    .replace(/<!DOCTYPE[^>]*>/gi, "");
  const tags = text.matchAll(
    /<(\/?)([a-zA-Z][\w:.-]*)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'))?)*)\s*(\/?)>/g,
  );

  let viewBox: [number, number, number, number] | null = null;
  const stack: Frame[] = [];
  const shapes: LogoShape[] = [];
  let skipDepth = 0;

  for (const [, closing, rawTag, rawAttrs, selfClosing] of tags) {
    const tag = (rawTag ?? "").replace(/^svg:/, "");
    if (closing) {
      if (NOT_RENDERED.has(tag)) skipDepth = Math.max(0, skipDepth - 1);
      else if (skipDepth === 0) {
        const i = stack.map((f) => f.tag).lastIndexOf(tag);
        if (i >= 0) stack.length = i;
      }
      continue;
    }
    const attrs = attrsOf(rawAttrs ?? "");

    if (viewBox === null) {
      if (tag !== "svg") continue;
      const vb = numbersIn(attrs.viewBox ?? "");
      const w = Number.parseFloat(attrs.width ?? "");
      const h = Number.parseFloat(attrs.height ?? "");
      if (vb.length === 4 && (vb[2] ?? 0) > 0 && (vb[3] ?? 0) > 0)
        viewBox = vb as [number, number, number, number];
      else if (w > 0 && h > 0 && !/%/.test(`${attrs.width}${attrs.height}`)) viewBox = [0, 0, w, h];
      else return null;
      stack.push({ tag, matrix: IDENTITY, paint: {}, hidden: false });
      continue;
    }

    if (NOT_RENDERED.has(tag)) {
      if (!selfClosing) skipDepth++;
      continue;
    }
    if (skipDepth > 0) continue;
    if (UNSUPPORTED.has(tag)) return null;

    const parent = stack[stack.length - 1] ?? { tag: "svg", matrix: IDENTITY, paint: {}, hidden: false };
    const style = declarations(attrs.style);
    const fromClass = (attrs.class ?? "")
      .split(/\s+/)
      .reduce<Record<string, string>>((acc, c) => Object.assign(acc, rules.get(c)), {});
    // Каскад: успадковане < атрибут < правило класу < inline style.
    const own = (k: string) => style[k] ?? fromClass[k] ?? attrs[k];
    const paint: Record<string, string> = { ...parent.paint };
    for (const k of INHERITED) {
      const v = own(k);
      if (v !== undefined && v !== "inherit") paint[k] = v;
    }
    const opacity = own("opacity");
    const hidden =
      parent.hidden ||
      own("display") === "none" ||
      (opacity !== undefined && Number.parseFloat(opacity) <= 0) ||
      paint.visibility === "hidden";
    const matrix = multiply(parent.matrix, parseTransform(attrs.transform));
    if (!selfClosing) stack.push({ tag, matrix, paint, hidden });
    if (hidden) continue;

    const d = shapePath(tag, attrs, viewBox);
    if (d === null) continue;
    const [vx, vy, vw, vh] = viewBox;
    if (tag === "rect") {
      // Фон-плашка на весь viewBox — не частина знака.
      const n = (k: string) => Number.parseFloat(attrs[k] ?? "0") || 0;
      const full = (s: string | undefined) => s !== undefined && /^100(\.0+)?%$/.test(s.trim());
      const w = full(attrs.width) ? vw : n("width");
      const h = full(attrs.height) ? vh : n("height");
      if (n("x") <= vx && n("y") <= vy && w * h >= vw * vh * 0.98) continue;
    }

    const fill = (paint.fill ?? "black").trim();
    const stroke = (paint.stroke ?? "none").trim();
    const filled =
      tag !== "line" &&
      fill !== "none" &&
      fill !== "transparent" &&
      Number.parseFloat(paint["fill-opacity"] ?? "1") > 0;
    const stroked =
      stroke !== "none" && stroke !== "transparent" && Number.parseFloat(paint["stroke-opacity"] ?? "1") > 0;
    if (!filled && !stroked) continue;

    let path: string;
    try {
      path = transformPath(d, matrix);
      if (!(getLength(path) > 0)) continue;
    } catch {
      continue;
    }
    const scale = Math.sqrt(Math.abs(matrix[0] * matrix[3] - matrix[1] * matrix[2]));
    shapes.push({
      d: path,
      filled,
      fillRule: paint["fill-rule"] === "evenodd" ? "evenodd" : "nonzero",
      strokeWidth: stroked ? (Number.parseFloat(paint["stroke-width"] ?? "1") || 1) * scale : null,
    });
  }

  if (viewBox === null || shapes.length === 0) return null;
  return { viewBox: viewBox.map(fmt).join(" "), shapes };
}

/** Фігура SVG → `d` (у власних координатах елемента); null — не фігура або нульового розміру. */
function shapePath(
  tag: string,
  attrs: Record<string, string>,
  viewBox: [number, number, number, number],
): string | null {
  const n = (k: string, ref = 0) => {
    const v = attrs[k];
    if (v === undefined) return 0;
    return v.trim().endsWith("%") ? (Number.parseFloat(v) / 100) * ref : Number.parseFloat(v) || 0;
  };
  const [, , vw, vh] = viewBox;
  switch (tag) {
    case "path": {
      const d = attrs.d?.trim();
      return d ? d : null;
    }
    case "rect": {
      const x = n("x", vw);
      const y = n("y", vh);
      const w = n("width", vw);
      const h = n("height", vh);
      if (w <= 0 || h <= 0) return null;
      let rx = attrs.rx !== undefined ? n("rx", vw) : attrs.ry !== undefined ? n("ry", vh) : 0;
      let ry = attrs.ry !== undefined ? n("ry", vh) : rx;
      rx = Math.min(Math.max(0, rx), w / 2);
      ry = Math.min(Math.max(0, ry), h / 2);
      if (rx === 0 || ry === 0) return `M ${fmt(x)} ${fmt(y)} H ${fmt(x + w)} V ${fmt(y + h)} H ${fmt(x)} Z`;
      const a = `A ${fmt(rx)} ${fmt(ry)} 0 0 1`;
      return [
        `M ${fmt(x + rx)} ${fmt(y)} H ${fmt(x + w - rx)}`,
        `${a} ${fmt(x + w)} ${fmt(y + ry)} V ${fmt(y + h - ry)}`,
        `${a} ${fmt(x + w - rx)} ${fmt(y + h)} H ${fmt(x + rx)}`,
        `${a} ${fmt(x)} ${fmt(y + h - ry)} V ${fmt(y + ry)}`,
        `${a} ${fmt(x + rx)} ${fmt(y)} Z`,
      ].join(" ");
    }
    case "circle":
    case "ellipse": {
      const cx = n("cx", vw);
      const cy = n("cy", vh);
      const rx = tag === "circle" ? n("r", Math.hypot(vw, vh) / Math.SQRT2) : n("rx", vw);
      const ry = tag === "circle" ? rx : n("ry", vh);
      if (rx <= 0 || ry <= 0) return null;
      const a = `A ${fmt(rx)} ${fmt(ry)} 0 1 0`;
      return `M ${fmt(cx - rx)} ${fmt(cy)} ${a} ${fmt(cx + rx)} ${fmt(cy)} ${a} ${fmt(cx - rx)} ${fmt(cy)} Z`;
    }
    case "line":
      return `M ${fmt(n("x1", vw))} ${fmt(n("y1", vh))} L ${fmt(n("x2", vw))} ${fmt(n("y2", vh))}`;
    case "polyline":
    case "polygon": {
      const pts = numbersIn(attrs.points ?? "");
      if (pts.length < 4) return null;
      const pairs: string[] = [];
      for (let i = 0; i + 1 < pts.length; i += 2)
        pairs.push(`${fmt(pts[i] as number)} ${fmt(pts[i + 1] as number)}`);
      return `M ${pairs.join(" L ")}${tag === "polygon" ? " Z" : ""}`;
    }
    default:
      return null;
  }
}

// Кеш на сторінку рендера: файл лого читається й розбирається один раз для всіх сцен і кадрів.
const svgCache = new Map<string, LogoSvg | null>();
const svgPending = new Map<string, Promise<LogoSvg | null>>();

/** Шлях до SVG-файлу лого в public/ або null (лого растрове, текстове чи без асета). */
export function vectorLogoSrc(brand: BrandKit, assets: Record<string, AssetRef>): string | null {
  if (brand.logo.type !== "svg" || !brand.logo.assetId) return null;
  const asset = assets[brand.logo.assetId];
  if (!asset || !/\.svg$/i.test(asset.src)) return null;
  return asset.src;
}

/**
 * Лише для хоста й тестів: читає SVG лого з public/ ревізії (`staticFile`, той самий локальний
 * сервер бандла, з якого `<Logo>` бере `<Img>`) і розбирає його; помилка — null з попередженням.
 */
export function loadLogoSvg(src: string): Promise<LogoSvg | null> {
  if (svgCache.has(src)) return Promise.resolve(svgCache.get(src) ?? null);
  let pending = svgPending.get(src);
  if (!pending) {
    pending = fetch(staticFile(src))
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.text();
      })
      .then(parseLogoSvg)
      .catch((err: unknown) => {
        console.warn(`motion-kit: SVG лого ${src} не прочитано, геометрії не буде: ${String(err)}`);
        return null;
      })
      .then((svg) => {
        svgCache.set(src, svg);
        svgPending.delete(src);
        return svg;
      });
    svgPending.set(src, pending);
  }
  return pending;
}

/** Розібране SVG лого; поки файл читається, кадр притримується (`delayRender`). */
function useLogoSvg(): LogoSvg | null {
  const src = vectorLogoSrc(useBrand(), useAssets());
  const known = src === null || svgCache.has(src);
  const { delayRender, continueRender } = useDelayRender();
  const [handle] = useState(() => (known ? null : delayRender(`motion-kit: геометрія лого ${src}`)));
  const [, rerender] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    if (known || src === null) return;
    let cancelled = false;
    void loadLogoSvg(src).then(() => {
      if (!cancelled) rerender();
    });
    return () => {
      cancelled = true;
    };
  }, [src, known]);

  // continueRender — після коміту кадру з геометрією; і при розмонтуванні, щоб рендер не завис.
  useEffect(() => {
    if (known && handle !== null) continueRender(handle);
  }, [known, handle, continueRender]);
  useEffect(
    () => () => {
      if (handle !== null) continueRender(handle);
    },
    [handle, continueRender],
  );

  return src === null ? null : (svgCache.get(src) ?? null);
}

/**
 * Геометрія векторного лого бренду (`brand.logo.type === "svg"`): `viewBox` і `d` шляхів.
 * null — лого растрове, текстове, з `<text>`/растром усередині або файл не прочитано: тоді `<Logo>`.
 */
export function useLogoGeometry(): LogoGeometry | null {
  const svg = useLogoSvg();
  return useMemo(() => (svg ? { viewBox: svg.viewBox, paths: svg.shapes.map((s) => s.d) } : null), [svg]);
}

export interface LogoPathProps {
  /** 0..1: скільки кожного контуру намальовано (усі фігури — одночасно, кожна від свого початку). Дефолт 1. */
  draw?: number;
  /** Колір контуру і заливки; дефолт — як текст `<Logo>` на фоні бренду. */
  stroke?: string;
  /** Товщина контуру заливних фігур, px; дефолт max(1.5 × unit, size / 60). */
  strokeWidth?: number;
  /** Висота, px; ширина — з пропорцій viewBox. */
  size: number;
}

/**
 * Лого, що малюється контуром (`strokeDasharray` з `evolvePath`), одним кольором.
 * Залиті фігури наприкінці (`draw` 0.6 → 1) заливаються, а контур гасне — на 1 це силует лого.
 * Растрове/текстове лого — null (сцена малює `<Logo>`).
 */
export function LogoPath(props: LogoPathProps) {
  const svg = useLogoSvg();
  const theme = useTheme();
  const { unit } = useFormat();
  const ref = useRef<HTMLDivElement>(null);
  const draw = Math.min(1, Math.max(0, props.draw ?? 1));
  const dashes = useMemo(() => svg?.shapes.map((s) => evolvePath(draw, s.d)) ?? [], [svg, draw]);
  useQaCheck(ref, { component: "LogoPath", safeArea: true });
  if (!svg) return null;

  const [, , vbW = 1, vbH = 1] = numbersIn(svg.viewBox);
  const height = props.size;
  const width = Math.round((props.size * vbW) / vbH);
  const scale = props.size / vbH;
  const color =
    props.stroke ?? (isDark(theme.palette.background) ? theme.palette.textOnDark : theme.palette.primary);
  const outline = (props.strokeWidth ?? Math.max(1.5 * unit, props.size / 60)) / scale;
  const fillIn = Math.min(1, Math.max(0, (draw - 0.6) / 0.4));

  return (
    <div
      ref={ref}
      // На 0 прихований повністю: круглі кінці нульових штрихів інакше лишають крапки.
      style={{ width, height, flexShrink: 0, alignSelf: "center", opacity: draw > 0 ? 1 : 0 }}
    >
      <svg
        width={width}
        height={height}
        viewBox={svg.viewBox}
        style={{ display: "block", overflow: "visible" }}
        aria-hidden="true"
      >
        {svg.shapes.map((s, i) => (
          <path
            // biome-ignore lint/suspicious/noArrayIndexKey: фігури файлу лого — фіксований список
            key={i}
            d={s.d}
            fill={s.filled ? color : "none"}
            fillOpacity={s.filled ? fillIn : undefined}
            fillRule={s.fillRule}
            stroke={color}
            strokeOpacity={s.filled ? 1 - fillIn : 1}
            strokeWidth={s.filled ? outline : (s.strokeWidth ?? outline)}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeDasharray={dashes[i]?.strokeDasharray}
            strokeDashoffset={dashes[i]?.strokeDashoffset}
          />
        ))}
      </svg>
    </div>
  );
}
