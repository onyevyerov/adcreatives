import { type CSSProperties, type ReactNode, useMemo, useRef } from "react";
import { spring, useCurrentFrame, useVideoConfig } from "remotion";
import { readableOn } from "../color.ts";
import { useFormat } from "../format.tsx";
import { defaultStagger, easings, progress, springFor } from "../motion.ts";
import { useQaCheck } from "../qa.tsx";
import { bodyWeight, headingWeight, type Theme, useTheme } from "../theme.tsx";
import { fitText, markEmphasis } from "./layout.ts";
import { createMeasurer } from "./measure.ts";

export type TextPreset = "rise" | "fade" | "scale" | "highlight" | "typewriter";
export type TextAlign = "left" | "center" | "right";

export interface TextBlockProps {
  text: string;
  maxLines: number;
  maxFontSize: number;
  minFontSize: number;
  width?: number;
  font?: "heading" | "body";
  weight?: number;
  color?: string;
  align?: TextAlign;
  style?: CSSProperties;
  emphasis?: string[];
  /** Без preset — статичний текст. */
  preset?: TextPreset;
  by?: "word" | "line";
  startFrame?: number;
  stagger?: number;
  /** Назва компонента для QA-логів. */
  component: string;
}

const LINE_HEIGHT = { heading: 1.1, body: 1.3 } as const;

/** Символів за секунду для typewriter за характером руху. */
const TYPE_SPEED: Record<Theme["motion"], number> = { energetic: 30, playful: 26, calm: 18, premium: 15 };

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/** Внутрішній блок тексту: підбір розміру, перенос, emphasis, кінетика, QA. */
export function TextBlock(props: TextBlockProps) {
  const theme = useTheme();
  const { safe } = useFormat();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const ref = useRef<HTMLDivElement>(null);

  const font = props.font ?? "heading";
  const family = font === "heading" ? theme.fonts.heading : theme.fonts.body;
  const weight = props.weight ?? (font === "heading" ? headingWeight(theme) : bodyWeight(theme));
  const width = props.width ?? safe.width;
  const color = props.color ?? theme.palette.textOnLight;
  const align = props.align ?? "center";
  const start = props.startFrame ?? 0;
  const by = props.by ?? "word";
  const stagger = props.stagger ?? defaultStagger(theme.motion, by);

  const fit = useMemo(
    () =>
      fitText({
        text: props.text,
        maxLines: props.maxLines,
        width,
        maxFontSize: props.maxFontSize,
        minFontSize: props.minFontSize,
        measure: createMeasurer(family, weight),
      }),
    [props.text, props.maxLines, width, props.maxFontSize, props.minFontSize, family, weight],
  );
  const words = useMemo(() => fit.lines.flat(), [fit]);
  const emphasized = useMemo(() => markEmphasis(words, props.emphasis), [words, props.emphasis]);

  useQaCheck(ref, {
    component: props.component,
    safeArea: true,
    contrast: true,
    extra: (el, report) => {
      const short = props.text.length > 40 ? `${props.text.slice(0, 40)}…` : props.text;
      if (fit.overflow) {
        report(
          "text_overflow",
          `«${short}» не влазить у ${props.maxLines} рядк. ширини ${Math.round(width)} px навіть на мінімумі ${fit.fontSize} px`,
          fit.fontSize,
        );
      } else if (el.scrollWidth > el.clientWidth + 2) {
        report(
          "text_overflow",
          `«${short}» ширший за блок: ${el.scrollWidth} > ${el.clientWidth} px`,
          fit.fontSize,
        );
      } else if (fit.hitMin) {
        report("text_min_size", `«${short}» зменшено до мінімуму ${fit.fontSize} px`, fit.fontSize);
      }
    },
  });

  const springConfig = springFor(theme.motion);
  const totalChars = props.text.length;
  const typedChars =
    props.preset === "typewriter"
      ? Math.floor((Math.max(0, frame - start) * TYPE_SPEED[theme.motion]) / fps)
      : totalChars;

  let wordIndex = 0;
  let charIndex = 0;
  const lines: ReactNode[] = fit.lines.map((line, lineIdx) => {
    const children: ReactNode[] = [];
    line.forEach((word, posInLine) => {
      const wi = wordIndex++;
      const isEmph = emphasized[wi] === true;
      const element = by === "line" ? lineIdx : wi;
      const local = frame - start - element * stagger;
      const style: CSSProperties = { display: "inline-block", whiteSpace: "pre" };
      let content: ReactNode = word;

      switch (props.preset) {
        case "rise": {
          const p = spring({ frame: local, fps, config: springConfig });
          style.opacity = clamp01(local / 8);
          style.transform = `translateY(${((1 - p) * 0.6).toFixed(4)}em)`;
          break;
        }
        case "fade":
          style.opacity = progress(local, 0, 12, easings.out);
          break;
        case "scale": {
          const p = spring({ frame: local, fps, config: springConfig });
          style.opacity = clamp01(local / 6);
          style.transform = `scale(${(0.6 + 0.4 * p).toFixed(4)})`;
          break;
        }
        case "highlight":
          style.opacity = progress(local, 0, 8, easings.out);
          break;
        case "typewriter": {
          const visible = Math.max(0, Math.min(word.length, typedChars - charIndex));
          content = (
            <>
              {word.slice(0, visible)}
              <span style={{ opacity: 0 }}>{word.slice(visible)}</span>
            </>
          );
          break;
        }
        default:
          break;
      }
      charIndex += word.length + 1;

      if (isEmph && props.preset === "highlight") {
        const hp = progress(local, 6, 12, easings.out);
        style.position = "relative";
        style.isolation = "isolate";
        style.color = hp > 0.5 ? readableOn(theme.palette.accent, theme.palette) : undefined;
        content = (
          <>
            <span
              style={{
                position: "absolute",
                left: "-0.08em",
                right: "-0.08em",
                top: "0.08em",
                bottom: "0.02em",
                background: theme.palette.accent,
                borderRadius: "0.12em",
                transform: `scaleX(${hp.toFixed(4)})`,
                transformOrigin: "left center",
                zIndex: -1,
              }}
            />
            {content}
          </>
        );
      } else if (isEmph) {
        style.color = theme.palette.accent;
      }

      if (posInLine > 0) children.push(" ");
      children.push(
        // biome-ignore lint/suspicious/noArrayIndexKey: слова можуть повторюватись; позиція в розкладці — стабільний ключ
        <span key={`${lineIdx}-${posInLine}`} style={style}>
          {content}
        </span>,
      );
    });
    return (
      // biome-ignore lint/suspicious/noArrayIndexKey: рядки розкладки не переставляються між кадрами
      <div key={lineIdx} style={{ whiteSpace: "nowrap" }}>
        {children}
      </div>
    );
  });

  return (
    <div
      ref={ref}
      style={{
        width,
        fontFamily: family,
        fontWeight: weight,
        fontSize: fit.fontSize,
        lineHeight: LINE_HEIGHT[font],
        color,
        textAlign: align,
        ...(align === "center" ? { marginLeft: "auto", marginRight: "auto" } : {}),
        ...props.style,
      }}
    >
      {lines}
    </div>
  );
}
