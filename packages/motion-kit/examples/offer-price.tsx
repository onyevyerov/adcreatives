/**
 * Еталон: оффер із ціною. Плашка з ціною «вистрибує» пружиною, заголовок з акцентом,
 * умова оффера — дрібніше. Фон — м'які форми в кольорах бренду.
 */
import type { SceneProps } from "@adc/motion-kit";
import { Backdrop, Body, Headline, Pill, readableOn, SafeArea, useFormat, useTheme } from "@adc/motion-kit";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";

export default function Scene(props: SceneProps) {
  const theme = useTheme();
  const { unit } = useFormat();
  const frame = useCurrentFrame();
  const { headline, sub, emphasis } = props.scene.text;
  const color = readableOn(theme.palette.background, theme.palette);
  // Плашка — перша фраза з emphasis (ціна/знижка), інакше без неї.
  const badge = emphasis[0];
  const lift = interpolate(frame, [0, props.durationInFrames], [0, -20 * unit]);

  return (
    <AbsoluteFill>
      <Backdrop variant="shapes" animate />
      <SafeArea style={{ justifyContent: "center", gap: 36 * unit, transform: `translateY(${lift}px)` }}>
        {badge ? <Pill text={badge} startFrame={4} variant="accent" size="l" /> : null}
        <Headline text={headline} emphasis={emphasis} preset="rise" startFrame={10} size="l" color={color} />
        {sub ? <Body text={sub} preset="fade" startFrame={26} color={color} /> : null}
      </SafeArea>
    </AbsoluteFill>
  );
}
