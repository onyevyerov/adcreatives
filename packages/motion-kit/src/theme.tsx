import type { BrandKit, MotionPersonality, Palette } from "@adc/shared/schemas/brandkit";
import type { AssetRef } from "@adc/shared/types/video";
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";
import { useDelayRender } from "remotion";
import {
  type FontInfo,
  fontStack,
  loadPlannedFont,
  MONO_FALLBACK_STACK,
  monoChoice,
  monoStack,
  planFont,
} from "./fonts.ts";

export { MONO_FALLBACK_STACK };

/** Палітра теми: ролі бренд-кіта, семантичні (danger, warning, success) — завжди кольори. */
export type ThemePalette = { [K in keyof Palette]: string };

/**
 * Семантичні кольори для бренд-кітів без них (старі версії) — ті самі базові кольори, від яких
 * бренд-кіт виводить свої (B2): danger червоний, warning бурштиновий, success зелений.
 */
export const SEMANTIC_FALLBACK = { danger: "#EF4444", warning: "#F59E0B", success: "#22C55E" } as const;

export interface Theme {
  /** primary, secondary, accent, background, surface, textOnDark, textOnLight, danger, warning, success */
  palette: ThemePalette;
  /** CSS font-family, вже завантажені; mono — для чисел, eyebrow і статусів. */
  fonts: { heading: string; body: string; mono: string };
  weights: { heading: number[]; body: number[] };
  /** px для кадру з короткою стороною 1080 (множити на `useFormat().unit`), з visualStyle.shapes. */
  radius: { sm: number; md: number; lg: number; pill: number };
  motion: MotionPersonality;
  density: "airy" | "balanced" | "dense";
}

const RADIUS: Record<BrandKit["visualStyle"]["shapes"], Theme["radius"]> = {
  rounded: { sm: 12, md: 24, lg: 44, pill: 999 },
  organic: { sm: 18, md: 36, lg: 64, pill: 999 },
  geometric: { sm: 4, md: 8, lg: 14, pill: 999 },
  sharp: { sm: 0, md: 0, lg: 0, pill: 0 },
};

/** Тема з бренд-кіта (чиста функція; ваги — фактично завантажені). */
export function buildTheme(brand: BrandKit, weights?: { heading: number[]; body: number[] }): Theme {
  const p = brand.palette;
  return {
    palette: {
      ...p,
      danger: p.danger ?? SEMANTIC_FALLBACK.danger,
      warning: p.warning ?? SEMANTIC_FALLBACK.warning,
      success: p.success ?? SEMANTIC_FALLBACK.success,
    },
    fonts: {
      heading: fontStack(brand.typography.heading.family),
      body: fontStack(brand.typography.body.family),
      // Без `typography.mono` — JetBrains Mono (якщо рендер передав його метадані), далі системний monospace.
      mono: monoStack(monoChoice(brand.typography).family),
    },
    weights: weights ?? {
      heading: [...brand.typography.heading.weights].sort((a, b) => a - b),
      body: [...brand.typography.body.weights].sort((a, b) => a - b),
    },
    radius: RADIUS[brand.visualStyle.shapes],
    motion: brand.visualStyle.motionPersonality,
    density: brand.visualStyle.density,
  };
}

/** Найважча вага заголовків. */
export function headingWeight(theme: Theme): number {
  return theme.weights.heading[theme.weights.heading.length - 1] ?? 700;
}

/** Вага основного тексту, найближча до 400. */
export function bodyWeight(theme: Theme): number {
  const sorted = [...theme.weights.body].sort((a, b) => Math.abs(a - 400) - Math.abs(b - 400));
  return sorted[0] ?? 400;
}

interface ThemeContextValue {
  theme: Theme;
  brand: BrandKit;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/**
 * Ставить хост. Завантажує шрифти бренду (`fonts` — метадані Google Fonts від рендера),
 * не малює дітей, доки шрифти не готові (інакше виміри тексту були б з резервного шрифту).
 */
export function ThemeProvider(props: { brand: BrandKit; fonts?: FontInfo[]; children: ReactNode }) {
  const { brand, fonts } = props;
  const plans = useMemo(() => {
    const infos = fonts ?? [];
    const mono = monoChoice(brand.typography);
    return {
      heading: planFont(brand.typography.heading.family, brand.typography.heading.weights, infos),
      body: planFont(brand.typography.body.family, brand.typography.body.weights, infos),
      mono: planFont(mono.family, mono.weights, infos),
    };
  }, [brand, fonts]);
  const needsLoading = plans.heading.info !== null || plans.body.info !== null || plans.mono.info !== null;
  const { delayRender, continueRender } = useDelayRender();
  const [handle] = useState(() => (needsLoading ? delayRender("motion-kit: шрифти бренду") : null));
  const [ready, setReady] = useState(!needsLoading);

  useEffect(() => {
    if (!needsLoading) return;
    let cancelled = false;
    Promise.all([loadPlannedFont(plans.heading), loadPlannedFont(plans.body), loadPlannedFont(plans.mono)])
      .catch((err: unknown) => {
        console.warn(`motion-kit: шрифти не завантажились, резервний стек: ${String(err)}`);
      })
      .finally(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [needsLoading, plans]);

  // continueRender — лише після коміту дітей, щоб їхні власні delayRender уже були зареєстровані.
  useEffect(() => {
    if (ready && handle !== null) continueRender(handle);
  }, [ready, handle, continueRender]);

  const value = useMemo<ThemeContextValue>(
    () => ({
      brand,
      theme: buildTheme(brand, { heading: plans.heading.weights, body: plans.body.weights }),
    }),
    [brand, plans],
  );
  return <ThemeContext.Provider value={value}>{ready ? props.children : null}</ThemeContext.Provider>;
}

function useThemeContext(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("motion-kit: компонент використано поза <ThemeProvider> (його ставить хост)");
  return ctx;
}

export function useTheme(): Theme {
  return useThemeContext().theme;
}

/** Бренд-кіт поточного дерева (для Logo і шаблонів). */
export function useBrand(): BrandKit {
  return useThemeContext().brand;
}

// ---------- асети і тривалість сцени (ставить хост) ----------

const AssetsContext = createContext<Record<string, AssetRef>>({});

/** Лише для хоста: асети ревізії для `<BrandImage assetId>` і `<Logo>`. */
export function AssetsProvider(props: { assets: Record<string, AssetRef>; children: ReactNode }) {
  return <AssetsContext.Provider value={props.assets}>{props.children}</AssetsContext.Provider>;
}

export function useAssets(): Record<string, AssetRef> {
  return useContext(AssetsContext);
}

const SceneDurationContext = createContext<number | null>(null);

/** Лише для хоста: тривалість послідовності поточної сцени (для kenBurns/parallax). */
export function SceneDurationProvider(props: { durationInFrames: number; children: ReactNode }) {
  return (
    <SceneDurationContext.Provider value={props.durationInFrames}>
      {props.children}
    </SceneDurationContext.Provider>
  );
}

export function useSceneDuration(fallback: number): number {
  return useContext(SceneDurationContext) ?? fallback;
}
