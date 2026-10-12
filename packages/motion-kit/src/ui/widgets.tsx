import { type CSSProperties, type ReactNode, useMemo } from "react";
import { spring, useCurrentFrame, useVideoConfig } from "remotion";
import { mix, readableOn, withAlpha } from "../color.ts";
import { useFormat } from "../format.tsx";
import { Icon } from "../icons/Icon.tsx";
import type { IconName } from "../icons/names.ts";
import { ICON_PATHS } from "../icons/paths.ts";
import { defaultStagger, easings, progress, springFor, springs } from "../motion.ts";
import { BG_ATTR } from "../qa.tsx";
import { FitText } from "../text/components.tsx";
import { fitText } from "../text/layout.ts";
import { createMeasurer } from "../text/measure.ts";
import { type Glyph, TextBlock } from "../text/TextBlock.tsx";
import { bodyWeight, headingWeight, useTheme } from "../theme.tsx";
import { paint } from "./paint.ts";

// Прийоми інтерфейсу: картка, чекбокс і список, поле вводу, курсор. Чисті функції кадру;
// кольори — з палітри; текст — через той самий блок підгонки, що й FitText (QA-логи переповнення).

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/** Картка інтерфейсу на `surface`, заходить пружиною бренду; `title` — через FitText. */
export function UICard(props: {
  startFrame: number;
  children: ReactNode;
  accent?: string;
  style?: CSSProperties;
  title?: string;
  icon?: IconName;
  /** px; дефолт — ширина safe-зони (потрібна для підгонки заголовка). */
  width?: number;
}) {
  const theme = useTheme();
  const { unit, safe } = useFormat();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = spring({ frame: frame - props.startFrame, fps, config: springFor(theme.motion) });
  const bg = theme.palette.surface;
  const fg = readableOn(bg, theme.palette);
  const accent = props.accent ? paint(theme, props.accent, "accent") : null;
  const pad = Math.round(36 * unit);
  const width = props.width ?? safe.width;
  const titleSize = Math.round(46 * unit);
  const iconSize = Math.round(titleSize * 1.1);
  const iconGap = Math.round(18 * unit);
  return (
    <div
      {...{ [BG_ATTR]: bg }}
      style={{
        position: "relative",
        boxSizing: "border-box",
        width,
        display: "flex",
        flexDirection: "column",
        gap: Math.round(20 * unit),
        padding: pad,
        paddingLeft: accent ? pad + Math.round(8 * unit) : pad,
        background: bg,
        color: fg,
        borderRadius: theme.radius.lg * unit,
        overflow: "hidden",
        boxShadow: `0 ${Math.round(18 * unit)}px ${Math.round(48 * unit)}px rgba(0,0,0,0.18)`,
        opacity: clamp01((frame - props.startFrame) / 6),
        transform: `translateY(${((1 - p) * 48 * unit).toFixed(2)}px) scale(${(0.96 + 0.04 * p).toFixed(4)})`,
        ...props.style,
      }}
    >
      {accent ? (
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            bottom: 0,
            width: Math.round(8 * unit),
            background: accent,
          }}
        />
      ) : null}
      {props.title ? (
        <div style={{ display: "flex", alignItems: "center", gap: iconGap }}>
          {props.icon ? <Icon name={props.icon} size={iconSize} color={accent ?? "accent"} /> : null}
          <FitText
            text={props.title}
            maxLines={2}
            maxFontSize={titleSize}
            minFontSize={Math.round(titleSize * 0.7)}
            width={
              width - 2 * pad - (accent ? Math.round(8 * unit) : 0) - (props.icon ? iconSize + iconGap : 0)
            }
            align="left"
            color={fg}
            style={{ margin: 0 }}
          />
        </div>
      ) : null}
      {props.children}
    </div>
  );
}

/** Чекбокс: до `checkedAt` порожній, з `checkedAt` — заливка й галочка. */
export function Checkbox(props: { checkedAt: number; size: number; color?: string; style?: CSSProperties }) {
  const theme = useTheme();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const color = paint(theme, props.color, "accent");
  const checked = frame >= props.checkedAt;
  const fill = checked ? spring({ frame: frame - props.checkedAt, fps, config: springs.snappy }) : 0;
  const draw = progress(frame, props.checkedAt + 2, 8, easings.out);
  const radius = theme.radius.sm === 0 ? 0 : props.size * 0.24;
  return (
    <div
      style={{
        position: "relative",
        width: props.size,
        height: props.size,
        flexShrink: 0,
        boxSizing: "border-box",
        border: `${Math.max(2, props.size * 0.09).toFixed(2)}px solid ${color}`,
        borderRadius: radius,
        ...props.style,
      }}
    >
      {checked ? (
        <div
          style={{
            position: "absolute",
            inset: -Math.max(2, props.size * 0.09),
            borderRadius: radius,
            background: color,
            transform: `scale(${fill.toFixed(4)})`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Icon
            name="check"
            size={props.size * 0.78}
            color={readableOn(color, theme.palette)}
            strokeWidth={3.2}
            draw={draw}
          />
        </div>
      ) : null}
    </div>
  );
}

/** Список із галочками: рядки заходять по черзі, галочки ставляться о `checkFrom + i × checkStagger` або `checkAt[i]`. */
export function Checklist(props: {
  items: string[];
  startFrame: number;
  stagger?: number;
  checkFrom?: number;
  checkStagger?: number;
  width: number;
  /** Точні кадри галочок по пунктах (мають пріоритет над checkFrom/checkStagger). */
  checkAt?: number[];
  fontSize?: number;
  /** Колір тексту, дефолт textOnLight. */
  color?: string;
  /** Колір чекбоксів, дефолт accent. */
  checkColor?: string;
  style?: CSSProperties;
}) {
  const theme = useTheme();
  const { unit } = useFormat();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const n = props.items.length;
  const stagger = props.stagger ?? defaultStagger(theme.motion, "line");
  const checkFrom = props.checkFrom ?? props.startFrame + Math.max(0, n - 1) * stagger + 12;
  const checkStagger = props.checkStagger ?? stagger;
  const nominal = props.fontSize ?? Math.round(48 * unit);
  const minSize = Math.round(nominal * 0.7);
  const box = Math.round(nominal * 1.1);
  const gap = Math.round(nominal * 0.5);
  const labelWidth = Math.max(1, props.width - box - gap);
  const family = theme.fonts.body;
  const weight = bodyWeight(theme);
  // Спільний кегль: найменший з підібраних для кожного пункту, але не менше мінімуму.
  const fontSize = useMemo(() => {
    const measure = createMeasurer(family, weight);
    const sizes = props.items.map(
      (text) =>
        fitText({ text, maxLines: 2, width: labelWidth, maxFontSize: nominal, minFontSize: minSize, measure })
          .fontSize,
    );
    return Math.max(minSize, Math.min(nominal, ...sizes));
  }, [props.items, labelWidth, nominal, minSize, family, weight]);
  const config = springFor(theme.motion);
  return (
    <div
      style={{
        width: props.width,
        display: "flex",
        flexDirection: "column",
        gap: Math.round(nominal * 0.55),
        ...props.style,
      }}
    >
      {props.items.map((text, i) => {
        const at = props.startFrame + i * stagger;
        const p = spring({ frame: frame - at, fps, config });
        return (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: пункти можуть повторюватись; порядок сталий
            key={i}
            style={{
              display: "flex",
              alignItems: "center",
              gap,
              opacity: clamp01((frame - at) / 6),
              transform: `translateX(${((p - 1) * 40 * unit).toFixed(2)}px)`,
            }}
          >
            <Checkbox
              checkedAt={props.checkAt?.[i] ?? checkFrom + i * checkStagger}
              size={box}
              color={props.checkColor}
            />
            <FitText
              text={text}
              maxLines={2}
              maxFontSize={fontSize}
              minFontSize={Math.min(fontSize, minSize)}
              width={labelWidth}
              font="body"
              weight={weight}
              align="left"
              color={paint(theme, props.color, "textOnLight")}
              style={{ margin: 0 }}
            />
          </div>
        );
      })}
    </div>
  );
}

/** Поле вводу: placeholder → друк `text` з `typeStart` → натиск кнопки о `pressAt`. */
export function InputField(props: {
  text: string;
  placeholder?: string;
  typeStart: number;
  framesPerChar?: number;
  buttonLabel?: string;
  pressAt?: number;
  width: number;
  icon?: IconName;
  fontSize?: number;
  style?: CSSProperties;
}) {
  const theme = useTheme();
  const { unit } = useFormat();
  const frame = useCurrentFrame();
  const bg = theme.palette.surface;
  const fg = readableOn(bg, theme.palette);
  const accent = theme.palette.accent;
  const fontSize = props.fontSize ?? Math.round(44 * unit);
  const height = Math.round(fontSize * 2.3);
  const padX = Math.round(fontSize * 0.6);
  const gap = Math.round(fontSize * 0.4);
  const fpc = Math.max(1, props.framesPerChar ?? 2);
  const len = props.text.length;
  const typed = frame < props.typeStart ? 0 : Math.min(len, Math.floor((frame - props.typeStart) / fpc) + 1);
  const typing = frame >= props.typeStart && typed < len;
  const pressed = props.pressAt !== undefined && frame >= props.pressAt;
  // Каретка: суцільна під час друку, інакше блимає (15 кадрів видно, 15 ні); після натискання — немає.
  const caretOn = !pressed && (typing || Math.floor(frame / 15) % 2 === 0);
  const focus = progress(frame, props.typeStart - 4, 6, easings.out);
  const border = mix(mix(bg, fg, 0.18), accent, focus);

  const iconSize = Math.round(fontSize * 1.05);
  const buttonFont = Math.round(fontSize * 0.82);
  const buttonPadX = Math.round(buttonFont * 0.9);
  const headingFamily = theme.fonts.heading;
  const headingW = headingWeight(theme);
  const buttonWidth = useMemo(() => {
    if (!props.buttonLabel) return 0;
    const w = createMeasurer(headingFamily, headingW)(props.buttonLabel, buttonFont);
    return Math.min(Math.round(props.width * 0.45), Math.ceil(w / 0.97) + 2 * buttonPadX);
  }, [props.buttonLabel, props.width, headingFamily, headingW, buttonFont, buttonPadX]);
  const textWidth = Math.max(
    1,
    props.width - 2 * padX - (props.icon ? iconSize + gap : 0) - (buttonWidth > 0 ? buttonWidth + gap : 0),
  );
  const press = props.pressAt === undefined ? 0 : Math.sin(Math.PI * progress(frame, props.pressAt, 8));

  const caret = (
    <span
      style={{
        display: "inline-block",
        width: "0.06em",
        height: "1.05em",
        marginLeft: "0.03em",
        marginRight: "-0.09em",
        verticalAlign: "-0.18em",
        background: accent,
        opacity: caretOn ? 1 : 0,
      }}
    />
  );
  const glyphs = (index: number): Glyph | null => {
    if (typed === 0) return index === 0 ? { hidden: true, before: caret } : { hidden: true };
    if (index < typed - 1) return null;
    if (index === typed - 1) return { after: caret };
    return { hidden: true };
  };

  return (
    <div
      {...{ [BG_ATTR]: bg }}
      style={{
        position: "relative",
        boxSizing: "border-box",
        width: props.width,
        height,
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        gap,
        padding: `0 ${padX}px`,
        paddingRight: buttonWidth > 0 ? Math.round(height * 0.12) : padX,
        background: bg,
        border: `${Math.max(2, Math.round(3 * unit))}px solid ${border}`,
        borderRadius: theme.radius.pill === 0 ? 0 : Math.min(height / 2, theme.radius.lg * unit),
        boxShadow: `0 ${Math.round(12 * unit)}px ${Math.round(36 * unit)}px rgba(0,0,0,0.14)`,
        ...props.style,
      }}
    >
      {props.icon ? <Icon name={props.icon} size={iconSize} color={mix(fg, bg, 0.35)} /> : null}
      <div style={{ position: "relative", flex: 1, minWidth: 0 }}>
        {props.placeholder && typed === 0 ? (
          <div style={{ position: "absolute", left: 0, right: 0, top: "50%", transform: "translateY(-50%)" }}>
            <TextBlock
              text={props.placeholder}
              maxLines={1}
              maxFontSize={fontSize}
              minFontSize={Math.round(fontSize * 0.6)}
              width={textWidth}
              font="body"
              align="left"
              color={withAlpha(fg, 0.45)}
              style={{ margin: 0 }}
              component="InputField"
            />
          </div>
        ) : null}
        {len === 0 ? caret : null}
        <TextBlock
          text={props.text}
          maxLines={1}
          maxFontSize={fontSize}
          minFontSize={Math.round(fontSize * 0.6)}
          width={textWidth}
          font="body"
          align="left"
          color={fg}
          style={{ margin: 0 }}
          glyphs={glyphs}
          component="InputField"
        />
      </div>
      {buttonWidth > 0 && props.buttonLabel ? (
        <div
          {...{ [BG_ATTR]: accent }}
          style={{
            boxSizing: "border-box",
            width: buttonWidth,
            height: height - Math.round(height * 0.24),
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: `0 ${buttonPadX}px`,
            background: accent,
            borderRadius: theme.radius.pill === 0 ? 0 : Math.min(height / 2, theme.radius.lg * unit),
            transform: `scale(${(1 - 0.08 * press).toFixed(4)})`,
          }}
        >
          <FitText
            text={props.buttonLabel}
            maxLines={1}
            maxFontSize={buttonFont}
            minFontSize={Math.round(buttonFont * 0.6)}
            width={buttonWidth - 2 * buttonPadX}
            color={readableOn(accent, theme.palette)}
          />
        </div>
      ) : null}
    </div>
  );
}

/** Ключова точка курсора: позиція вістря (px, у найближчому позиційованому предку) на кадрі. */
export interface CursorPoint {
  x: number;
  y: number;
  frame: number;
}

/** Вістря стрілки `mouse-pointer-2` у сітці 24×24. */
const CURSOR_TIP = 4.2;

/** Курсор миші: рух між точками `path`, клік о `clickAt`. */
export function Cursor(props: {
  path: CursorPoint[];
  clickAt?: number | readonly number[];
  size?: number;
  style?: CSSProperties;
}) {
  const theme = useTheme();
  const { unit } = useFormat();
  const frame = useCurrentFrame();
  const size = props.size ?? Math.round(56 * unit);
  const points = useMemo(() => [...props.path].sort((a, b) => a.frame - b.frame), [props.path]);
  let x = points[0]?.x ?? 0;
  let y = points[0]?.y ?? 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1] as CursorPoint;
    const b = points[i] as CursorPoint;
    if (frame <= a.frame) break;
    const t = progress(frame, a.frame, b.frame - a.frame, easings.inOut);
    x = a.x + (b.x - a.x) * t;
    y = a.y + (b.y - a.y) * t;
  }
  const clicks =
    props.clickAt === undefined ? [] : typeof props.clickAt === "number" ? [props.clickAt] : props.clickAt;
  let squeeze = 0;
  const ripples: ReactNode[] = [];
  for (const c of clicks) {
    const k = frame - c;
    if (k >= 0 && k <= 6) squeeze = Math.max(squeeze, Math.sin((Math.PI * k) / 6));
    if (k >= 0 && k < 18) {
      const t = easings.out(k / 18);
      const r = (8 + 40 * t) * unit;
      ripples.push(
        <div
          key={c}
          style={{
            position: "absolute",
            left: x - r,
            top: y - r,
            width: 2 * r,
            height: 2 * r,
            borderRadius: "50%",
            border: `${Math.max(2, 4 * unit).toFixed(2)}px solid ${theme.palette.accent}`,
            opacity: 0.8 * (1 - t),
            boxSizing: "border-box",
          }}
        />,
      );
    }
  }
  const offset = (CURSOR_TIP / 24) * size;
  return (
    <>
      {ripples}
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        aria-hidden="true"
        style={{
          position: "absolute",
          left: x - offset,
          top: y - offset,
          overflow: "visible",
          transformOrigin: `${offset}px ${offset}px`,
          transform: `scale(${(1 - 0.15 * squeeze).toFixed(4)})`,
          filter: `drop-shadow(0 ${(4 * unit).toFixed(1)}px ${(8 * unit).toFixed(1)}px rgba(0,0,0,0.3))`,
          ...props.style,
        }}
      >
        <path
          d={ICON_PATHS["mouse-pointer-2"][0]}
          fill={theme.palette.textOnLight}
          stroke={theme.palette.textOnDark}
          strokeWidth={1.5}
          strokeLinejoin="round"
        />
      </svg>
    </>
  );
}
