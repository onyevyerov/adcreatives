import type { Palette } from "@adc/shared/schemas/brandkit";
import type { Theme } from "../theme.tsx";

/** Колір прийому: роль палітри (`"accent"`, `"surface"`…) → колір теми; інший рядок — CSS-колір як є. */
export function paint(theme: Theme, color: string | undefined, fallback: keyof Palette): string {
  if (color === undefined || color === "") return theme.palette[fallback];
  return Object.hasOwn(theme.palette, color) ? theme.palette[color as keyof Palette] : color;
}
