import { type CSSProperties, useRef } from "react";
import { spring, useCurrentFrame, useVideoConfig } from "remotion";
import { readableOn } from "../color.ts";
import { useFormat } from "../format.tsx";
import { springs } from "../motion.ts";
import { BG_ATTR, useQaCheck } from "../qa.tsx";
import { headingWeight, useTheme } from "../theme.tsx";
import { type TextAlign, TextBlock, type TextPreset } from "./TextBlock.tsx";

export type { TextAlign, TextPreset };

/** Підбирає розмір шрифту, щоб текст вліз у maxLines рядків ширини box; не менше minFontSize. */
export function FitText(props: {
  text: string;
  /** Дефолт 2. */
  maxLines?: number;
  maxFontSize: number;
  /** Якщо не вліз і на мінімумі — QA-лог text_min_size / text_overflow. */
  minFontSize: number;
  /** px, дефолт — ширина safe-зони. */
  width?: number;
  font?: "heading" | "body";
  weight?: number;
  color?: string;
  align?: TextAlign;
  style?: CSSProperties;
}) {
  return <TextBlock {...props} maxLines={props.maxLines ?? 2} component="FitText" />;
}

/** Кінетичний текст: поява по словах або рядках. */
export function KineticText(props: {
  text: string;
  preset: TextPreset;
  /** Дефолт "word". */
  by?: "word" | "line";
  startFrame?: number;
  /** Кадрів між елементами; дефолт залежить від theme.motion. */
  stagger?: number;
  /** Слова з акцентом (колір accent). */
  emphasis?: string[];
  /** Дефолт 3. */
  maxLines?: number;
  maxFontSize: number;
  minFontSize: number;
  width?: number;
  font?: "heading" | "body";
  color?: string;
  align?: TextAlign;
  style?: CSSProperties;
}) {
  return <TextBlock {...props} maxLines={props.maxLines ?? 3} component="KineticText" />;
}

const HEADLINE_SIZE = { m: [76, 44], l: [100, 52], xl: [128, 60] } as const;
const BODY_SIZE = { s: [34, 26], m: [42, 30], l: [54, 34] } as const;

/** Заголовок сцени: FitText/KineticText з токенами теми (font heading, вага max). */
export function Headline(props: {
  text: string;
  emphasis?: string[];
  /** Без preset — статичний. */
  preset?: TextPreset;
  startFrame?: number;
  /** Дефолт 3. */
  maxLines?: number;
  /** Дефолт "l". */
  size?: "m" | "l" | "xl";
  color?: string;
  align?: TextAlign;
  width?: number;
  style?: CSSProperties;
}) {
  const { unit } = useFormat();
  const [max, min] = HEADLINE_SIZE[props.size ?? "l"];
  return (
    <TextBlock
      {...props}
      font="heading"
      maxLines={props.maxLines ?? 3}
      maxFontSize={Math.round(max * unit)}
      minFontSize={Math.round(min * unit)}
      component="Headline"
    />
  );
}

/** Підзаголовок / основний текст (font body). */
export function Body(props: {
  text: string;
  preset?: TextPreset;
  startFrame?: number;
  /** Дефолт 3. */
  maxLines?: number;
  /** Дефолт "m". */
  size?: "s" | "m" | "l";
  color?: string;
  align?: TextAlign;
  width?: number;
  emphasis?: string[];
  style?: CSSProperties;
}) {
  const { unit } = useFormat();
  const [max, min] = BODY_SIZE[props.size ?? "m"];
  return (
    <TextBlock
      {...props}
      font="body"
      by={props.preset ? "line" : "word"}
      maxLines={props.maxLines ?? 3}
      maxFontSize={Math.round(max * unit)}
      minFontSize={Math.round(min * unit)}
      component="Body"
    />
  );
}

const PILL_SIZE = { s: 30, m: 42, l: 60 } as const;

function useEntrance(startFrame: number | undefined, config = springs.snappy): number {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  if (startFrame === undefined) return 1;
  return spring({ frame: frame - startFrame, fps, config });
}

/** Плашка: ціна, знижка, бейдж. */
export function Pill(props: {
  text: string;
  startFrame?: number;
  variant?: "accent" | "primary" | "surface";
  size?: "s" | "m" | "l";
  style?: CSSProperties;
}) {
  const theme = useTheme();
  const { unit } = useFormat();
  const ref = useRef<HTMLDivElement>(null);
  const bg = theme.palette[props.variant ?? "accent"];
  const fg = readableOn(bg, theme.palette);
  const fontSize = Math.round(PILL_SIZE[props.size ?? "m"] * unit);
  const p = useEntrance(props.startFrame);
  useQaCheck(ref, { component: "Pill", safeArea: true, contrast: true });
  return (
    <div
      {...{ [BG_ATTR]: bg }}
      ref={ref}
      style={{
        display: "inline-flex",
        alignItems: "center",
        alignSelf: "center",
        padding: "0.32em 0.85em",
        borderRadius: theme.radius.pill === 0 ? 0 : Math.max(theme.radius.md * unit, fontSize),
        background: bg,
        color: fg,
        fontFamily: theme.fonts.heading,
        fontWeight: headingWeight(theme),
        fontSize,
        lineHeight: 1.1,
        whiteSpace: "nowrap",
        opacity: Math.min(1, p * 1.5),
        transform: `scale(${(0.5 + 0.5 * p).toFixed(4)})`,
        ...props.style,
      }}
    >
      {props.text}
    </div>
  );
}

const CTA_SIZE = { m: 44, l: 56 } as const;

/** Кнопка CTA з м'якою пульсацією. */
export function CTAButton(props: {
  text: string;
  startFrame?: number;
  variant?: "accent" | "primary";
  size?: "m" | "l";
  style?: CSSProperties;
}) {
  const theme = useTheme();
  const { unit } = useFormat();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const ref = useRef<HTMLDivElement>(null);
  const bg = theme.palette[props.variant ?? "accent"];
  const fg = readableOn(bg, theme.palette);
  const fontSize = Math.round(CTA_SIZE[props.size ?? "l"] * unit);
  const start = props.startFrame ?? 0;
  const p = useEntrance(start);
  // Пульсація після появи: 0 → +4% → 0, період ~1.2 с.
  const t = Math.max(0, frame - start - 18) / fps;
  const pulse = 0.04 * ((1 - Math.cos(t * Math.PI * 2 * 0.8)) / 2);
  useQaCheck(ref, { component: "CTAButton", safeArea: true, contrast: true });
  return (
    <div
      {...{ [BG_ATTR]: bg }}
      ref={ref}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        alignSelf: "center",
        padding: "0.6em 1.4em",
        borderRadius: theme.radius.pill === 0 ? 0 : 999,
        background: bg,
        color: fg,
        fontFamily: theme.fonts.heading,
        fontWeight: headingWeight(theme),
        fontSize,
        lineHeight: 1.1,
        whiteSpace: "nowrap",
        boxShadow: `0 ${Math.round(12 * unit)}px ${Math.round(36 * unit)}px rgba(0,0,0,0.22)`,
        opacity: Math.min(1, p * 1.5),
        transform: `scale(${((0.6 + 0.4 * p) * (1 + pulse)).toFixed(4)})`,
        ...props.style,
      }}
    >
      {props.text}
    </div>
  );
}
