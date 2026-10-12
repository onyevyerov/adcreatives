import type { CSSProperties, ReactNode } from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { withAlpha } from "../color.ts";
import { useFormat } from "../format.tsx";
import { easings, progress } from "../motion.ts";
import { useTheme } from "../theme.tsx";
import { paint } from "./paint.ts";

// Ефекти моменту: скан-лінія, спалах, світіння, закреслення. Чисті функції кадру; шари поверх
// кадру мають pointer-events: none, тож перевірка контрасту крізь них бачить справжній фон.

/** Світна скан-лінія від `from` до `to` px з `startFrame` за `durationFrames`. */
export function ScanLine(props: {
  startFrame: number;
  durationFrames: number;
  from: number;
  to: number;
  axis?: "x" | "y";
  thickness?: number;
  color?: string;
  trail?: number;
}) {
  const theme = useTheme();
  const { unit } = useFormat();
  const frame = useCurrentFrame();
  const end = props.startFrame + props.durationFrames;
  const opacity = Math.min(progress(frame, props.startFrame, 4), 1 - progress(frame, end, 6));
  if (frame < props.startFrame || opacity <= 0) return null;
  const color = paint(theme, props.color, "accent");
  const p = progress(frame, props.startFrame, props.durationFrames, easings.inOut);
  const pos = props.from + (props.to - props.from) * p;
  const thickness = props.thickness ?? Math.max(2, Math.round(4 * unit));
  const trail = props.trail ?? Math.round(140 * unit);
  const forward = props.to >= props.from;
  const vertical = (props.axis ?? "y") === "y";
  // Шлейф — позаду лінії за напрямком руху, від прозорого до кольору біля лінії.
  const trailStart = forward ? pos - trail : pos + thickness;
  const gradient = `linear-gradient(${vertical ? (forward ? "to bottom" : "to top") : forward ? "to right" : "to left"}, ${withAlpha(color, 0)}, ${withAlpha(color, 0.35)})`;
  const along = (a: number, len: number): CSSProperties =>
    vertical ? { left: 0, right: 0, top: a, height: len } : { top: 0, bottom: 0, left: a, width: len };
  return (
    <>
      <div
        style={{
          position: "absolute",
          pointerEvents: "none",
          opacity,
          ...along(trailStart, trail),
          background: gradient,
        }}
      />
      <div
        style={{
          position: "absolute",
          pointerEvents: "none",
          opacity,
          ...along(pos, thickness),
          background: color,
          boxShadow: `0 0 ${Math.round(24 * unit)}px ${Math.round(6 * unit)}px ${withAlpha(color, 0.6)}`,
        }}
      />
    </>
  );
}

/** Спалах на весь кадр о `at`, згасає за `durationFrames`. */
export function Flash(props: { at: number; durationFrames?: number; color?: string; strength?: number }) {
  const theme = useTheme();
  const frame = useCurrentFrame();
  if (frame < props.at) return null;
  const opacity =
    Math.max(0, Math.min(1, props.strength ?? 0.8)) *
    (1 - progress(frame, props.at, props.durationFrames ?? 10, easings.out));
  if (opacity <= 0) return null;
  return (
    <AbsoluteFill
      style={{ pointerEvents: "none", background: paint(theme, props.color, "textOnDark"), opacity }}
    />
  );
}

/** Період пульсації світіння за характером руху, кадрів при 30 fps. */
const PULSE_PERIOD = { energetic: 30, playful: 36, calm: 60, premium: 72 } as const;

/** Світіння навколо `children`; `pulse` — дихає. */
export function Glow(props: {
  children: ReactNode;
  strength?: number;
  color?: string;
  pulse?: boolean;
  startFrame?: number;
  style?: CSSProperties;
}) {
  const theme = useTheme();
  const { unit } = useFormat();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const color = paint(theme, props.color, "accent");
  const period = Math.max(1, Math.round((PULSE_PERIOD[theme.motion] * fps) / 30));
  const wave = props.pulse ? 0.6 + 0.4 * ((1 + Math.cos((2 * Math.PI * frame) / period)) / 2) : 1;
  const enter = props.startFrame === undefined ? 1 : progress(frame, props.startFrame, 12, easings.out);
  const s = Math.max(0, props.strength ?? 1) * wave * enter;
  const r = 28 * unit * s;
  return (
    <div
      style={{
        filter:
          s > 0
            ? `drop-shadow(0 0 ${(r * 0.4).toFixed(2)}px ${withAlpha(color, 0.9)}) drop-shadow(0 0 ${r.toFixed(2)}px ${withAlpha(color, 0.6)})`
            : undefined,
        ...props.style,
      }}
    >
      {props.children}
    </div>
  );
}

/** Закреслення `children` лінією з `at` за `durationFrames`. */
export function Strike(props: {
  at: number;
  durationFrames?: number;
  color?: string;
  thickness?: number;
  children: ReactNode;
  angle?: number;
  dim?: number;
  style?: CSSProperties;
}) {
  const theme = useTheme();
  const { unit } = useFormat();
  const frame = useCurrentFrame();
  const p = progress(frame, props.at, props.durationFrames ?? 10, easings.out);
  const thickness = props.thickness ?? Math.max(2, Math.round(8 * unit));
  const dim = Math.max(0, Math.min(1, props.dim ?? 1));
  return (
    <div style={{ position: "relative", display: "inline-block", ...props.style }}>
      <div style={{ opacity: 1 - (1 - dim) * p }}>{props.children}</div>
      {p > 0 ? (
        <div
          style={{
            position: "absolute",
            pointerEvents: "none",
            left: "-2%",
            width: "104%",
            top: "50%",
            height: thickness,
            marginTop: -thickness / 2,
            borderRadius: thickness / 2,
            background: paint(theme, props.color, "accent"),
            transformOrigin: "left center",
            transform: `rotate(${(props.angle ?? -3).toFixed(2)}deg) scaleX(${p.toFixed(4)})`,
          }}
        />
      ) : null}
    </div>
  );
}
