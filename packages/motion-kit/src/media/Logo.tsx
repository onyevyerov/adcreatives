import { type CSSProperties, useRef } from "react";
import { Img, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { isDark, readableOn } from "../color.ts";
import { useFormat } from "../format.tsx";
import { springs } from "../motion.ts";
import { BG_ATTR, useQaCheck } from "../qa.tsx";
import { headingWeight, useAssets, useBrand, useTheme } from "../theme.tsx";

export interface LogoProps {
  /** Висота, px (дефолт 120 × unit). */
  size?: number;
  /** Фон, на якому стоїть лого; підкладка — якщо brand.logo.needsBackground. */
  variant?: "auto" | "onDark" | "onLight";
  startFrame?: number;
  style?: CSSProperties;
}

/** Лого бренду; без зображення — brand.logo.textFallback шрифтом heading. */
export function Logo(props: LogoProps) {
  const brand = useBrand();
  const theme = useTheme();
  const assets = useAssets();
  const { unit } = useFormat();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const ref = useRef<HTMLDivElement>(null);
  const size = props.size ?? Math.round(120 * unit);
  const variant = props.variant ?? "auto";
  const asset = brand.logo.assetId ? assets[brand.logo.assetId] : undefined;
  const p =
    props.startFrame === undefined
      ? 1
      : spring({ frame: frame - props.startFrame, fps, config: springs.premium });

  useQaCheck(ref, { component: "Logo", safeArea: true, contrast: !asset });

  const plateColor =
    variant === "onDark" ? "#FFFFFF" : variant === "onLight" ? theme.palette.primary : theme.palette.surface;
  const needsPlate = brand.logo.needsBackground;
  const textColor = needsPlate
    ? readableOn(plateColor, theme.palette)
    : variant === "onDark"
      ? theme.palette.textOnDark
      : variant === "onLight"
        ? theme.palette.textOnLight
        : isDark(theme.palette.background)
          ? theme.palette.textOnDark
          : theme.palette.primary;

  const wrapper: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "center",
    opacity: Math.min(1, p * 1.4),
    transform: `scale(${(0.8 + 0.2 * p).toFixed(4)})`,
    ...(needsPlate
      ? {
          background: plateColor,
          padding: `${Math.round(size * 0.18)}px ${Math.round(size * 0.3)}px`,
          borderRadius: theme.radius.md * unit,
        }
      : {}),
    ...props.style,
  };

  if (asset) {
    const width = Math.round((size * asset.width) / Math.max(1, asset.height));
    return (
      <div ref={ref} {...(needsPlate ? { [BG_ATTR]: plateColor } : {})} style={wrapper}>
        <Img
          src={staticFile(asset.src)}
          style={{ height: size, width, objectFit: "contain", display: "block" }}
        />
      </div>
    );
  }
  return (
    <div
      ref={ref}
      {...(needsPlate ? { [BG_ATTR]: plateColor } : {})}
      style={{
        ...wrapper,
        fontFamily: theme.fonts.heading,
        fontWeight: headingWeight(theme),
        fontSize: Math.round(size * 0.72),
        lineHeight: 1,
        color: textColor,
        whiteSpace: "nowrap",
        letterSpacing: "-0.01em",
      }}
    >
      {brand.logo.textFallback || brand.identity.name}
    </div>
  );
}
