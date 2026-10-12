import { useId } from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { averageColor, isDark, mix, withAlpha } from "../color.ts";
import { BG_ATTR } from "../qa.tsx";
import { useTheme } from "../theme.tsx";

export interface BackdropProps {
  variant: "solid" | "gradient" | "noise" | "shapes" | "stage";
  /** Дефолт palette.background. */
  color?: string;
  /** Для gradient/shapes. */
  colors?: string[];
  /** Для gradient, градуси. */
  angle?: number;
  /** Повільний дрейф (функція від кадру). `stage` рухається завжди. */
  animate?: boolean;
  /** stage: base + 2 дрейфуючі радіальні свічення + сітка + зерно + віньєтка. Кольори свічень, дефолт [primary, secondary]. */
  glow?: [string, string];
  /** stage: сітка 96 px × unit з маскою до центру, дрейф 0.4 px × unit на кадр; дефолт true. */
  grid?: boolean;
  /** stage: колір, у який «кімната» перефарбовується (напр. palette.danger). */
  tint?: string;
  /** stage: 0..1, частка `tint` у свіченнях; функція від кадру задається сценою. Дефолт 1, якщо є `tint`. */
  tintAmount?: number;
}

/** Розмір клітинки сітки `stage`, px для кадру з короткою стороною 1080. */
export const STAGE_GRID = 96;
/** Дрейф сітки `stage`, px на кадр (× unit). */
export const STAGE_GRID_DRIFT = 0.4;

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** Додатна остача (для зсуву фону, що циклічно повторюється). */
const wrap = (n: number, m: number) => ((n % m) + m) % m;

/**
 * Центри двох свічень `stage` у кадрі (px): повільні синуси від кадру з різними періодами,
 * тож свічення не синхронні й ніколи не повторюють один одного. Чиста функція кадру.
 */
export function stageGlowCenters(
  frame: number,
  width: number,
  height: number,
): [{ x: number; y: number }, { x: number; y: number }] {
  return [
    {
      x: width * (0.3 + 0.08 * Math.sin(frame / 97)),
      y: height * (0.3 + 0.06 * Math.cos(frame / 131)),
    },
    {
      x: width * (0.7 + 0.08 * Math.sin(frame / 113 + 2.1)),
      y: height * (0.72 + 0.06 * Math.cos(frame / 89 + 1.3)),
    },
  ];
}

/** Детерміновані «випадкові» числа 0..1 з індексу (без Math.random). */
function hash01(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/** Фон сцени. */
export function Backdrop(props: BackdropProps) {
  const theme = useTheme();
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const base = props.color ?? theme.palette.background;
  const drift = props.animate ? frame : 0;
  // Унікальний id фільтра зерна: дві сцени під переходом мають різні локальні кадри (і seed).
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");

  switch (props.variant) {
    case "stage": {
      const unit = Math.min(width, height) / 1080;
      const dark = isDark(base);
      const amount = props.tint ? clamp01(props.tintAmount ?? 1) : 0;
      const glowColors = (props.glow ?? [theme.palette.primary, theme.palette.secondary]).map((c) =>
        props.tint && amount > 0 ? mix(c, props.tint, amount) : c,
      );
      const centers = stageGlowCenters(frame, width, height);
      const radius = Math.round(Math.min(width, height) * 0.75);
      const alpha = dark ? 0.55 : 0.35;
      const glows = centers.map((c, i) => {
        const color = glowColors[i] as string;
        return `radial-gradient(circle ${radius}px at ${c.x.toFixed(1)}px ${c.y.toFixed(1)}px, ${withAlpha(color, alpha)} 0%, ${withAlpha(color, alpha * 0.4)} 38%, ${withAlpha(color, 0)} 70%)`;
      });
      const cell = STAGE_GRID * unit;
      const line = Math.max(1, Math.round(unit));
      const lineColor = dark ? withAlpha("#FFFFFF", 0.07) : withAlpha("#000000", 0.06);
      // Сітка центрована в кадрі й повільно пливе вгору; маска гасить її до країв.
      const gridX = wrap(width / 2, cell);
      const gridY = wrap(height / 2 - frame * STAGE_GRID_DRIFT * unit, cell);
      const mask =
        "radial-gradient(ellipse 75% 60% at 50% 50%, #000 0%, rgba(0,0,0,0.55) 45%, transparent 100%)";
      const filterId = `adc-grain-${uid}`;
      return (
        <AbsoluteFill
          {...{ [BG_ATTR]: base }}
          style={{ background: [...glows, base].join(", "), overflow: "hidden" }}
        >
          {props.grid !== false ? (
            <AbsoluteFill
              data-adc-stage="grid"
              style={{
                backgroundImage: `linear-gradient(to right, ${lineColor} ${line}px, transparent ${line}px), linear-gradient(to bottom, ${lineColor} ${line}px, transparent ${line}px)`,
                backgroundSize: `${cell}px ${cell}px`,
                backgroundPosition: `${gridX.toFixed(2)}px ${gridY.toFixed(2)}px`,
                maskImage: mask,
                WebkitMaskImage: mask,
              }}
            />
          ) : null}
          <svg
            width={width}
            height={height}
            style={{ position: "absolute", inset: 0, opacity: dark ? 0.12 : 0.09, mixBlendMode: "overlay" }}
            aria-hidden="true"
          >
            <filter id={filterId}>
              <feTurbulence
                type="fractalNoise"
                baseFrequency="0.9"
                numOctaves={2}
                seed={wrap(Math.round(frame), 9)}
                stitchTiles="stitch"
              />
              <feColorMatrix type="saturate" values="0" />
            </filter>
            <rect width="100%" height="100%" filter={`url(#${filterId})`} />
          </svg>
          <AbsoluteFill
            style={{
              background: `radial-gradient(ellipse at 50% 45%, transparent 50%, ${withAlpha(mix(base, "#000000", 0.6), dark ? 0.55 : 0.22)} 100%)`,
            }}
          />
        </AbsoluteFill>
      );
    }

    case "solid":
      return <AbsoluteFill {...{ [BG_ATTR]: base }} style={{ background: base }} />;

    case "gradient": {
      const colors =
        props.colors && props.colors.length > 0
          ? props.colors
          : [theme.palette.primary, theme.palette.secondary];
      const stops = colors.length === 1 ? [colors[0], colors[0]] : colors;
      const angle = (props.angle ?? 160) + drift * 0.12;
      return (
        <AbsoluteFill
          {...{ [BG_ATTR]: averageColor(stops as string[]) }}
          style={{ background: `linear-gradient(${angle.toFixed(2)}deg, ${stops.join(", ")})` }}
        />
      );
    }

    case "noise": {
      const shift = (drift * 0.6) % 200;
      return (
        <AbsoluteFill {...{ [BG_ATTR]: base }} style={{ background: base, overflow: "hidden" }}>
          <svg
            width={width + 200}
            height={height + 200}
            style={{
              position: "absolute",
              left: -shift,
              top: -shift / 2,
              opacity: 0.16,
              mixBlendMode: "multiply",
            }}
            aria-hidden="true"
          >
            <filter id="adc-noise">
              <feTurbulence
                type="fractalNoise"
                baseFrequency="0.85"
                numOctaves={2}
                seed={7}
                stitchTiles="stitch"
              />
              <feColorMatrix type="saturate" values="0" />
            </filter>
            <rect width="100%" height="100%" filter="url(#adc-noise)" />
          </svg>
          <AbsoluteFill
            style={{
              background: `radial-gradient(circle at 50% 40%, transparent 40%, ${withAlpha(mix(base, "#000000", 0.5), 0.18)} 100%)`,
            }}
          />
        </AbsoluteFill>
      );
    }

    case "shapes": {
      const colors =
        props.colors && props.colors.length > 0
          ? props.colors
          : [theme.palette.primary, theme.palette.secondary, theme.palette.accent];
      const unit = Math.min(width, height);
      const blobs = Array.from({ length: 5 }, (_, i) => {
        const r = unit * (0.28 + hash01(i + 1) * 0.3);
        const cx = width * hash01(i + 11);
        const cy = height * hash01(i + 23);
        const dx = props.animate ? Math.sin((drift + i * 40) / 90) * unit * 0.04 : 0;
        const dy = props.animate ? Math.cos((drift + i * 55) / 110) * unit * 0.04 : 0;
        const color = colors[i % colors.length] as string;
        return (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: фіксований детермінований список, порядок не змінюється
            key={i}
            style={{
              position: "absolute",
              left: cx - r + dx,
              top: cy - r + dy,
              width: r * 2,
              height: r * 2,
              borderRadius: "50%",
              background: withAlpha(color, 0.22),
              filter: `blur(${Math.round(unit * 0.05)}px)`,
            }}
          />
        );
      });
      return (
        <AbsoluteFill {...{ [BG_ATTR]: base }} style={{ background: base, overflow: "hidden" }}>
          {blobs}
        </AbsoluteFill>
      );
    }
  }
}
