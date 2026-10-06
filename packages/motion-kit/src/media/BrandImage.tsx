import type { AssetRef } from "@adc/shared/types/video";
import { type CSSProperties, useRef } from "react";
import { Img, interpolate, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { mix } from "../color.ts";
import { easings } from "../motion.ts";
import { BG_ATTR, qaLog, useQaCheck, useQaEnabled } from "../qa.tsx";
import { useAssets, useSceneDuration, useTheme } from "../theme.tsx";

export interface Mask {
  type: "rounded" | "circle" | "blob" | "diagonal";
}

export interface KenBurns {
  /** Масштаб 1.0–1.25. */
  from: number;
  to: number;
  direction?: "in" | "out" | "left" | "right" | "up" | "down";
}

export interface BrandImageProps {
  /** Ключ з props.assets; невідомий id → нейтральний фон + QA-лог. */
  assetId: string;
  /** Дефолт "cover". */
  fit?: "cover" | "contain";
  /** Дефолт — AssetRef.focal. */
  focal?: { x: number; y: number };
  kenBurns?: KenBurns;
  /** px зсуву за сцену. */
  parallax?: number;
  mask?: Mask;
  radius?: number;
  /** Затемнення під текст. */
  overlay?: { color: string; opacity: number };
  startFrame?: number;
  /** Розмір і позиція контейнера (дефолт — на весь батьківський блок). */
  style?: CSSProperties;
}

/** Збільшення, після якого фото помітно мило. */
export const UPSCALE_LIMIT = 2;

const clampScale = (s: number) => Math.max(1, Math.min(1.25, s));

/** Масштаб, з яким фото заповнює контейнер (без Ken Burns). */
export function coverScale(
  asset: Pick<AssetRef, "width" | "height">,
  box: { width: number; height: number },
  fit: "cover" | "contain",
): number {
  const sx = box.width / Math.max(1, asset.width);
  const sy = box.height / Math.max(1, asset.height);
  return fit === "cover" ? Math.max(sx, sy) : Math.min(sx, sy);
}

function maskStyle(
  mask: Mask | undefined,
  radius: number | undefined,
  fallbackRadius: number,
): CSSProperties {
  switch (mask?.type) {
    case "circle":
      return { borderRadius: "50%" };
    case "blob":
      return { borderRadius: "42% 58% 63% 37% / 41% 44% 56% 59%" };
    case "diagonal":
      return { clipPath: "polygon(0 0, 100% 0, 100% 86%, 0 100%)", borderRadius: radius ?? 0 };
    case "rounded":
      return { borderRadius: radius ?? fallbackRadius };
    default:
      return radius !== undefined ? { borderRadius: radius } : {};
  }
}

/** Фото з асетів ревізії: кроп за фокусом, Ken Burns, паралакс, маски. */
export function BrandImage(props: BrandImageProps) {
  const assets = useAssets();
  const theme = useTheme();
  const frame = useCurrentFrame();
  const { durationInFrames: compDuration } = useVideoConfig();
  const duration = useSceneDuration(compDuration);
  const ref = useRef<HTMLDivElement>(null);
  const qaEnabled = useQaEnabled();
  const asset = assets[props.assetId];
  const fit = props.fit ?? "cover";
  const start = props.startFrame ?? 0;
  const kb = props.kenBurns;
  const kbMax = kb ? Math.max(clampScale(kb.from), clampScale(kb.to)) : 1;

  useQaCheck(ref, {
    component: "BrandImage",
    extra: (el, report) => {
      if (!asset) {
        report("stretched_image", `невідомий assetId "${props.assetId}" — показано нейтральний фон`, null);
        return;
      }
      const box = { width: el.offsetWidth, height: el.offsetHeight };
      if (box.width > 0 && box.height > 0) {
        const scale = coverScale(asset, box, fit) * kbMax;
        if (scale > UPSCALE_LIMIT) {
          report(
            "upscaled_image",
            `асет ${props.assetId} ${asset.width}×${asset.height} збільшено в ${scale.toFixed(2)}× під ${box.width}×${box.height}`,
            Math.round(scale * 100) / 100,
          );
        }
      }
    },
  });

  const shape = maskStyle(props.mask, props.radius, theme.radius.lg);
  const container: CSSProperties = {
    position: "absolute",
    inset: 0,
    overflow: "hidden",
    ...shape,
    ...props.style,
  };

  if (!asset) {
    return (
      <div
        ref={ref}
        {...{ [BG_ATTR]: theme.palette.surface }}
        style={{ ...container, background: theme.palette.surface }}
      />
    );
  }

  const focal = props.focal ?? asset.focal;
  const t = interpolate(frame, [start, Math.max(start + 1, duration)], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: easings.inOut,
  });

  let scale = 1;
  let tx = 0;
  let ty = 0;
  if (kb) {
    const from = clampScale(kb.from);
    const to = clampScale(kb.to);
    const dir = kb.direction ?? "in";
    const [a, b] = dir === "out" ? [Math.max(from, to), Math.min(from, to)] : [from, to];
    scale = a + (b - a) * t;
    // Панорама в межах запасу кропу: зсув ≤ (s − 1) / 2s від розміру.
    const room = ((Math.min(from, to) - 1) / (2 * Math.min(from, to))) * 100;
    const pan = room * (1 - 2 * t);
    if (dir === "left") tx = pan;
    if (dir === "right") tx = -pan;
    if (dir === "up") ty = pan;
    if (dir === "down") ty = -pan;
  }
  const parallax = props.parallax ?? 0;
  const py = parallax ? parallax / 2 - parallax * t : 0;

  return (
    <div ref={ref} {...{ [BG_ATTR]: "image" }} style={container}>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: -Math.abs(parallax) / 2,
          bottom: -Math.abs(parallax) / 2,
          transform: `translateY(${py.toFixed(2)}px)`,
        }}
      >
        <Img
          src={staticFile(asset.src)}
          onLoad={(e) => {
            if (!qaEnabled) return;
            const img = e.currentTarget;
            if (img.naturalWidth <= 0 || img.naturalHeight <= 0) return;
            const declared = asset.width / asset.height;
            const real = img.naturalWidth / img.naturalHeight;
            if (Math.abs(declared / real - 1) > 0.03) {
              qaLog({
                kind: "stretched_image",
                component: "BrandImage",
                detail: `асет ${props.assetId}: пропорції в assets.json ${declared.toFixed(3)} ≠ файл ${real.toFixed(3)}`,
                value: Math.round((declared / real) * 1000) / 1000,
                frame,
              });
            }
          }}
          style={{
            width: "100%",
            height: "100%",
            objectFit: fit,
            objectPosition: `${(focal.x * 100).toFixed(2)}% ${(focal.y * 100).toFixed(2)}%`,
            transformOrigin: `${(focal.x * 100).toFixed(2)}% ${(focal.y * 100).toFixed(2)}%`,
            transform: `scale(${scale.toFixed(5)}) translate(${tx.toFixed(3)}%, ${ty.toFixed(3)}%)`,
          }}
        />
      </div>
      {props.overlay ? (
        <div
          // Для перевірки контрасту: фото невідоме, беремо середньо-сірий під затемненням.
          {...{
            [BG_ATTR]:
              props.overlay.opacity >= 0.45
                ? mix("#808080", props.overlay.color, props.overlay.opacity)
                : "image",
          }}
          style={{
            position: "absolute",
            inset: 0,
            background: props.overlay.color,
            opacity: props.overlay.opacity,
          }}
        />
      ) : null}
    </div>
  );
}
