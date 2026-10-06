import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { averageColor, mix, withAlpha } from "../color.ts";
import { BG_ATTR } from "../qa.tsx";
import { useTheme } from "../theme.tsx";

export interface BackdropProps {
  variant: "solid" | "gradient" | "noise" | "shapes";
  /** Дефолт palette.background. */
  color?: string;
  /** Для gradient/shapes. */
  colors?: string[];
  /** Для gradient, градуси. */
  angle?: number;
  /** Повільний дрейф (функція від кадру). */
  animate?: boolean;
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

  switch (props.variant) {
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
