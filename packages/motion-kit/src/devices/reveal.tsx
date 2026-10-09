import type { Palette } from "@adc/shared/schemas/brandkit";
import type { CSSProperties, ReactNode } from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { type EasingFn, easings, progress } from "../motion.ts";
import { BG_ATTR } from "../qa.tsx";
import { useTheme } from "../theme.tsx";

// Девайси відкриття: поле кольору палітри (wipe / split / push) і clip-path-відкриття дітей.
// Геометрія — чиста функція від progress(), за межами [start, start + duration] — clamp.

export type Side = "left" | "right" | "top" | "bottom";

/** Відрізок [a, b] уздовж осі від краю `from` → прямокутник у px кадру. */
function segmentRect(from: Side, a: number, b: number, w: number, h: number): CSSProperties {
  const len = Math.max(0, b - a);
  switch (from) {
    case "left":
      return { left: a, top: 0, width: len, height: h };
    case "right":
      return { left: w - b, top: 0, width: len, height: h };
    case "top":
      return { left: 0, top: a, width: w, height: len };
    case "bottom":
      return { left: 0, top: h - b, width: w, height: len };
  }
}

/** Поле кольору палітри: wipe / split / push кадру. */
export function ColorField(props: {
  mode?: "wipe" | "split" | "push";
  color?: keyof Palette;
  from?: Side;
  startFrame?: number;
  duration?: number;
  /** 0–1. */
  cover?: number;
  exitFrame?: number;
  easing?: EasingFn;
  children?: ReactNode;
}) {
  const theme = useTheme();
  const frame = useCurrentFrame();
  const { width: w, height: h } = useVideoConfig();
  const mode = props.mode ?? "wipe";
  const from = props.from ?? "left";
  const color = theme.palette[props.color ?? "primary"];
  const duration = props.duration ?? 15;
  const easing = props.easing ?? easings.inOut;
  const p = progress(frame, props.startFrame ?? 0, duration, easing);
  const q = props.exitFrame === undefined ? 0 : progress(frame, props.exitFrame, duration, easing);
  const axis = from === "left" || from === "right" ? w : h;
  const extent = axis * Math.min(1, Math.max(0, props.cover ?? 1));

  // Відрізки поля вздовж осі від краю `from`.
  const segments: Array<[number, number]> =
    mode === "wipe"
      ? [[extent * q, extent * p]]
      : mode === "split"
        ? [
            [0, (extent / 2) * p * (1 - q)],
            [axis - (extent / 2) * p * (1 - q), axis],
          ]
        : [[extent * (p * (1 - q) - 1), extent * p * (1 - q)]];
  // push: кадр під полем зсувається на ту саму відстань, що пройшов передній край поля.
  const shift = mode === "push" ? extent * p * (1 - q) : 0;
  const sign = from === "left" || from === "top" ? 1 : -1;
  const pushed =
    from === "left" || from === "right"
      ? `translateX(${(sign * shift).toFixed(2)}px)`
      : `translateY(${(sign * shift).toFixed(2)}px)`;

  return (
    <AbsoluteFill>
      <AbsoluteFill style={shift > 0 ? { transform: pushed } : undefined}>{props.children}</AbsoluteFill>
      {segments.map(([a, b], i) =>
        b - a > 0.5 ? (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: один-два відрізки у фіксованому порядку
            key={i}
            {...{ [BG_ATTR]: color }}
            style={{ position: "absolute", background: color, ...segmentRect(from, a, b, w, h) }}
          />
        ) : null,
      )}
    </AbsoluteFill>
  );
}

/** clip-path для частки відкриття p (0 — закрито, 1 — відкрито). */
function clipFor(shape: "inset" | "circle" | "polygon", from: Side | "center", p: number): string {
  const pc = (n: number) => `${(n * 100).toFixed(2)}%`;
  const r = 1 - p;
  if (shape === "inset") {
    const [t, rt, b, l] =
      from === "center"
        ? [r / 2, r / 2, r / 2, r / 2]
        : from === "left"
          ? [0, r, 0, 0]
          : from === "right"
            ? [0, 0, 0, r]
            : from === "top"
              ? [0, 0, r, 0]
              : [r, 0, 0, 0];
    return `inset(${pc(t)} ${pc(rt)} ${pc(b)} ${pc(l)})`;
  }
  const [ox, oy] =
    from === "center"
      ? [0.5, 0.5]
      : from === "left"
        ? [0, 0.5]
        : from === "right"
          ? [1, 0.5]
          : from === "top"
            ? [0.5, 0]
            : [0.5, 1];
  if (shape === "circle") {
    // Радіус circle() у % рахується від √((w²+h²)/2); √2·max(відстаней до країв) накриває
    // найдальший кут за будь-яких пропорцій (для центру й кутів — точно).
    const far = Math.SQRT2 * Math.max(Math.max(ox, 1 - ox), Math.max(oy, 1 - oy));
    return `circle(${pc(p * far * 1.01)} at ${pc(ox)} ${pc(oy)})`;
  }
  if (from === "center") {
    // Ромб із центру: на p = 1 вершини на 100 % від центру — сторони проходять через кути.
    const d = p;
    return `polygon(50% ${pc(0.5 - d)}, ${pc(0.5 + d)} 50%, 50% ${pc(0.5 + d)}, ${pc(0.5 - d)} 50%)`;
  }
  // Косий край: передня точка йде на 125 %, задня відстає на 25 %, тож на p = 1 відкрито все.
  const lead = p * 1.25;
  const tail = lead - 0.25;
  switch (from) {
    case "left":
      return `polygon(0% 0%, ${pc(lead)} 0%, ${pc(tail)} 100%, 0% 100%)`;
    case "right":
      return `polygon(100% 0%, 100% 100%, ${pc(1 - lead)} 100%, ${pc(1 - tail)} 0%)`;
    case "top":
      return `polygon(0% 0%, 100% 0%, 100% ${pc(tail)}, 0% ${pc(lead)})`;
    case "bottom":
      return `polygon(0% 100%, 100% 100%, 100% ${pc(1 - lead)}, 0% ${pc(1 - tail)})`;
  }
}

/** Відкриває дітей через clip-path. */
export function ClipReveal(props: {
  shape?: "inset" | "circle" | "polygon";
  from?: Side | "center";
  startFrame?: number;
  duration?: number;
  easing?: EasingFn;
  style?: CSSProperties;
  children?: ReactNode;
}) {
  const frame = useCurrentFrame();
  const p = progress(frame, props.startFrame ?? 0, props.duration ?? 18, props.easing ?? easings.inOut);
  // Відкрито повністю — без clip-path: не ріже тіні й антиаліасинг дітей.
  const clipPath = p >= 1 ? undefined : clipFor(props.shape ?? "inset", props.from ?? "center", p);
  return <div style={{ position: "absolute", inset: 0, clipPath, ...props.style }}>{props.children}</div>;
}
