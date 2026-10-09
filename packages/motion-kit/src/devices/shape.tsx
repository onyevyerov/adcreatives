import type { Palette } from "@adc/shared/schemas/brandkit";
import { evolvePath } from "@remotion/paths";
import { type CSSProperties, type ReactNode, useMemo, useRef } from "react";
import { useCurrentFrame } from "remotion";
import { mix } from "../color.ts";
import { useFormat } from "../format.tsx";
import { type EasingFn, easings, progress } from "../motion.ts";
import { BG_ATTR, useQaCheck } from "../qa.tsx";
import { useTheme } from "../theme.tsx";

// Девайси форм: лінія, що малюється, і заокруглена форма між ключовими станами.
// Обидві перевіряють safe-зону (QA `outside_safe_area`), якщо не позначені `bleed`.

/** SVG-лінія, що малюється (evolvePath). */
export function DrawPath(props: {
  d: string;
  width: number;
  height: number;
  viewBox?: string;
  color?: keyof Palette;
  strokeWidth?: number;
  startFrame?: number;
  duration?: number;
  easing?: EasingFn;
  /** Може виходити за safe-зону (без QA-перевірки). */
  bleed?: boolean;
  style?: CSSProperties;
}) {
  const theme = useTheme();
  const { unit } = useFormat();
  const frame = useCurrentFrame();
  const ref = useRef<HTMLDivElement>(null);
  const p = progress(frame, props.startFrame ?? 0, props.duration ?? 24, props.easing ?? easings.inOut);
  // Довжину шляху evolvePath рахує сам; той самий p → ті самі dasharray/dashoffset.
  const dash = useMemo(() => evolvePath(p, props.d), [p, props.d]);
  useQaCheck(ref, { component: "DrawPath", safeArea: !props.bleed });
  return (
    <div
      ref={ref}
      // До старту лінія прихована повністю: круглий кінець нульового штриха інакше лишає крапку.
      style={{ width: props.width, height: props.height, opacity: p > 0 ? 1 : 0, ...props.style }}
    >
      <svg
        width={props.width}
        height={props.height}
        viewBox={props.viewBox ?? `0 0 ${props.width} ${props.height}`}
        style={{ display: "block", overflow: "visible" }}
        aria-hidden="true"
      >
        <path
          d={props.d}
          fill="none"
          stroke={theme.palette[props.color ?? "accent"]}
          strokeWidth={props.strokeWidth ?? 8 * unit}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeDasharray={dash.strokeDasharray}
          strokeDashoffset={dash.strokeDashoffset}
        />
      </svg>
    </div>
  );
}

/** Ключовий стан MorphShape, px. */
export interface MorphKey {
  /** Старт переходу в цей стан; дефолт — старт попереднього + duration. */
  at?: number;
  x: number;
  y: number;
  width: number;
  height: number;
  radius?: number;
  color?: keyof Palette;
}

/** Заокруглена форма між ключовими станами. */
export function MorphShape(props: {
  keys: MorphKey[];
  duration?: number;
  easing?: EasingFn;
  /** Може виходити за safe-зону (без QA-перевірки). */
  bleed?: boolean;
  style?: CSSProperties;
  children?: ReactNode;
}) {
  const theme = useTheme();
  const { unit } = useFormat();
  const frame = useCurrentFrame();
  const ref = useRef<HTMLDivElement>(null);
  const duration = props.duration ?? 18;
  const easing = props.easing ?? easings.inOut;

  // Стан — послідовна інтерполяція від першого ключа: кожен наступний перехід стартує з того,
  // де форма є зараз, тож ключі, що перекриваються в часі, не дають стрибка.
  const first = props.keys[0];
  let role: keyof Palette = first?.color ?? "primary";
  let radius = first?.radius ?? theme.radius.lg * unit;
  const s = {
    x: first?.x ?? 0,
    y: first?.y ?? 0,
    width: first?.width ?? 0,
    height: first?.height ?? 0,
    radius,
    color: theme.palette[role],
  };
  let start = first?.at ?? 0;
  for (const key of props.keys.slice(1)) {
    start = key.at ?? start + duration;
    role = key.color ?? role;
    radius = key.radius ?? radius;
    const t = progress(frame, start, duration, easing);
    if (t <= 0) break;
    const lerp = (a: number, b: number) => a + (b - a) * t;
    s.x = lerp(s.x, key.x);
    s.y = lerp(s.y, key.y);
    s.width = lerp(s.width, key.width);
    s.height = lerp(s.height, key.height);
    s.radius = lerp(s.radius, radius);
    s.color = t >= 1 ? theme.palette[role] : mix(s.color, theme.palette[role], t);
  }

  useQaCheck(ref, { component: "MorphShape", safeArea: !props.bleed });
  // Радіус не більший за половину короткої сторони: інакше браузер стискає кути нерівно.
  const corner = Math.min(s.radius, Math.min(s.width, s.height) / 2);
  return (
    <div
      ref={ref}
      {...{ [BG_ATTR]: s.color }}
      style={{
        position: "absolute",
        left: s.x,
        top: s.y,
        width: s.width,
        height: s.height,
        borderRadius: corner,
        background: s.color,
        overflow: "hidden",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        ...props.style,
      }}
    >
      {props.children}
    </div>
  );
}
