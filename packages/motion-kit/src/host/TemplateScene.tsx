import type { ScenePurpose } from "@adc/shared/schemas/storyboard";
import type { SceneProps } from "@adc/shared/types/video";
import { AbsoluteFill } from "remotion";
import { averageColor, mix, readableOn } from "../color.ts";
import { SafeArea, useFormat } from "../format.tsx";
import { Backdrop } from "../media/Backdrop.tsx";
import { BrandImage } from "../media/BrandImage.tsx";
import { Logo } from "../media/Logo.tsx";
import { Body, CTAButton, Headline } from "../text/components.tsx";
import { normalizeWord, splitWords } from "../text/layout.ts";
import { useTheme } from "../theme.tsx";

export type TemplateVariant = "hero" | "text" | "image" | "cta";

export const TEMPLATE_VARIANTS: readonly TemplateVariant[] = ["hero", "text", "image", "cta"];

const BY_PURPOSE: Record<ScenePurpose, TemplateVariant> = {
  hook: "hero",
  brand: "hero",
  problem: "text",
  offer: "text",
  benefit: "text",
  proof: "text",
  product: "image",
  cta: "cta",
};

/** Детермінований вибір шаблону за scene.purpose. */
export function templateVariantFor(purpose: ScenePurpose): TemplateVariant {
  return BY_PURPOSE[purpose];
}

/** Перший асет сцени, що є в props.assets (або null). */
export function firstAvailableAsset(props: Pick<SceneProps, "scene" | "assets">): string | null {
  return props.scene.assetIds.find((id) => props.assets[id] !== undefined) ?? null;
}

const sameText = (a: string, b: string) =>
  splitWords(a).map(normalizeWord).join(" ") === splitWords(b).map(normalizeWord).join(" ");

function HeroTemplate(props: SceneProps) {
  const theme = useTheme();
  const { unit } = useFormat();
  const assetId = firstAvailableAsset(props);
  const bgColors = [theme.palette.primary, mix(theme.palette.primary, "#000000", 0.4)];
  const textColor = assetId ? "#FFFFFF" : readableOn(averageColor(bgColors), theme.palette);
  const { headline, sub, emphasis } = props.scene.text;
  return (
    <AbsoluteFill>
      {assetId ? (
        <BrandImage
          assetId={assetId}
          kenBurns={{ from: 1, to: 1.12, direction: "in" }}
          overlay={{ color: "#000000", opacity: 0.5 }}
        />
      ) : (
        <Backdrop variant="gradient" colors={bgColors} animate />
      )}
      <SafeArea style={{ justifyContent: "flex-end", gap: 28 * unit }}>
        <Headline
          text={headline}
          emphasis={emphasis}
          preset="rise"
          startFrame={4}
          size="xl"
          color={textColor}
        />
        {sub ? <Body text={sub} preset="fade" startFrame={16} size="l" color={textColor} /> : null}
      </SafeArea>
    </AbsoluteFill>
  );
}

function TextTemplate(props: SceneProps) {
  const theme = useTheme();
  const { unit } = useFormat();
  const bg = theme.palette.background;
  const color = readableOn(bg, theme.palette);
  const { headline, sub, emphasis } = props.scene.text;
  return (
    <AbsoluteFill>
      <Backdrop variant="shapes" color={bg} animate />
      <SafeArea style={{ justifyContent: "center", gap: 36 * unit }}>
        <Headline
          text={headline}
          emphasis={emphasis}
          preset="highlight"
          startFrame={2}
          size="xl"
          color={color}
        />
        {sub ? (
          <Body text={sub} emphasis={emphasis} preset="fade" startFrame={18} size="l" color={color} />
        ) : null}
      </SafeArea>
    </AbsoluteFill>
  );
}

function ImageTemplate(props: SceneProps) {
  const theme = useTheme();
  const { safe, unit, isLandscape, width, height } = useFormat();
  const assetId = firstAvailableAsset(props);
  const bg = theme.palette.background;
  const color = readableOn(bg, theme.palette);
  const { headline, sub, emphasis } = props.scene.text;
  const gap = 32 * unit;
  // landscape: фото праворуч на половину кадру; інакше — фото зверху.
  const imageStyle = isLandscape
    ? { left: width / 2, top: 0, width: width / 2, height }
    : { left: 0, top: 0, width, height: Math.round(height * 0.52) };
  const textBox = isLandscape
    ? { left: safe.x, top: safe.y, width: width / 2 - safe.x - gap, height: safe.height }
    : {
        left: safe.x,
        top: imageStyle.height + gap,
        width: safe.width,
        height: safe.y + safe.height - imageStyle.height - gap,
      };
  return (
    <AbsoluteFill>
      <Backdrop variant="solid" color={bg} />
      {assetId ? (
        <BrandImage
          assetId={assetId}
          kenBurns={{ from: 1.02, to: 1.12, direction: isLandscape ? "left" : "up" }}
          mask={{ type: "diagonal" }}
          style={{ ...imageStyle, inset: undefined }}
        />
      ) : (
        <div style={{ position: "absolute", ...imageStyle }}>
          <Backdrop variant="gradient" colors={[theme.palette.primary, theme.palette.secondary]} animate />
        </div>
      )}
      <div
        style={{
          position: "absolute",
          ...textBox,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          gap: gap * 0.8,
        }}
      >
        <Headline
          text={headline}
          emphasis={emphasis}
          preset="rise"
          startFrame={6}
          size="l"
          color={color}
          width={textBox.width}
          align={isLandscape ? "left" : "center"}
        />
        {sub ? (
          <Body
            text={sub}
            preset="fade"
            startFrame={18}
            color={color}
            width={textBox.width}
            align={isLandscape ? "left" : "center"}
          />
        ) : null}
      </div>
    </AbsoluteFill>
  );
}

function CtaTemplate(props: SceneProps) {
  const theme = useTheme();
  const { unit } = useFormat();
  const bgColors = [theme.palette.primary, mix(theme.palette.primary, "#000000", 0.35)];
  const color = readableOn(averageColor(bgColors), theme.palette);
  const { headline, sub, emphasis } = props.scene.text;
  const ctaText = props.brand.cta.text || headline;
  const showHeadline = !sameText(headline, ctaText);
  return (
    <AbsoluteFill>
      <Backdrop variant="gradient" colors={bgColors} angle={145} animate />
      <SafeArea style={{ justifyContent: "center", alignItems: "center", gap: 44 * unit }}>
        <Logo variant="onDark" startFrame={0} />
        {showHeadline ? (
          <Headline
            text={headline}
            emphasis={emphasis}
            preset="scale"
            startFrame={8}
            size="l"
            color={color}
          />
        ) : null}
        {sub ? <Body text={sub} preset="fade" startFrame={16} color={color} /> : null}
        <CTAButton text={ctaText} startFrame={20} variant="accent" />
      </SafeArea>
    </AbsoluteFill>
  );
}

/** Лише для хоста: детерміновані шаблони hero | text | image | cta; вибір за scene.purpose. */
export function TemplateScene(props: SceneProps & { variant?: TemplateVariant }) {
  const variant = props.variant ?? templateVariantFor(props.scene.purpose);
  switch (variant) {
    case "hero":
      return <HeroTemplate {...props} />;
    case "text":
      return <TextTemplate {...props} />;
    case "image":
      return <ImageTemplate {...props} />;
    case "cta":
      return <CtaTemplate {...props} />;
  }
}
