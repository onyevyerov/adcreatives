/**
 * Хук з фото: повільний наїзд на фото з фокусом, затемнення під текст,
 * заголовок з'являється знизу safe-зони, підзаголовок — слідом за ним.
 * Старти виводяться з довжини сцени, вхідного переходу, кількості слів і темпу бренду.
 */
import type { SceneProps } from "@adc/motion-kit";
import {
  Backdrop,
  Body,
  BrandImage,
  defaultStagger,
  KineticText,
  mix,
  readableOn,
  SafeArea,
  useFormat,
  useTheme,
} from "@adc/motion-kit";
import { AbsoluteFill } from "remotion";

export default function Scene(props: SceneProps) {
  const theme = useTheme();
  const { unit, isLandscape, safe } = useFormat();
  const { headline, sub, emphasis } = props.scene.text;
  const assetId = props.scene.assetIds[0];
  const d = props.durationInFrames;

  // Перший біт — не раніше, ніж закінчиться вхідний перехід (у хука завжди 0).
  const start = props.scene.transitionFrames;
  // Усе, що треба прочитати, має стояти на місці приблизно до чверті сцени:
  // перевірки дивляться кадри на 50 % і 90 %.
  const readyBy = Math.round(d * 0.25);
  // Скільки кадрів елементу треба, щоб осісти після свого старту (preset rise, за довідкою motion-kit).
  const settle = theme.motion === "premium" ? 29 : theme.motion === "calm" ? 20 : 12;
  const words = headline.split(/\s+/).filter(Boolean).length;
  // Послівний вхід, якщо він встигає; інакше (коротка сцена, довгий заголовок) — по рядках.
  const wordStagger = defaultStagger(theme.motion, "word");
  const byWord = start + (words - 1) * wordStagger + settle <= readyBy;
  const by = byWord ? "word" : "line";
  const stagger = byWord ? wordStagger : defaultStagger(theme.motion, "line");
  // Підзаголовок стартує, коли починає заходити останній елемент заголовка
  // (кількість рядків відома лише після верстки, тому беремо maxLines).
  const maxLines = 3;
  const subStart = start + (byWord ? words - 1 : maxLines - 1) * stagger;

  // Landscape: текст у лівій колонці, а не рядком через увесь кадр.
  const align = isLandscape ? "left" : "center";
  const textWidth = isLandscape ? Math.round(safe.width * 0.55) : undefined;
  const maxFont = Math.round((isLandscape ? 100 : 128) * unit);
  const minFont = Math.round((isLandscape ? 52 : 60) * unit);

  // Білий дозволено лише на затемненому фото; без фото колір — від фактичного фону.
  const color = assetId
    ? "#FFFFFF"
    : readableOn(mix(theme.palette.primary, theme.palette.secondary, 0.5), theme.palette);

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
        <KineticText
          text={headline}
          emphasis={emphasis}
          preset="rise"
          by={by}
          stagger={stagger}
          startFrame={start}
          maxLines={maxLines}
          maxFontSize={maxFont}
          minFontSize={minFont}
          color={color}
          align={align}
          width={textWidth}
        />
        {sub ? (
          <Body
            text={sub}
            preset="fade"
            startFrame={subStart}
            color={color}
            align={align}
            width={textWidth}
          />
        ) : null}
      </SafeArea>
    </AbsoluteFill>
  );
}
