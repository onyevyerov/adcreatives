import { FORMAT_SIZE, type Format } from "@adc/shared/schemas/common";
import type { CSSProperties, ReactNode } from "react";
import { useVideoConfig } from "remotion";

export type { Format };

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FormatInfo {
  format: Format;
  /** 1080 | 1080 | 1920 */
  width: number;
  /** 1920 | 1080 | 1080 */
  height: number;
  /** Зона, де текст і лого гарантовано не перекриваються інтерфейсом соцмереж. */
  safe: Rect;
  isVertical: boolean;
  isLandscape: boolean;
  /** Масштаб відносно короткої сторони 1080 — для розмірів шрифтів і відступів. */
  unit: number;
}

export { FORMAT_SIZE };

/**
 * Відступи safe-зони в частках сторони кадру (top, right, bottom, left).
 * vertical: верх — шапка Reels/TikTok/Shorts, низ — підпис і кнопки, праворуч — рейка лайків
 *   (симетрично з лівим краєм, щоб центрований текст лишався по центру);
 * square: стрічка Instagram/Facebook — рівні поля;
 * landscape: YouTube/плеєри — поля під контроли й заголовок.
 */
export const SAFE_MARGINS: Record<Format, { top: number; right: number; bottom: number; left: number }> = {
  vertical: { top: 0.125, right: 0.111, bottom: 0.21, left: 0.111 },
  square: { top: 0.074, right: 0.074, bottom: 0.074, left: 0.074 },
  landscape: { top: 0.074, right: 0.05, bottom: 0.1, left: 0.05 },
};

/** Формат за розмірами кадру (для довільних розмірів — за співвідношенням сторін). */
export function formatFromSize(width: number, height: number): Format {
  for (const [format, size] of Object.entries(FORMAT_SIZE) as Array<
    [Format, { width: number; height: number }]
  >) {
    if (size.width === width && size.height === height) return format;
  }
  const ratio = width / height;
  if (ratio < 0.8) return "vertical";
  if (ratio > 1.25) return "landscape";
  return "square";
}

/** Чиста функція за `useFormat()`: формат, розміри, safe-зона. */
export function formatInfoFor(
  width: number,
  height: number,
  format = formatFromSize(width, height),
): FormatInfo {
  const m = SAFE_MARGINS[format];
  const left = Math.round(width * m.left);
  const right = Math.round(width * m.right);
  const top = Math.round(height * m.top);
  const bottom = Math.round(height * m.bottom);
  return {
    format,
    width,
    height,
    safe: { x: left, y: top, width: width - left - right, height: height - top - bottom },
    isVertical: format === "vertical",
    isLandscape: format === "landscape",
    unit: Math.min(width, height) / 1080,
  };
}

/** Розміри для формату (`FORMAT_SIZE` з `@adc/shared`). */
export function sizeForFormat(format: Format): { width: number; height: number } {
  return FORMAT_SIZE[format];
}

export function useFormat(): FormatInfo {
  const { width, height } = useVideoConfig();
  return formatInfoFor(width, height);
}

/** Чи лежить прямокутник у межах safe-зони (з допуском у px). */
export function isInsideRect(inner: Rect, outer: Rect, tolerance = 4): boolean {
  return (
    inner.x >= outer.x - tolerance &&
    inner.y >= outer.y - tolerance &&
    inner.x + inner.width <= outer.x + outer.width + tolerance &&
    inner.y + inner.height <= outer.y + outer.height + tolerance
  );
}

/** Контейнер на всю safe-зону; children позиціонуються всередині. */
export function SafeArea(props: { children: ReactNode; padding?: number; style?: CSSProperties }) {
  const { safe } = useFormat();
  const padding = props.padding ?? 0;
  return (
    <div
      style={{
        position: "absolute",
        left: safe.x,
        top: safe.y,
        width: safe.width,
        height: safe.height,
        padding,
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        ...props.style,
      }}
    >
      {props.children}
    </div>
  );
}
