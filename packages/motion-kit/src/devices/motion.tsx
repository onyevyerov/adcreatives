import type { CSSProperties, ReactNode } from "react";
import { AbsoluteFill, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { useFormat } from "../format.tsx";
import { type EasingFn, easings, progress, type SpringConfig, springFor } from "../motion.ts";
import { useTheme } from "../theme.tsx";

// Девайси руху: один біт на кілька елементів і «дихання» кадру. Обидва — чисті функції кадру
// (без стану), тож той самий кадр дає той самий результат у будь-якому порядку рендеру.

/** 0→1 від кадру `at`: пружина бренду або progress за `duration` (clamp). */
export function useBeat(
  at: number,
  opts?: { duration?: number; easing?: EasingFn; config?: SpringConfig },
): number {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const theme = useTheme();
  if (opts?.duration !== undefined) return progress(frame, at, opts.duration, opts.easing ?? easings.out);
  // Пружина до свого старту повертає 0; snappy може перелетіти 1 на ~5 % — це і є «реакція».
  return spring({ frame: frame - at, fps, config: opts?.config ?? springFor(theme.motion) });
}

/** Період дихання за характером руху, кадрів при 30 fps. */
const BREATHE_PERIOD = { energetic: 45, playful: 54, calm: 75, premium: 90 } as const;

/** Шар на весь кадр, що «дихає» з `startFrame` (масштаб і зсув по косинусу). */
export function Breathe(props: {
  startFrame?: number;
  period?: number;
  amount?: number;
  drift?: number;
  style?: CSSProperties;
  children?: ReactNode;
}) {
  const theme = useTheme();
  const { safe } = useFormat();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const period = Math.max(1, props.period ?? Math.round((BREATHE_PERIOD[theme.motion] * fps) / 30));
  const t = Math.max(0, frame - (props.startFrame ?? 0));
  // (1 − cos)/2: старт із нуля з нульовою швидкістю, тож поява дихання не дає ривка.
  const w = (1 - Math.cos((2 * Math.PI * t) / period)) / 2;
  const scale = 1 + (props.amount ?? 0.006) * w;
  const dy = -(props.drift ?? 0) * w;
  return (
    <AbsoluteFill
      style={{
        // Центр масштабу — центр safe-зони: дефолтний amount тримає текст біля її краю в допуску 4 px.
        transformOrigin: `${safe.x + safe.width / 2}px ${safe.y + safe.height / 2}px`,
        transform: `translateY(${dy.toFixed(3)}px) scale(${scale.toFixed(5)})`,
        ...props.style,
      }}
    >
      {props.children}
    </AbsoluteFill>
  );
}
