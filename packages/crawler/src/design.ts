import type { DesignStats } from "@adc/shared";
import type { RawDesign } from "./inpage.ts";

const COLOR_ROLES = ["background", "heading", "text", "button", "buttonText", "link"] as const;
const FONT_ROLES = ["h1", "h2", "body", "button"] as const;
type ColorRole = (typeof COLOR_ROLES)[number];
type FontRole = (typeof FONT_ROLES)[number];

const isColorRole = (r: string): r is ColorRole => (COLOR_ROLES as readonly string[]).includes(r);
const isFontRole = (r: string): r is FontRole => (FONT_ROLES as readonly string[]).includes(r);

/**
 * Зводить дизайн-статистику сторінок: CSS-змінні (перша сторінка має пріоритет),
 * частоти кольорів за ролями (до 6 на роль), найчастіший шрифт на роль, радіус кнопок.
 */
export function mergeDesign(designs: Array<RawDesign | null>, perRole = 6): DesignStats | null {
  const list = designs.filter((d): d is RawDesign => d !== null);
  if (list.length === 0) return null;

  const cssVars: Record<string, string> = {};
  for (const d of list) {
    for (const [k, v] of Object.entries(d.cssVars)) if (!(k in cssVars)) cssVars[k] = v;
  }

  const colorCounts = new Map<string, number>();
  for (const d of list) {
    for (const c of d.colors) {
      if (!isColorRole(c.role) || !/^#[0-9A-F]{6}$/i.test(c.value)) continue;
      const key = `${c.role}|${c.value.toUpperCase()}`;
      colorCounts.set(key, (colorCounts.get(key) ?? 0) + c.count);
    }
  }
  const colors: DesignStats["colors"] = [];
  for (const role of COLOR_ROLES) {
    const entries = [...colorCounts.entries()]
      .filter(([k]) => k.startsWith(`${role}|`))
      .sort((a, b) => b[1] - a[1])
      .slice(0, perRole);
    for (const [k, count] of entries) colors.push({ role, value: k.split("|")[1] as string, count });
  }

  const fonts: DesignStats["fonts"] = [];
  for (const role of FONT_ROLES) {
    const counts = new Map<string, number>();
    for (const d of list) {
      for (const f of d.fonts) {
        if (!isFontRole(f.role) || f.role !== role || !f.family) continue;
        const key = `${f.family}|${Math.round(f.weight)}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (top) {
      const [family, weight] = top[0].split("|");
      fonts.push({ role, family: family as string, weight: Number(weight) });
    }
  }

  const radii = new Map<string, number>();
  for (const d of list) for (const [r, n] of Object.entries(d.radii)) radii.set(r, (radii.get(r) ?? 0) + n);
  const buttonRadius = [...radii.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  return { cssVars, colors, fonts, buttonRadius, fontFaces: [] };
}
