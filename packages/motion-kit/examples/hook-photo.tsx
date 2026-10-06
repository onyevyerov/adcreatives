/**
 * Еталон: hook з фото. Повільний наїзд на фото з фокусом, затемнення під текст,
 * заголовок з'являється по словах знизу safe-зони, підзаголовок — після нього.
 */
import type { SceneProps } from "@adc/motion-kit";
import { Backdrop, Body, BrandImage, Headline, SafeArea, useFormat } from "@adc/motion-kit";
import { AbsoluteFill } from "remotion";

export default function Scene(props: SceneProps) {
  const { unit, isLandscape } = useFormat();
  const { headline, sub, emphasis } = props.scene.text;
  const assetId = props.scene.assetIds[0];
  const align = isLandscape ? "left" : "center";

  return (
    <AbsoluteFill>
      {assetId ? (
        <BrandImage
          assetId={assetId}
          kenBurns={{ from: 1, to: 1.15, direction: "in" }}
          overlay={{ color: "#000000", opacity: 0.5 }}
        />
      ) : (
        <Backdrop variant="gradient" animate />
      )}
      <SafeArea style={{ justifyContent: "flex-end", gap: 24 * unit }}>
        <Headline
          text={headline}
          emphasis={emphasis}
          preset="rise"
          startFrame={8}
          size={isLandscape ? "l" : "xl"}
          color="#FFFFFF"
          align={align}
        />
        {sub ? <Body text={sub} preset="fade" startFrame={24} color="#FFFFFF" align={align} /> : null}
      </SafeArea>
    </AbsoluteFill>
  );
}
