/**
 * Еталон «камера й курсор у моку»: картка інтерфейсу з полем вводу; курсор заходить з-за кадру,
 * наводиться на поле, клікає — і поле з того ж кадру друкує адресу; камера наїжджає на поле, коли
 * курсор уже прийшов. Курсор переходить на кнопку, наводиться, клікає — кнопка натискається на тому ж
 * кадрі; камера відходить, коли кнопка відпрацювала, і лише тоді в картці з'являється результат —
 * список перевірок із галочками.
 * Правила: у моку нічого не змінюється саме — кожну зміну стану робить `Cursor` (рух `path`, наведення
 * `hoverAt`, клік `clickAt`, реакція на тому ж кадрі); один рух за раз — камера не рухається, поки рухається
 * курсор, і два рухи камери не перекриваються (`Camera` перевіряє це сама).
 * Усі тексти — лише з `props.scene.items` (за `role`), усі моменти — з `props.scene.events` через `eventFrame`.
 *
 * Сцена storyboard, яку очікує еталон:
 * - items: `label` — що вводиться в поле; `button` — напис кнопки (необов'язково); `item` — пункти результату;
 * - events: `hover` — курсор прийшов на поле, `type` — клік у поле й початок друку, `press` — клік по кнопці,
 *   `checks` — перша галочка результату. Між `hover` і `press` — щонайменше ~30 кадрів (камера й курсор по черзі).
 */
import type { CameraKey, SceneProps } from "@adc/motion-kit";
import {
  Backdrop,
  Camera,
  Checklist,
  Cursor,
  eventFrame,
  InputField,
  readableOn,
  UICard,
  useFormat,
  useTheme,
} from "@adc/motion-kit";
import { AbsoluteFill } from "remotion";

/** Тривалість руху камери, кадри (дефолт `Camera`). */
const MOVE = 18;

export default function Scene(props: SceneProps) {
  const theme = useTheme();
  const { width, height, unit, safe } = useFormat();
  const { scene } = props;

  // Тексти за роллю; у полі — щонайменше заголовок сцени, якщо режисер не дав окремого рядка.
  const textOf = (role: string) => scene.items.find((i) => i.role === role)?.text ?? null;
  const typed = textOf("label") ?? scene.text.headline;
  const button = textOf("button");
  const checks = scene.items.filter((i) => i.role === "item").map((i) => i.text);

  // Моменти сцени — кадри подій storyboard.
  const hoverAt = eventFrame(scene, "hover");
  const typeAt = eventFrame(scene, "type");
  const pressAt = eventFrame(scene, "press");
  const checksAt = eventFrame(scene, "checks");

  // Друк закінчується за 12 кадрів до натиску: пауза, переїзд курсора на кнопку, наведення.
  const framesPerChar = Math.max(
    1,
    Math.min(3, Math.floor((pressAt - 12 - typeAt) / Math.max(1, typed.length - 1))),
  );
  const typedAt = typeAt + (typed.length - 1) * framesPerChar;

  // Геометрія картки (px кадру): поле вгорі, під ним місце для списку; картка — по центру safe-зони.
  const pad = Math.round(36 * unit);
  const cardWidth = Math.round(Math.min(safe.width * 0.82, 900 * unit));
  const fieldWidth = cardWidth - 2 * pad;
  const fieldHeight = Math.round(44 * unit * 2.3);
  const listFont = Math.round(44 * unit);
  const listHeight =
    checks.length * Math.round(listFont * 1.1) + Math.max(0, checks.length - 1) * Math.round(listFont * 0.55);
  const cardHeight = 2 * pad + fieldHeight + (checks.length > 0 ? Math.round(20 * unit) + listHeight : 0);
  const cardX = safe.x + (safe.width - cardWidth) / 2;
  const cardY = safe.y + (safe.height - cardHeight) / 2;
  const fieldX = cardX + pad;
  const fieldY = cardY + pad;

  // Курсор: з-під кадру — у поле (приходить на `hover`), після друку — на кнопку біля правого краю поля.
  const inField = { x: fieldX + Math.round(fieldWidth * 0.3), y: fieldY + Math.round(fieldHeight * 0.6) };
  const onButton = {
    x: fieldX + fieldWidth - Math.round(fieldHeight * 0.95),
    y: fieldY + Math.round(fieldHeight * 0.6),
  };
  const leaveAt = Math.max(typedAt + 3, hoverAt + MOVE);
  const arriveAt = Math.max(leaveAt + 6, pressAt - 6);

  // Камера: поле на всю ширину safe-зони (не більше ×1.5); наїзд — коли курсор прийшов, відхід — коли
  // кнопка відпрацювала (8 кадрів натиску). Список заходить, коли камера вже відійшла.
  const scale = Math.min(1.5, safe.width / fieldWidth);
  const full: CameraKey = { at: 0, x: 0, y: 0, width, height };
  const push: CameraKey = {
    at: hoverAt,
    x: fieldX + fieldWidth / 2 - width / scale / 2,
    y: fieldY + fieldHeight / 2 - height / scale / 2,
    width: width / scale,
    height: height / scale,
  };
  const pullAt = pressAt + 8;
  const listAt = pullAt + MOVE;
  const onCard = readableOn(theme.palette.surface, theme.palette);

  return (
    <AbsoluteFill>
      {/* Фон поза камерою: кадр закритий, навіть коли прямокутник камери виходить за край сцени. */}
      <Backdrop variant="noise" />
      <Camera keys={[full, push, { ...full, at: pullAt }]} duration={MOVE}>
        <div style={{ position: "absolute", left: cardX, top: cardY }}>
          <UICard startFrame={0} width={cardWidth}>
            <InputField
              text={typed}
              typeStart={typeAt}
              framesPerChar={framesPerChar}
              buttonLabel={button ?? undefined}
              pressAt={pressAt}
              width={fieldWidth}
              icon="globe"
            />
            {checks.length > 0 ? (
              <Checklist
                items={checks}
                startFrame={listAt}
                checkFrom={checksAt}
                width={fieldWidth}
                fontSize={listFont}
                color={onCard}
              />
            ) : null}
          </UICard>
        </div>
        <Cursor
          path={[
            {
              x: inField.x + Math.round(fieldWidth * 0.4),
              y: height + Math.round(60 * unit),
              frame: hoverAt - 20,
            },
            { ...inField, frame: hoverAt },
            { ...inField, frame: leaveAt },
            { ...onButton, frame: arriveAt },
          ]}
          hoverAt={[hoverAt, arriveAt]}
          clickAt={[typeAt, pressAt]}
        />
      </Camera>
    </AbsoluteFill>
  );
}
