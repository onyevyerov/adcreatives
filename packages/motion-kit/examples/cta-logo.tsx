/**
 * Еталон: фінальний CTA з лого. Лого — м'якою пружиною, заклик — масштабом,
 * кнопка пульсує; градієнт у кольорах бренду повільно дрейфує.
 */
import type { SceneProps } from "@adc/motion-kit";
import {
  Backdrop,
  Body,
  CTAButton,
  Headline,
  Logo,
  mix,
  readableOn,
  SafeArea,
  useFormat,
  useTheme,
} from "@adc/motion-kit";
import { AbsoluteFill } from "remotion";

export default function Scene(props: SceneProps) {
  const theme = useTheme();
  const { unit } = useFormat();
  const { headline, sub, emphasis } = props.scene.text;
  const dark = mix(theme.palette.primary, "#000000", 0.35);
  const color = readableOn(dark, theme.palette);

  return (
    <AbsoluteFill>
      <Backdrop variant="gradient" colors={[theme.palette.primary, dark]} angle={150} animate />
      <SafeArea style={{ justifyContent: "center", alignItems: "center", gap: 48 * unit }}>
        <Logo variant="onDark" startFrame={0} />
        <Headline text={headline} emphasis={emphasis} preset="scale" startFrame={10} size="l" color={color} />
        {sub ? <Body text={sub} preset="fade" startFrame={18} size="s" color={color} /> : null}
        <CTAButton text={props.brand.cta.text} startFrame={24} variant="accent" />
      </SafeArea>
    </AbsoluteFill>
  );
}
