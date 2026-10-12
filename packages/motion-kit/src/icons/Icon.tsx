import type { CSSProperties } from "react";
import { useTheme } from "../theme.tsx";
import { paint } from "../ui/paint.ts";
import { ICON_NAMES, type IconName } from "./names.ts";
import { ICON_PATHS } from "./paths.ts";

export { ICON_NAMES, type IconName };

/** Іконка lucide (вбудовані шляхи, сітка 24×24); `draw` 0..1 — промальовування штрихів. */
export function Icon(props: {
  name: IconName;
  size: number;
  color?: string;
  strokeWidth?: number;
  draw?: number;
  style?: CSSProperties;
}) {
  const theme = useTheme();
  const color = paint(theme, props.color, "accent");
  const draw = Math.max(0, Math.min(1, props.draw ?? 1));
  // pathLength=1: довжина кожного штриха — 1, тож dasharray «1 1» зі зсувом 1 − draw малює частку draw.
  const dash = draw < 1 ? { pathLength: 1, strokeDasharray: "1 1", strokeDashoffset: 1 - draw } : {};
  return (
    <svg
      width={props.size}
      height={props.size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={props.strokeWidth ?? 2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      // Нульовий штрих із круглими кінцями лишає крапки — до початку промальовки іконку ховаємо.
      style={{
        display: "block",
        flexShrink: 0,
        overflow: "visible",
        opacity: draw > 0 ? 1 : 0,
        ...props.style,
      }}
    >
      {ICON_PATHS[props.name].map((d) => (
        <path key={d} d={d} {...dash} />
      ))}
    </svg>
  );
}
