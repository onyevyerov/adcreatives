import { type CSSProperties, type ReactNode, useMemo } from "react";
import { spring, useCurrentFrame, useVideoConfig } from "remotion";
import { withAlpha } from "../color.ts";
import { useFormat } from "../format.tsx";
import { type EasingFn, easings, progress, springFor } from "../motion.ts";
import { type TextAlign, TextBlock } from "../text/TextBlock.tsx";
import { useTheme } from "../theme.tsx";
import { findNumber, odometer } from "./number.ts";
import { paint } from "./paint.ts";

// Прийоми даних: лічильник у тексті, кільце-діаграма, стовпчики. Чисті функції кадру.
// Значення для Ring/Bars сцена бере з текстів (`numberIn(item.text)`), а не літералами.

/** Оформлення тексту прийому (усе необов'язкове; розміри — px). */
export interface TextStyleProps {
  /** Дефолт залежить від компонента. */
  maxFontSize?: number;
  minFontSize?: number;
  maxLines?: number;
  /** Ширина блока тексту, дефолт — ширина safe-зони. */
  width?: number;
  font?: "heading" | "body";
  weight?: number;
  color?: string;
  align?: TextAlign;
  style?: CSSProperties;
}

/** Лічильник: перше число в `text` біжить від 0 до свого значення; з `startFrame + durationFrames` — рівно `text`. */
export function CountUp(
  props: { text: string; startFrame: number; durationFrames: number; easing?: EasingFn } & TextStyleProps,
) {
  const { unit } = useFormat();
  const frame = useCurrentFrame();
  const match = useMemo(() => findNumber(props.text), [props.text]);
  const p = progress(frame, props.startFrame, props.durationFrames, props.easing ?? easings.out);
  const chars = useMemo(() => {
    if (!match || p >= 1) return null;
    const final = props.text.slice(match.start, match.end);
    return odometer(final, match.value * p, match.decimals);
  }, [match, p, props.text]);
  const glyphs =
    chars && match
      ? (index: number) => {
          const c = index >= match.start && index < match.end ? chars[index - match.start] : undefined;
          return c ? { ch: c.ch, hidden: c.hidden } : null;
        }
      : undefined;
  const max = props.maxFontSize ?? Math.round(140 * unit);
  return (
    <TextBlock
      text={props.text}
      maxLines={props.maxLines ?? 2}
      maxFontSize={max}
      minFontSize={props.minFontSize ?? Math.min(max, Math.round(56 * unit))}
      width={props.width}
      font={props.font}
      weight={props.weight}
      color={props.color}
      align={props.align}
      style={{ fontVariantNumeric: "tabular-nums", ...props.style }}
      glyphs={glyphs}
      component="CountUp"
    />
  );
}

/** Кольори сегментів за замовчуванням: accent, primary, secondary по колу. */
const SERIES = ["accent", "primary", "secondary"] as const;

/** Кільцева діаграма: сегменти — частки `value / total` кола, малюються по черзі; `children` — у центрі. */
export function Ring(props: {
  segments: { value: number; color?: string }[];
  startFrame: number;
  stagger?: number;
  size: number;
  thickness?: number;
  children?: ReactNode;
  total?: number;
  durationFrames?: number;
  /** Колір доріжки під сегментами; дефолт — primary з прозорістю 0.15. */
  track?: string;
  style?: CSSProperties;
}) {
  const theme = useTheme();
  const { unit } = useFormat();
  const frame = useCurrentFrame();
  const thickness = props.thickness ?? Math.round(props.size * 0.12);
  const r = (props.size - thickness) / 2;
  const c = 2 * Math.PI * r;
  const values = props.segments.map((s) => Math.max(0, s.value));
  const total = props.total ?? values.reduce((a, b) => a + b, 0);
  const stagger = props.stagger ?? 8;
  const duration = props.durationFrames ?? 24;
  // Зазор між сегментами — лише коли їх кілька.
  const gap = props.segments.length > 1 ? Math.min(4 * unit, c * 0.01) : 0;
  let offset = 0;
  const arcs = props.segments.map((s, i) => {
    const share = total > 0 ? Math.min(values[i] ?? 0, Math.max(0, total - offset)) / total : 0;
    const from = offset;
    offset += share * total;
    const p = progress(frame, props.startFrame + i * stagger, duration, easings.out);
    const len = Math.max(0, share * c - gap) * p;
    return {
      key: i,
      color: paint(theme, s.color, SERIES[i % SERIES.length] ?? "accent"),
      dash: `${len.toFixed(3)} ${c.toFixed(3)}`,
      offset: (-(total > 0 ? from / total : 0) * c).toFixed(3),
      visible: len > 0,
    };
  });
  return (
    <div
      style={{
        position: "relative",
        width: props.size,
        height: props.size,
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        ...props.style,
      }}
    >
      <svg
        width={props.size}
        height={props.size}
        viewBox={`0 0 ${props.size} ${props.size}`}
        aria-hidden="true"
        style={{ position: "absolute", left: 0, top: 0, transform: "rotate(-90deg)" }}
      >
        <circle
          cx={props.size / 2}
          cy={props.size / 2}
          r={r}
          fill="none"
          stroke={props.track ?? withAlpha(theme.palette.primary, 0.15)}
          strokeWidth={thickness}
        />
        {arcs.map((a) =>
          a.visible ? (
            <circle
              key={a.key}
              cx={props.size / 2}
              cy={props.size / 2}
              r={r}
              fill="none"
              stroke={a.color}
              strokeWidth={thickness}
              strokeDasharray={a.dash}
              strokeDashoffset={a.offset}
            />
          ) : null,
        )}
      </svg>
      <div style={{ position: "relative" }}>{props.children}</div>
    </div>
  );
}

/** Стовпчики у масштабі `max`, ростуть по черзі пружиною бренду. */
export function Bars(props: {
  values: number[];
  startFrame: number;
  stagger?: number;
  width: number;
  height: number;
  direction?: "vertical" | "horizontal";
  max?: number;
  color?: string;
  /** Індекс стовпчика, виділеного кольором accent. */
  highlight?: number;
  /** Частка кроку між стовпчиками, 0..0.9 (дефолт 0.3). */
  gap?: number;
  style?: CSSProperties;
}) {
  const theme = useTheme();
  const { unit } = useFormat();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const vertical = (props.direction ?? "vertical") === "vertical";
  const n = Math.max(1, props.values.length);
  const max = props.max ?? Math.max(0, ...props.values);
  const stagger = props.stagger ?? 4;
  const gapShare = Math.max(0, Math.min(0.9, props.gap ?? 0.3));
  const along = vertical ? props.width : props.height;
  const across = vertical ? props.height : props.width;
  const step = along / n;
  const thick = step * (1 - gapShare);
  const radius = Math.min(theme.radius.sm * unit, thick / 2);
  const config = springFor(theme.motion);
  return (
    <div
      style={{
        position: "relative",
        width: props.width,
        height: props.height,
        flexShrink: 0,
        ...props.style,
      }}
    >
      {props.values.map((v, i) => {
        const p = spring({ frame: frame - (props.startFrame + i * stagger), fps, config });
        const len = max > 0 ? (Math.max(0, v) / max) * across * p : 0;
        const pos = i * step + (step - thick) / 2;
        const color = props.highlight === i ? theme.palette.accent : paint(theme, props.color, "primary");
        // Кут не більший за довжину стовпчика: на старті пружини він не стає півколом.
        const r = Math.min(radius, Math.max(0, len)).toFixed(2);
        const box: CSSProperties = vertical
          ? { left: pos, bottom: 0, width: thick, height: Math.max(0, len) }
          : { top: pos, left: 0, height: thick, width: Math.max(0, len) };
        return (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: стовпчики не переставляються між кадрами
            key={i}
            style={{
              position: "absolute",
              ...box,
              background: color,
              borderRadius: vertical ? `${r}px ${r}px 0 0` : `0 ${r}px ${r}px 0`,
            }}
          />
        );
      })}
    </div>
  );
}
