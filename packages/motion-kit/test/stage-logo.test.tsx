import { fixtureBrandKit, fixtureStoryboard } from "@adc/shared/fixtures";
import type { BrandKit } from "@adc/shared/schemas/brandkit";
import { FORMAT_SIZE, FORMATS } from "@adc/shared/schemas/common";
import type { AssetRef } from "@adc/shared/types/video";
import { getLength } from "@remotion/paths";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * B4 паритету: живий фон `Backdrop variant="stage"`, семантична тема й моношрифт,
 * геометрія векторного лого (`useLogoGeometry`, `LogoPath`). Усе — чисті функції кадру.
 */

const clock = { frame: 0 };
const config = { width: 1080, height: 1920, fps: 30, durationInFrames: 150 };
const qaCalls: string[] = [];
vi.mock("remotion", async (importOriginal) => {
  const actual = await importOriginal<typeof import("remotion")>();
  return { ...actual, useCurrentFrame: () => clock.frame, useVideoConfig: () => config };
});
vi.mock("../src/qa.tsx", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/qa.tsx")>();
  return {
    ...actual,
    useQaCheck: (_ref: unknown, opts: { component: string }) => {
      qaCalls.push(opts.component);
    },
  };
});

const { AssetsProvider, ThemeProvider, buildTheme, MONO_FALLBACK_STACK, SEMANTIC_FALLBACK } = await import(
  "../src/theme.tsx"
);
const { MONO_FAMILY, monoChoice, monoStack } = await import("../src/fonts.ts");
const { Backdrop, STAGE_GRID, stageGlowCenters } = await import("../src/media/Backdrop.tsx");
const { loadLogoSvg, LogoPath, parseLogoSvg, useLogoGeometry, vectorLogoSrc } = await import(
  "../src/media/Logo.tsx"
);
const { mix, withAlpha } = await import("../src/color.ts");
const { BG_ATTR } = await import("../src/qa.tsx");
const { default: Typographic } = await import("../examples/typographic.tsx");

const palette = fixtureBrandKit.palette;
const LOGO_SVG = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 120">
  <!-- коментар <path d="M 0 0 L 9 9"/> -->
  <defs><linearGradient id="g"><stop offset="0"/></linearGradient><path id="hidden" d="M 0 0 L 50 50"/></defs>
  <rect width="320" height="120" fill="#fff"/>
  <g transform="translate(10 20)">
    <circle cx="40" cy="40" r="30" fill="url(#g)"/>
    <path d="M 100 10 L 160 10 L 160 70 Z" fill-rule="evenodd"/>
  </g>
  <polyline points="200,10 240,70 280,10" fill="none" stroke="#000" stroke-width="6"/>
</svg>`;

const svgAssets: Record<string, AssetRef> = {
  a02: { src: "assets/a02.svg", width: 320, height: 120, focal: { x: 0.5, y: 0.5 } },
};
const rasterBrand: BrandKit = { ...fixtureBrandKit, logo: { ...fixtureBrandKit.logo, type: "image" } };

function render(
  node: ReactNode,
  frame: number,
  brand: BrandKit = fixtureBrandKit,
  assets: Record<string, AssetRef> = svgAssets,
): string {
  clock.frame = frame;
  return renderToStaticMarkup(
    <ThemeProvider brand={brand}>
      <AssetsProvider assets={assets}>{node}</AssetsProvider>
    </ThemeProvider>,
  );
}

const fetchSvg = (body: string, ok = true) =>
  vi.fn(async () => new Response(body, { status: ok ? 200 : 404 }));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Backdrop variant=stage", () => {
  it("детермінований: той самий кадр — та сама розмітка; інший кадр — свічення й зерно рухаються", () => {
    const a = render(<Backdrop variant="stage" />, 40);
    expect(a).toBe(render(<Backdrop variant="stage" />, 40));
    expect(a).not.toBe(render(<Backdrop variant="stage" />, 41));
  });

  it("зерно feTurbulence з seed = frame % 9", () => {
    expect(render(<Backdrop variant="stage" />, 40)).toContain('seed="4"');
    expect(render(<Backdrop variant="stage" />, 49)).toContain('seed="4"');
    expect(render(<Backdrop variant="stage" />, 9)).toContain('seed="0"');
    expect(render(<Backdrop variant="stage" />, 0)).toContain("feTurbulence");
  });

  it("сітка 96 px з маскою до центру, дрейф 0.4 px/кадр; grid={false} прибирає її", () => {
    expect(STAGE_GRID).toBe(96);
    const f0 = render(<Backdrop variant="stage" />, 0);
    expect(f0).toContain('data-adc-stage="grid"');
    expect(f0).toContain("background-size:96px 96px");
    expect(f0).toMatch(/mask-image:radial-gradient\(ellipse/);
    // 1080 × 1920: центр 540 % 96 = 60, 960 % 96 = 0; за 10 кадрів сітка піднялась на 4 px.
    expect(f0).toContain("background-position:60.00px 0.00px");
    expect(render(<Backdrop variant="stage" />, 10)).toContain("background-position:60.00px 92.00px");
    expect(render(<Backdrop variant="stage" grid={false} />, 0)).not.toContain("data-adc-stage");
  });

  it("для QA повідомляє базовий колір (дефолт background, або color)", () => {
    expect(render(<Backdrop variant="stage" />, 0)).toContain(`${BG_ATTR}="${palette.background}"`);
    expect(render(<Backdrop variant="stage" color={palette.primary} />, 0)).toContain(
      `${BG_ATTR}="${palette.primary}"`,
    );
  });

  it("свічення — дефолт primary і secondary, `glow` їх замінює", () => {
    const html = render(<Backdrop variant="stage" />, 0);
    expect(html).toContain(withAlpha(palette.primary, 0.35));
    expect(html).toContain(withAlpha(palette.secondary, 0.35));
    const own = render(<Backdrop variant="stage" glow={["#112233", "#445566"]} />, 0);
    expect(own).toContain(withAlpha("#112233", 0.35));
    expect(own).not.toContain(withAlpha(palette.primary, 0.35));
  });

  it("tint/tintAmount перефарбовують свічення, база лишається", () => {
    const danger = buildTheme(fixtureBrandKit).palette.danger;
    const full = render(<Backdrop variant="stage" tint={danger} />, 0);
    expect(full).toContain(withAlpha(danger, 0.35));
    expect(full).not.toContain(withAlpha(palette.primary, 0.35));
    expect(full).toContain(`${BG_ATTR}="${palette.background}"`);
    expect(render(<Backdrop variant="stage" tint={danger} tintAmount={0} />, 0)).toBe(
      render(<Backdrop variant="stage" />, 0),
    );
    const half = render(<Backdrop variant="stage" tint={danger} tintAmount={0.5} />, 0);
    expect(half).toContain(withAlpha(mix(palette.primary, danger, 0.5), 0.35));
    // Поза 0..1 — clamp.
    expect(render(<Backdrop variant="stage" tint={danger} tintAmount={3} />, 0)).toBe(full);
  });

  it("центри свічень: синуси від кадру, у межах кадру, не синхронні", () => {
    const [a0, b0] = stageGlowCenters(0, 1080, 1920);
    const [a1, b1] = stageGlowCenters(60, 1080, 1920);
    expect(stageGlowCenters(60, 1080, 1920)).toEqual(stageGlowCenters(60, 1080, 1920));
    expect(a1.x).not.toBe(a0.x);
    expect(b1.y).not.toBe(b0.y);
    for (let f = 0; f < 2000; f += 37) {
      for (const c of stageGlowCenters(f, 1080, 1920)) {
        expect(c.x).toBeGreaterThan(0);
        expect(c.x).toBeLessThan(1080);
        expect(c.y).toBeGreaterThan(0);
        expect(c.y).toBeLessThan(1920);
      }
    }
  });
});

describe("тема: семантичні кольори й моношрифт", () => {
  it("danger/warning/success завжди рядки; старий бренд-кіт — базові кольори", () => {
    const t = buildTheme(fixtureBrandKit);
    expect(SEMANTIC_FALLBACK).toEqual({ danger: "#EF4444", warning: "#F59E0B", success: "#22C55E" });
    for (const k of ["danger", "warning", "success"] as const) expect(typeof t.palette[k]).toBe("string");
    expect(t.palette.danger).toBe("#EF4444");
  });

  it("моношрифт: бренд-кіт або JetBrains Mono, з системним monospace у резерві", () => {
    expect(MONO_FAMILY).toBe("JetBrains Mono");
    expect(MONO_FALLBACK_STACK).toBe("ui-monospace, monospace");
    expect(monoChoice({ mono: null })).toEqual({ family: "JetBrains Mono", weights: [400, 700] });
    expect(monoChoice({ mono: { family: "IBM Plex Mono", weights: [500] } })).toEqual({
      family: "IBM Plex Mono",
      weights: [500],
    });
    expect(buildTheme(fixtureBrandKit).fonts.mono).toBe(`"JetBrains Mono", ui-monospace, monospace`);
    expect(monoStack('Space "Mono"')).toBe('"Space Mono", ui-monospace, monospace');
  });
});

describe("parseLogoSvg", () => {
  it("фігури → шляхи з transform груп; defs, коментарі й фон-плашка пропускаються", () => {
    const svg = parseLogoSvg(LOGO_SVG);
    expect(svg?.viewBox).toBe("0 0 320 120");
    expect(svg?.shapes).toHaveLength(3);
    const [circle, tri, line] = svg?.shapes ?? [];
    // Коло r=30 у (40,40) + translate(10,20): довжина 2πr, найлівіша точка x = 20.
    expect(getLength(circle?.d ?? "")).toBeCloseTo(2 * Math.PI * 30, 0);
    expect(circle?.d.startsWith("M 20 60")).toBe(true);
    expect(circle?.filled).toBe(true);
    expect(tri?.d).toContain("110 30");
    expect(tri?.fillRule).toBe("evenodd");
    expect(line).toMatchObject({ filled: false, strokeWidth: 6 });
    expect(line?.d).toBe("M 200 10 L 240 70 L 280 10");
  });

  it("rect, ellipse, line, polygon; viewBox з width/height; scale множить товщину контуру", () => {
    const svg = parseLogoSvg(`<svg width="100px" height="50">
      <rect x="10" y="10" width="20" height="10" rx="2"/>
      <ellipse cx="50" cy="25" rx="10" ry="5"/>
      <g transform="scale(2)"><line x1="0" y1="0" x2="10" y2="0" stroke="red"/></g>
      <polygon points="60 10 70 10 65 20"/>
    </svg>`);
    expect(svg?.viewBox).toBe("0 0 100 50");
    expect(svg?.shapes).toHaveLength(4);
    expect(svg?.shapes[0]?.d).toContain("A 2 2 0 0 1");
    expect(getLength(svg?.shapes[2]?.d ?? "")).toBeCloseTo(20);
    expect(svg?.shapes[2]).toMatchObject({ filled: false, strokeWidth: 2 });
    expect(svg?.shapes[3]?.d).toBe("M 60 10 L 70 10 L 65 20 Z");
  });

  it("стилі класів (Illustrator) та inline style мають пріоритет над атрибутами; приховане — ні", () => {
    const svg = parseLogoSvg(`<svg viewBox="0 0 10 10">
      <style>.cls-1{fill:none;stroke:#000;stroke-width:2px}</style>
      <path class="cls-1" fill="#f00" d="M 1 1 L 9 9"/>
      <path style="fill:none" stroke="#000" d="M 1 9 L 9 1"/>
      <path display="none" d="M 0 0 L 5 5"/>
      <g opacity="0"><path d="M 0 5 L 5 0"/></g>
      <path fill="none" d="M 2 2 L 3 3"/>
    </svg>`);
    expect(svg?.shapes).toEqual([
      { d: "M 1 1 L 9 9", filled: false, fillRule: "nonzero", strokeWidth: 2 },
      { d: "M 1 9 L 9 1", filled: false, fillRule: "nonzero", strokeWidth: 1 },
    ]);
  });

  it("текст, растр, <use>, без розміру, без фігур — null", () => {
    expect(parseLogoSvg(`<svg viewBox="0 0 10 10"><text x="0" y="5">Зерно</text></svg>`)).toBeNull();
    expect(
      parseLogoSvg(`<svg viewBox="0 0 10 10"><image href="a.png" width="10" height="10"/></svg>`),
    ).toBeNull();
    expect(parseLogoSvg(`<svg viewBox="0 0 10 10"><use href="#a"/></svg>`)).toBeNull();
    expect(parseLogoSvg(`<svg><path d="M 0 0 L 1 1"/></svg>`)).toBeNull();
    expect(parseLogoSvg(`<svg viewBox="0 0 10 10"><g/></svg>`)).toBeNull();
    expect(parseLogoSvg("не svg")).toBeNull();
  });
});

function GeometryProbe() {
  return <i>{JSON.stringify(useLogoGeometry())}</i>;
}
const geometryIn = (html: string) => JSON.parse(html.replace(/<\/?i>/g, "").replace(/&quot;/g, '"'));

describe("useLogoGeometry і LogoPath", () => {
  it("векторне лого: читає SVG з асетів (тип svg) і повертає viewBox і d", async () => {
    const fetchMock = fetchSvg(LOGO_SVG);
    vi.stubGlobal("fetch", fetchMock);
    expect(vectorLogoSrc(fixtureBrandKit, svgAssets)).toBe("assets/a02.svg");
    const loaded = await loadLogoSvg("assets/a02.svg");
    // Повторне читання — з кешу, без другого запиту.
    await loadLogoSvg("assets/a02.svg");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const geometry = geometryIn(render(<GeometryProbe />, 0));
    expect(geometry).toEqual({ viewBox: "0 0 320 120", paths: loaded?.shapes.map((s) => s.d) });
  });

  it("растрове, текстове лого чи асет не .svg — null", () => {
    expect(vectorLogoSrc(rasterBrand, svgAssets)).toBeNull();
    expect(
      vectorLogoSrc(
        { ...fixtureBrandKit, logo: { ...fixtureBrandKit.logo, assetId: null, type: "text" } },
        {},
      ),
    ).toBeNull();
    expect(
      vectorLogoSrc(fixtureBrandKit, { a02: { ...(svgAssets.a02 as AssetRef), src: "assets/a02.png" } }),
    ).toBeNull();
    expect(render(<GeometryProbe />, 0, rasterBrand)).toBe("<i>null</i>");
    expect(render(<LogoPath size={120} />, 0, rasterBrand)).toBe("");
  });

  it("файл не прочитано — null з попередженням, рендер не падає", async () => {
    vi.stubGlobal("fetch", fetchSvg("", false));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await loadLogoSvg("assets/missing.svg")).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("LogoPath: draw 0..1 через strokeDasharray, заливка наприкінці, розмір з viewBox", async () => {
    vi.stubGlobal("fetch", fetchSvg(LOGO_SVG));
    await loadLogoSvg("assets/a02.svg");
    qaCalls.length = 0;
    const at0 = render(<LogoPath size={120} draw={0} />, 0);
    expect(at0).toContain("opacity:0");
    const half = render(<LogoPath size={120} draw={0.5} stroke="#123456" />, 0);
    expect(half).toBe(render(<LogoPath size={120} draw={0.5} stroke="#123456" />, 0));
    expect(half).toContain('width="320" height="120" viewBox="0 0 320 120"');
    expect(half.match(/<path /g)).toHaveLength(3);
    expect(half).toContain("stroke-dasharray");
    expect(half).toContain('stroke="#123456"');
    expect(half).toContain('fill-opacity="0"');
    const full = render(<LogoPath size={60} draw={1} stroke="#123456" />, 0);
    expect(full).toContain("width:160px;height:60px");
    expect(full).toContain('fill="#123456" fill-opacity="1"');
    expect(full).toContain('fill-rule="evenodd"');
    // Контурна фігура (polyline) зберігає власну товщину й не заливається.
    expect(full).toContain('fill="none"');
    expect(full).toContain('stroke-width="6"');
    expect(qaCalls).toContain("LogoPath");
  });
});

describe("examples/typographic.tsx: stage і LogoPath", () => {
  it.each(FORMATS)(
    "%s: живий фон, лого малюється контуром (векторне) або <Logo> (растрове)",
    async (format) => {
      vi.stubGlobal("fetch", fetchSvg(LOGO_SVG));
      await loadLogoSvg("assets/a02.svg");
      Object.assign(config, FORMAT_SIZE[format]);
      const scene = fixtureStoryboard.scenes[0];
      if (!scene) throw new Error("немає сцени");
      const node = (
        <Typographic scene={scene} brand={fixtureBrandKit} assets={svgAssets} durationInFrames={120} />
      );
      for (const frame of [0, 40, 110]) {
        const html = render(node, frame);
        expect(html).toBe(render(node, frame));
        expect(html).toContain('data-adc-stage="grid"');
        expect(html).toContain("stroke-dasharray");
      }
      // Не векторне лого (тут без асета, тож `<Logo>` малює textFallback; `<Img>` у тестах без композиції не рендериться).
      const fallback = render(
        <Typographic scene={scene} brand={rasterBrand} assets={{}} durationInFrames={120} />,
        110,
        rasterBrand,
        {},
      );
      expect(fallback).not.toContain("stroke-dasharray");
      expect(fallback).toContain(fixtureBrandKit.logo.textFallback);
      Object.assign(config, FORMAT_SIZE.vertical);
    },
  );
});
