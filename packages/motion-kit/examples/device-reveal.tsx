/**
 * Еталон девайсів замість ручної математики: поле primary витирає кадр, фото відкривається косим краєм,
 * текст підтягується тим самим бітом, під заголовком малюється лінія, а коли все сіло — кадр «дихає».
 * Landscape: фото й текст у два стовпці.
 */
import type { SceneProps } from "@adc/motion-kit";
import {
  Backdrop,
  Body,
  BrandImage,
  Breathe,
  ClipReveal,
  ColorField,
  contrastRatio,
  DrawPath,
  defaultStagger,
  Headline,
  isDark,
  readableOn,
  SafeArea,
  useBeat,
  useFormat,
  useTheme,
} from "@adc/motion-kit";
import { AbsoluteFill } from "remotion";

export default function Scene(props: SceneProps) {
  const theme = useTheme();
  const { unit, isLandscape, safe } = useFormat();
  const { headline, sub, emphasis } = props.scene.text;
  const assetId = props.scene.assetIds[0];
  const { palette } = theme;

  // Після вхідного переходу; поле накриває кадр за 15 кадрів, фото — з його середини.
  const start = props.scene.transitionFrames;
  const photoAt = start + 8;
  // Заголовок (fade по словах) читабельний через (слів − 1) × stagger + 12 — до ~чверті сцени.
  const readyBy = Math.round(props.durationInFrames * 0.25);
  const stagger = defaultStagger(theme.motion, "word");
  const needs = (headline.split(/\s+/).filter(Boolean).length - 1) * stagger + 12;
  const headlineAt = Math.max(start, Math.min(photoAt + 6, readyBy - needs));
  const lineAt = headlineAt + needs - 6;
  // Один біт на фото й текст: елементи реагують один на одного.
  const beat = useBeat(photoAt);

  // Текст на полі primary; акцент (emphasis, лінія) — лише якщо читається на ньому.
  const color = readableOn(palette.primary, palette);
  const accentOk = contrastRatio(palette.accent, palette.primary) >= 3;
  const gap = 40 * unit;
  const col = isLandscape ? (safe.width - gap) / 2 : safe.width;
  const lineW = Math.round(col * 0.4);
  const lineH = 24 * unit;

  return (
    <AbsoluteFill>
      <ColorField color="primary" from="left" startFrame={start}>
        <Backdrop variant="solid" />
      </ColorField>
      <Breathe startFrame={lineAt + 24}>
        <SafeArea style={{ flexDirection: isLandscape ? "row" : "column", justifyContent: "center", gap }}>
          {assetId ? (
            <ClipReveal
              shape="polygon"
              from="left"
              startFrame={photoAt}
              style={{
                position: "relative",
                width: col,
                height: isLandscape ? safe.height : safe.height * 0.4,
                borderRadius: theme.radius.lg * unit,
                overflow: "hidden",
              }}
            >
              <BrandImage assetId={assetId} kenBurns={{ from: 1.05, to: 1.15 }} />
            </ClipReveal>
          ) : null}
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: isLandscape ? "flex-start" : "center",
              justifyContent: "center",
              gap: 20 * unit,
              transform: `translateY(${(1 - beat) * 60 * unit}px)`,
            }}
          >
            <Headline
              text={headline}
              emphasis={accentOk ? emphasis : undefined}
              preset="fade"
              startFrame={headlineAt}
              size="m"
              color={color}
              width={col}
              align={isLandscape ? "left" : "center"}
            />
            <DrawPath
              d={`M 6 ${lineH - 6} Q ${lineW / 2} 2 ${lineW - 6} ${lineH - 6}`}
              width={lineW}
              height={lineH}
              startFrame={lineAt}
              color={accentOk ? "accent" : isDark(palette.primary) ? "textOnDark" : "textOnLight"}
            />
            {sub ? (
              <Body
                text={sub}
                preset="fade"
                startFrame={lineAt}
                size="s"
                color={color}
                width={col}
                align={isLandscape ? "left" : "center"}
              />
            ) : null}
          </div>
        </SafeArea>
      </Breathe>
    </AbsoluteFill>
  );
}
