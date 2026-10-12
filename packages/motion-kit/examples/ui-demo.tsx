/**
 * Еталон «продукт у роботі»: у поле вводиться адреса, кнопка натискається, поле їде вгору,
 * скан-лінія проходить сторінкою, у картці з'являються пункти перевірки й ставляться галочки,
 * під карткою біжить лічильник результату, а коли він сів — світиться.
 * Усі тексти — лише з `props.scene.items` (за `role`), усі моменти — з `props.scene.events`
 * через `eventFrame`: звук стоїть саме на цих кадрах, тож рух іде за ними, а не за власними числами.
 *
 * Сцена storyboard, яку очікує еталон:
 * - items: `label` — що вводиться в поле (адреса, запит); `button` — напис кнопки (необов'язково);
 *   `heading` — заголовок картки (необов'язково); `item` — пункти перевірки; `number` — результат
 *   з числом («~50 перевірок»); `caption` — підпис під ним (необов'язково);
 * - events: `type` — починається друк, `press` — натиск кнопки, `scan` — пішла скан-лінія,
 *   `checks` — перша галочка, `count` — пішов лічильник.
 * Vertical: картка над лічильником; square і landscape — у два стовпці під полем.
 */
import type { SceneProps } from "@adc/motion-kit";
import {
  Backdrop,
  Body,
  Checklist,
  CountUp,
  easings,
  eventFrame,
  Glow,
  InputField,
  progress,
  readableOn,
  SafeArea,
  ScanLine,
  UICard,
  useFormat,
  useTheme,
} from "@adc/motion-kit";
import { AbsoluteFill, useCurrentFrame } from "remotion";

export default function Scene(props: SceneProps) {
  const theme = useTheme();
  const { unit, safe, isVertical } = useFormat();
  const frame = useCurrentFrame();
  const { scene } = props;
  const d = props.durationInFrames;

  // Тексти за роллю; у полі — щонайменше заголовок сцени, якщо режисер не дав окремого рядка.
  const textOf = (role: string) => scene.items.find((i) => i.role === role)?.text ?? null;
  const typed = textOf("label") ?? scene.text.headline;
  const button = textOf("button");
  const heading = textOf("heading");
  const result = textOf("number");
  const caption = textOf("caption");
  const checks = scene.items.filter((i) => i.role === "item").map((i) => i.text);

  // Моменти сцени — кадри подій storyboard.
  const typeAt = eventFrame(scene, "type");
  const pressAt = eventFrame(scene, "press");
  const scanAt = eventFrame(scene, "scan");
  const checksAt = eventFrame(scene, "checks");
  const countAt = eventFrame(scene, "count");

  // Друк має закінчитись за 6 кадрів до натиску: швидкість — з відстані між подіями (1–3 кадри на символ).
  const framesPerChar = Math.max(
    1,
    Math.min(3, Math.floor((pressAt - 6 - typeAt) / Math.max(1, typed.length - 1))),
  );
  // Поле — окремий шар: стоїть у центрі safe-зони, після натиску їде на її верх і звільняє місце
  // сторінці, яку скануємо. Решта сцени центрується в тому, що лишилось під полем.
  const fieldHeight = Math.round(44 * unit * 2.3);
  const gap = Math.round(40 * unit);
  const contentWidth = isVertical ? safe.width : Math.min(safe.width, Math.round(1500 * unit));
  const lift = progress(frame, pressAt + 4, 14, easings.inOut);
  const fieldTop = safe.y + ((safe.height - fieldHeight) / 2) * (1 - lift);

  // Скан іде від поля до низу safe-зони; рядки списку з'являються, поки лінія йде сторінкою.
  const scanFrom = safe.y + fieldHeight + gap / 2;
  const scanTo = safe.y + safe.height;
  const scanFrames = Math.max(12, checksAt - scanAt);
  const rowStagger = Math.max(2, Math.round(scanFrames / (checks.length + 1)));
  const countFrames = Math.max(12, Math.min(36, d - countAt - 30));

  const cardWidth = isVertical ? contentWidth : Math.round(contentWidth * 0.56);
  const countWidth = isVertical ? contentWidth : contentWidth - cardWidth - gap;
  const pad = Math.round(36 * unit);
  const onCard = readableOn(theme.palette.surface, theme.palette);
  const onBackground = readableOn(theme.palette.background, theme.palette);

  return (
    <AbsoluteFill>
      <Backdrop variant="noise" />
      <SafeArea
        style={{
          paddingTop: fieldHeight + gap,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: isVertical ? "column" : "row",
            alignItems: "center",
            gap,
            width: contentWidth,
          }}
        >
          {checks.length > 0 ? (
            <UICard
              startFrame={scanAt}
              width={cardWidth}
              title={heading ?? undefined}
              icon="list-checks"
              accent="accent"
            >
              <Checklist
                items={checks}
                startFrame={scanAt + rowStagger}
                stagger={rowStagger}
                checkFrom={checksAt}
                width={cardWidth - 2 * pad - Math.round(8 * unit)}
                fontSize={Math.round((isVertical ? 48 : 40) * unit)}
                color={onCard}
              />
            </UICard>
          ) : null}
          {result ? (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: Math.round(8 * unit),
                width: countWidth,
              }}
            >
              <Glow pulse strength={0.6} startFrame={countAt + countFrames}>
                <CountUp
                  text={result}
                  startFrame={countAt}
                  durationFrames={countFrames}
                  width={countWidth}
                  maxFontSize={Math.round((isVertical ? 170 : 120) * unit)}
                  color={onBackground}
                  style={{ opacity: progress(frame, countAt - 4, 6) }}
                />
              </Glow>
              {caption ? (
                <Body
                  text={caption}
                  preset="fade"
                  startFrame={countAt + 6}
                  width={countWidth}
                  color={onBackground}
                />
              ) : null}
            </div>
          ) : null}
        </div>
      </SafeArea>
      <div style={{ position: "absolute", left: safe.x + (safe.width - contentWidth) / 2, top: fieldTop }}>
        <InputField
          text={typed}
          typeStart={typeAt}
          framesPerChar={framesPerChar}
          buttonLabel={button ?? undefined}
          pressAt={pressAt}
          width={contentWidth}
          icon="globe"
        />
      </div>
      <ScanLine startFrame={scanAt} durationFrames={scanFrames} from={scanFrom} to={scanTo} />
    </AbsoluteFill>
  );
}
