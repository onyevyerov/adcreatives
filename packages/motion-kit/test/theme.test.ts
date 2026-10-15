import { fixtureBrandKit, fixtureStoryboard } from "@adc/shared/fixtures";
import type { BrandKit } from "@adc/shared/schemas/brandkit";
import { ScenePurpose } from "@adc/shared/schemas/storyboard";
import type { LocalFont } from "@adc/shared/types/video";
import { loadFont } from "@remotion/fonts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { staticFile } from "remotion";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  FONT_SUBSETS,
  type FontInfo,
  fontStack,
  loadPlannedFont,
  nearestWeight,
  planFont,
  pruneFontInfo,
} from "../src/fonts.ts";
import { musicVolumeAt } from "../src/host/audio.tsx";
import { firstAvailableAsset, TEMPLATE_VARIANTS, templateVariantFor } from "../src/host/TemplateScene.tsx";
import { defaultStagger, easings, progress, springFor, springs } from "../src/motion.ts";
import { parseQaLog } from "../src/qa.tsx";
import {
  bodyWeight,
  buildTheme,
  headingWeight,
  MONO_FALLBACK_STACK,
  SEMANTIC_FALLBACK,
  ThemeProvider,
} from "../src/theme.tsx";

// Локальні шрифти: `@remotion/fonts` у Node не працює (FontFace) — мокається; `delayRender` хоста рахується.
vi.mock("@remotion/fonts", () => ({ loadFont: vi.fn(async () => {}) }));
const delay = vi.hoisted(() => ({ labels: [] as string[] }));
vi.mock("remotion", async (importOriginal) => {
  const actual = await importOriginal<typeof import("remotion")>();
  return {
    ...actual,
    useDelayRender: () => ({
      delayRender: (label: string) => delay.labels.push(label),
      continueRender: () => {},
      cancelRender: () => {},
    }),
  };
});

const fakeInfo: FontInfo = {
  fontFamily: "Montserrat",
  importName: "Montserrat",
  version: "v1",
  url: "https://fonts.example/montserrat.css",
  unicodeRanges: { latin: "U+0000-00FF", cyrillic: "U+0400-045F", greek: "U+0370-03FF" },
  fonts: {
    normal: {
      "400": { latin: "l400", cyrillic: "c400", greek: "g400" },
      "600": { latin: "l600", cyrillic: "c600", greek: "g600" },
      "800": { latin: "l800", cyrillic: "c800", greek: "g800" },
    },
    italic: { "400": { latin: "il400" } },
  },
  subsets: ["cyrillic", "greek", "latin"],
};

describe("тема", () => {
  it("будує токени з бренд-кіта", () => {
    const t = buildTheme(fixtureBrandKit);
    expect(t.palette).toEqual({ ...fixtureBrandKit.palette, ...SEMANTIC_FALLBACK });
    expect(t.fonts.mono).toBe(`"JetBrains Mono", ${MONO_FALLBACK_STACK}`);
    expect(t.fonts.heading).toBe(fontStack("Montserrat"));
    expect(t.fonts.body.startsWith('"Inter"')).toBe(true);
    expect(t.radius.pill).toBe(999);
    expect(t.motion).toBe("calm");
    expect(t.density).toBe("balanced");
    expect(headingWeight(t)).toBe(800);
    expect(bodyWeight(t)).toBe(400);
  });

  it("семантичні кольори й моношрифт бренд-кіта мають пріоритет над запасними", () => {
    const t = buildTheme({
      ...fixtureBrandKit,
      palette: { ...fixtureBrandKit.palette, danger: "#D93636" },
      typography: {
        ...fixtureBrandKit.typography,
        mono: { family: "JetBrains Mono", weights: [400], origin: "substitute", files: [] },
      },
    });
    expect(t.palette.danger).toBe("#D93636");
    expect(t.palette.success).toBe(SEMANTIC_FALLBACK.success);
    expect(t.fonts.mono).toBe(`"JetBrains Mono", ${MONO_FALLBACK_STACK}`);
  });

  it("sharp-бренд без заокруглень", () => {
    const t = buildTheme({
      ...fixtureBrandKit,
      visualStyle: { ...fixtureBrandKit.visualStyle, shapes: "sharp" },
    });
    expect(t.radius).toEqual({ sm: 0, md: 0, lg: 0, pill: 0 });
  });
});

describe("шрифти", () => {
  it("найближча вага", () => {
    expect(nearestWeight(700, [400, 600, 800])).toBe(800);
    expect(nearestWeight(500, [400, 600])).toBe(600);
    expect(nearestWeight(300, [400, 600])).toBe(400);
  });

  it("план: лише наявні ваги і підмножини latin+cyrillic", () => {
    const plan = planFont("Montserrat", [700, 800], [fakeInfo]);
    expect(plan.weights).toEqual([800]);
    expect(plan.subsets).toEqual([...FONT_SUBSETS]);
    expect(planFont("Unknown", [400], [fakeInfo]).info).toBeNull();
  });

  it("pruneFontInfo лишає normal, потрібні ваги і підмножини", () => {
    const pruned = pruneFontInfo(fakeInfo, [400, 600]);
    expect(Object.keys(pruned.fonts)).toEqual(["normal"]);
    expect(pruned.fonts.normal).toEqual({
      "400": { latin: "l400", cyrillic: "c400" },
      "600": { latin: "l600", cyrillic: "c600" },
    });
    expect(Object.keys(pruned.unicodeRanges).sort()).toEqual(["cyrillic", "latin"]);
    expect(pruned.subsets.sort()).toEqual(["cyrillic", "latin"]);
  });
});

describe("локальні шрифти сайту", () => {
  const local: LocalFont[] = [
    { family: "Zerno Display", weight: 400, format: "woff2", src: "fonts/zerno-display-400.woff2" },
    { family: "Zerno Display", weight: 700, format: "woff2", src: "fonts/zerno-display-700.woff2" },
    { family: "Other", weight: 400, format: "truetype", src: "fonts/other-400.ttf" },
  ];

  beforeEach(() => {
    vi.mocked(loadFont).mockClear();
    delay.labels.length = 0;
  });

  it("план: сімейства немає в FontInfo, але є локально — найближчі ваги і їхні файли", () => {
    const plan = planFont("Zerno Display", [600, 800], [fakeInfo], local);
    expect(plan.info).toBeNull();
    expect(plan.weights).toEqual([700]);
    expect(plan.local).toEqual([local[1]]);
    // Google Fonts має пріоритет; невідоме сімейство — порожній план (резервний стек).
    expect(planFont("Montserrat", [400], [fakeInfo], local).local).toEqual([]);
    expect(planFont("Unknown", [400], [fakeInfo], local)).toMatchObject({ info: null, local: [] });
  });

  it("loadPlannedFont: loadFont з family, weight, url = staticFile(src) і format", async () => {
    const plan = planFont("Zerno Display", [400, 700], [], local);
    await loadPlannedFont(plan);
    expect(loadFont).toHaveBeenCalledTimes(2);
    expect(loadFont).toHaveBeenCalledWith({
      family: "Zerno Display",
      weight: "400",
      url: staticFile("fonts/zerno-display-400.woff2"),
      format: "woff2",
    });
    expect(loadFont).toHaveBeenCalledWith(
      expect.objectContaining({
        family: "Zerno Display",
        weight: "700",
        url: staticFile("fonts/zerno-display-700.woff2"),
      }),
    );
    expect(vi.mocked(loadFont).mock.calls[0]?.[0].url).toMatch(/fonts\/zerno-display-400\.woff2$/);
  });

  it("ThemeProvider з localFonts тримає delayRender, поки шрифти не готові; fontStack незмінний", () => {
    const brand: BrandKit = {
      ...fixtureBrandKit,
      typography: {
        ...fixtureBrandKit.typography,
        heading: { family: "Zerno Display", weights: [700], origin: "local", files: [] },
      },
    };
    type Props = Parameters<typeof ThemeProvider>[0];
    const render = (props: Omit<Props, "children">) =>
      renderToStaticMarkup(createElement(ThemeProvider, props as Props, createElement("i", null, "дитина")));
    const held = render({ brand, localFonts: local });
    expect(delay.labels).toEqual(["motion-kit: шрифти бренду"]);
    expect(held).not.toContain("дитина");

    delay.labels.length = 0;
    const free = render({ brand });
    expect(delay.labels).toEqual([]);
    expect(free).toContain("дитина");
    expect(buildTheme(brand).fonts.heading).toBe(fontStack("Zerno Display"));
  });
});

describe("TemplateScene: вибір шаблону", () => {
  it("кожна ціль сцени має детермінований шаблон", () => {
    for (const purpose of ScenePurpose.options) {
      expect(TEMPLATE_VARIANTS).toContain(templateVariantFor(purpose));
    }
    expect(templateVariantFor("hook")).toBe("hero");
    expect(templateVariantFor("offer")).toBe("text");
    expect(templateVariantFor("product")).toBe("image");
    expect(templateVariantFor("cta")).toBe("cta");
  });

  it("усі чотири шаблони досяжні", () => {
    const used = new Set(ScenePurpose.options.map(templateVariantFor));
    expect([...used].sort()).toEqual([...TEMPLATE_VARIANTS].sort());
  });

  it("перший доступний асет сцени", () => {
    const scene = fixtureStoryboard.scenes[0];
    if (!scene) throw new Error("немає сцени");
    const asset = { src: "a.jpg", width: 10, height: 10, focal: { x: 0.5, y: 0.5 } };
    expect(firstAvailableAsset({ scene, assets: { a01: asset } })).toBe("a01");
    expect(firstAvailableAsset({ scene, assets: {} })).toBeNull();
    expect(
      firstAvailableAsset({ scene: { ...scene, assetIds: ["zz", "a01"] }, assets: { a01: asset } }),
    ).toBe("a01");
  });
});

describe("рух і звук", () => {
  it("progress: clamp і easing", () => {
    expect(progress(0, 10, 20)).toBe(0);
    expect(progress(20, 10, 20)).toBeCloseTo(0.5);
    expect(progress(40, 10, 20)).toBe(1);
    expect(progress(20, 10, 20, easings.out)).toBeGreaterThan(0.5);
    expect(progress(5, 5, 0)).toBe(1);
  });

  it("пресети пружин і stagger за характером руху", () => {
    expect(springFor("energetic")).toBe(springs.snappy);
    expect(springFor("premium")).toBe(springs.premium);
    expect(springFor("calm")).toBe(springs.soft);
    expect(defaultStagger("energetic", "word")).toBeLessThan(defaultStagger("premium", "word"));
    expect(defaultStagger("calm", "line")).toBeGreaterThan(defaultStagger("calm", "word"));
  });

  it("музика: повна гучність до fade-out, нуль на останньому кадрі", () => {
    expect(musicVolumeAt(0, 450, 24, 0.8)).toBeCloseTo(0.8);
    expect(musicVolumeAt(426, 450, 24, 0.8)).toBeCloseTo(0.8);
    expect(musicVolumeAt(438, 450, 24, 0.8)).toBeCloseTo(0.4);
    expect(musicVolumeAt(450, 450, 24, 0.8)).toBe(0);
  });
});

describe("QA-лог", () => {
  it("розбирає рядок ADC_QA і ігнорує інші", () => {
    const entry = { kind: "text_overflow", component: "FitText", detail: "x", value: 12, frame: 75 } as const;
    expect(parseQaLog(`ADC_QA ${JSON.stringify(entry)}`)).toEqual(entry);
    expect(parseQaLog("hello")).toBeNull();
    expect(parseQaLog("ADC_QA {broken")).toBeNull();
  });
});
