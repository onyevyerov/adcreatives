import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureBrandKit, fixtureStoryboard } from "@adc/shared/fixtures";
import { FORMAT_SIZE, FORMATS } from "@adc/shared/schemas/common";
import type { Scene } from "@adc/shared/schemas/storyboard";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { IconName } from "../src/icons/names.ts";

/**
 * Нові прийоми (B2): числа з текстів, іконки, дані, інтерфейс, ефекти, фікс `highlight`
 * і еталон `ui-demo`. Кожен прийом — чиста функція кадру: той самий кадр двічі → та сама розмітка.
 */

const clock = { frame: 0 };
const config = { width: 1080, height: 1920, fps: 30, durationInFrames: 150 };
vi.mock("remotion", async (importOriginal) => {
  const actual = await importOriginal<typeof import("remotion")>();
  return { ...actual, useCurrentFrame: () => clock.frame, useVideoConfig: () => config };
});
vi.mock("../src/qa.tsx", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/qa.tsx")>();
  return { ...actual, useQaCheck: () => {} };
});

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { ThemeProvider } = await import("../src/theme.tsx");
const mk = await import("../src/index.ts");
const {
  Bars,
  Checkbox,
  Checklist,
  CountUp,
  Cursor,
  easings,
  Flash,
  Glow,
  Icon,
  InputField,
  Ring,
  ScanLine,
  Strike,
  UICard,
} = mk;
const { ICON_NAMES } = await import("../src/icons/names.ts");
const { ICON_PATHS } = await import("../src/icons/paths.ts");
const { findNumber, numberIn, odometer } = await import("../src/ui/number.ts");
const { Headline, KineticText } = await import("../src/text/components.tsx");
const { default: UiDemo } = await import("../examples/ui-demo.tsx");

function render(node: ReactNode, frame: number): string {
  clock.frame = frame;
  return renderToStaticMarkup(<ThemeProvider brand={fixtureBrandKit}>{node}</ThemeProvider>);
}

/** Видимий текст розмітки: без тегів, без символів у `opacity:0`. */
function visibleText(html: string): string {
  return html
    .replace(/<span style="opacity:0">[^<]*<\/span>/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&");
}
/** Увесь текст розмітки разом із прихованими символами. */
const allText = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&");

describe("numberIn / findNumber", () => {
  it("перше число рядка", () => {
    expect(numberIn("~50 перевірок")).toBe(50);
    expect(numberIn("від $300–2000")).toBe(300);
    expect(numberIn("1 200 грн")).toBe(1200);
    expect(numberIn("2 000 000 клієнтів")).toBe(2_000_000);
    expect(numberIn("1,200 users")).toBe(1200);
    expect(numberIn("рейтинг 4,9")).toBe(4.9);
    expect(numberIn("4.9★")).toBe(4.9);
    expect(numberIn("0.125")).toBe(0.125);
    expect(numberIn("-10% на каву")).toBe(10);
    expect(numberIn("24/7")).toBe(24);
    expect(numberIn("без цифр")).toBeNull();
  });

  it("межі й дробова частина", () => {
    expect(findNumber("від $300–2000")).toEqual({ value: 300, start: 5, end: 8, decimals: 0 });
    expect(findNumber("1 200 грн")).toMatchObject({ start: 0, end: 5 });
    expect(findNumber("4,9 з 5")).toMatchObject({ value: 4.9, decimals: 1 });
  });

  it("одометр: форма кінцевого числа, провідні розряди приховані", () => {
    const show = (f: string, v: number, d: number) =>
      odometer(f, v, d)
        .map((c) => (c.hidden ? "_" : c.ch))
        .join("");
    expect(show("1 200", 873, 0)).toBe("__873");
    expect(show("1 200", 0, 0)).toBe("____0");
    expect(show("1 200", 1200, 0)).toBe("1 200");
    expect(show("2 000 000", 12345, 0)).toBe("___12 345");
    expect(show("4,9", 2.4, 1)).toBe("2,4");
  });
});

describe("Icon", () => {
  const required =
    `check x alert-triangle alert-circle info shield-check lock search globe link mouse-pointer-2
    settings bell plus minus arrow-right arrow-up-right chevron-right refresh-cw download upload play file-text
    file-check clipboard-list list-checks bar-chart-3 pie-chart trending-up trending-down gauge target layers
    layout-grid clock timer calendar zap rocket dollar-sign percent tag credit-card wallet gift shopping-cart
    shopping-bag package truck users user message-circle mail phone star heart thumbs-up award sparkles map-pin
    building-2 home store coffee utensils car scissors dumbbell stethoscope graduation-cap camera smartphone
    monitor code bot`.split(/\s+/);

  it("≥ 70 іконок, обов'язковий список повний, у кожної є шляхи; ліцензія lucide поруч", () => {
    expect(ICON_NAMES.length).toBeGreaterThanOrEqual(70);
    expect(new Set(ICON_NAMES).size).toBe(ICON_NAMES.length);
    for (const name of required) expect(ICON_NAMES).toContain(name);
    for (const name of ICON_NAMES) {
      const paths = ICON_PATHS[name];
      expect(paths.length).toBeGreaterThan(0);
      for (const d of paths) expect(d).toMatch(/^[Mm][\d\s.,\-a-zA-Z]+$/);
    }
    const license = path.join(ROOT, "src", "icons", "LICENSE-lucide");
    expect(existsSync(license)).toBe(true);
    expect(readFileSync(license, "utf8")).toMatch(/ISC License/);
  });

  it("невідома назва — помилка типу", () => {
    // @ts-expect-error — такої іконки немає в IconName
    const bad: IconName = "not-an-icon";
    expect(ICON_NAMES).not.toContain(bad);
  });

  it("колір — роль палітри або CSS; draw промальовує штрих; 0 — невидима", () => {
    const html = render(<Icon name="check" size={48} />, 0);
    expect(html).toContain('d="M20 6 9 17l-5-5"');
    expect(html).toContain(`stroke="${fixtureBrandKit.palette.accent}"`);
    expect(html).not.toContain("stroke-dasharray");
    expect(render(<Icon name="check" size={48} color="primary" />, 0)).toContain(
      `stroke="${fixtureBrandKit.palette.primary}"`,
    );
    expect(render(<Icon name="check" size={48} color="#123456" />, 0)).toContain('stroke="#123456"');
    const half = render(<Icon name="search" size={48} draw={0.25} />, 0);
    expect(half).toContain('stroke-dashoffset="0.75"');
    expect(half).toContain('pathLength="1"');
    expect(render(<Icon name="search" size={48} draw={0} />, 0)).toContain("opacity:0");
  });
});

describe("детермінізм: кадр → та сама розмітка", () => {
  const nodes: Array<[string, ReactNode]> = [
    ["Icon", <Icon key="i" name="rocket" size={64} draw={0.5} />],
    ["CountUp", <CountUp key="c" text="~1 200 перевірок" startFrame={10} durationFrames={30} />],
    [
      "Ring",
      <Ring key="r" segments={[{ value: 3 }, { value: 2, color: "primary" }]} startFrame={5} size={300}>
        <b>5</b>
      </Ring>,
    ],
    ["Bars", <Bars key="b" values={[3, 7, 5]} startFrame={5} width={400} height={300} highlight={1} />],
    [
      "UICard",
      <UICard key="u" startFrame={5} title="Звіт" icon="file-text" accent="accent">
        <b>x</b>
      </UICard>,
    ],
    ["Checkbox", <Checkbox key="cb" checkedAt={20} size={48} />],
    ["Checklist", <Checklist key="cl" items={["SEO", "Швидкість", "Безпека"]} startFrame={5} width={700} />],
    [
      "InputField",
      <InputField
        key="in"
        text="webreportio.com"
        placeholder="Адреса сайту"
        typeStart={10}
        buttonLabel="Перевірити"
        pressAt={50}
        width={840}
        icon="globe"
      />,
    ],
    [
      "Cursor",
      <Cursor
        key="cu"
        path={[
          { x: 100, y: 100, frame: 0 },
          { x: 500, y: 800, frame: 30 },
        ]}
        clickAt={[32, 50]}
      />,
    ],
    [
      "Cursor з hoverAt",
      <Cursor
        key="ch"
        path={[
          { x: 100, y: 100, frame: 0 },
          { x: 500, y: 800, frame: 30 },
        ]}
        hoverAt={[30, 60]}
        clickAt={36}
      />,
    ],
    ["ScanLine", <ScanLine key="s" startFrame={10} durationFrames={30} from={200} to={1600} />],
    ["Flash", <Flash key="f" at={20} />],
    [
      "Glow",
      <Glow key="g" pulse startFrame={5}>
        <b>x</b>
      </Glow>,
    ],
    [
      "Strike",
      <Strike key="st" at={20} dim={0.5}>
        <b>$2000</b>
      </Strike>,
    ],
  ];

  it.each(nodes)("%s", (_name, node) => {
    for (const frame of [0, 12, 21, 33, 47, 90]) expect(render(node, frame)).toBe(render(node, frame));
  });
});

describe("Checkbox", () => {
  it("до checkedAt порожній, з checkedAt — заливка й галочка", () => {
    const node = <Checkbox checkedAt={20} size={48} />;
    for (const frame of [0, 10, 19]) expect(render(node, frame)).not.toContain("M20 6 9 17l-5-5");
    const after = render(node, 40);
    expect(after).toContain("M20 6 9 17l-5-5");
    expect(after).toContain(`background:${fixtureBrandKit.palette.accent}`);
    expect(after).not.toContain("stroke-dasharray");
  });

  it("Checklist: галочки по черзі з checkFrom з кроком checkStagger або точно за checkAt", () => {
    const ticks = (html: string) => html.split("M20 6 9 17l-5-5").length - 1;
    const node = (
      <Checklist items={["a", "b", "c"]} startFrame={0} checkFrom={30} checkStagger={10} width={600} />
    );
    expect(ticks(render(node, 29))).toBe(0);
    expect(ticks(render(node, 30))).toBe(1);
    expect(ticks(render(node, 45))).toBe(2);
    expect(ticks(render(node, 50))).toBe(3);
    const exact = <Checklist items={["a", "b"]} startFrame={0} checkAt={[40, 12]} width={600} />;
    expect(ticks(render(exact, 20))).toBe(1);
  });
});

describe("Cursor", () => {
  const path = [
    { x: 100, y: 100, frame: 0 },
    { x: 500, y: 800, frame: 30 },
  ];
  const scale = (html: string) => Number(/transform:scale\(([\d.]+)\)/.exec(html)?.[1]);

  it("hoverAt без clickAt — наведення: ×1.08 за 4 кадри (easings.out), тримається", () => {
    const node = <Cursor path={path} hoverAt={30} />;
    expect(scale(render(node, 29))).toBe(1);
    expect(scale(render(node, 31))).toBeCloseTo(1 + 0.08 * easings.out(0.25), 4);
    expect(scale(render(node, 34))).toBe(1.08);
    expect(scale(render(node, 120))).toBe(1.08);
  });

  it("клік після наведення: стискання 15 % за 6 кадрів, приріст наведення сходить без стрибка", () => {
    const node = <Cursor path={path} hoverAt={30} clickAt={40} />;
    expect(scale(render(node, 39))).toBe(1.08);
    expect(scale(render(node, 40))).toBe(1.08);
    // Середина кліку: стискання на піку, наведення наполовину зійшло.
    expect(scale(render(node, 43))).toBeCloseTo(1.04 * 0.85, 4);
    expect(scale(render(node, 46))).toBe(1);
    expect(scale(render(node, 90))).toBe(1);
  });

  it("лише clickAt — як і було: стискання 15 % на третьому кадрі кліку", () => {
    const node = <Cursor path={path} clickAt={40} />;
    expect(scale(render(node, 39))).toBe(1);
    expect(scale(render(node, 43))).toBe(0.85);
    expect(scale(render(node, 46))).toBe(1);
  });

  it("кілька наведень: кожне — до свого наступного кліку", () => {
    const node = <Cursor path={path} hoverAt={[10, 50]} clickAt={[20, 60]} />;
    expect(scale(render(node, 18))).toBe(1.08);
    expect(scale(render(node, 30))).toBe(1);
    expect(scale(render(node, 55))).toBe(1.08);
    expect(scale(render(node, 70))).toBe(1);
  });
});

describe("CountUp", () => {
  const text = "~1 200 перевірок";
  // Широкий блок — текст в один рядок, тож видимий текст розмітки читається підряд.
  const node = <CountUp text={text} startFrame={10} durationFrames={30} width={3000} />;

  it("на останньому кадрі й далі — text дослівно", () => {
    expect(visibleText(render(node, 40))).toBe(text);
    expect(visibleText(render(node, 120))).toBe(text);
  });

  it("до старту — 0, посередині — менше за кінцеве; розкладка тієї ж довжини", () => {
    // Прихований провідний розряд тримає місце; пробіл між «1» і «200» — проміжок між словами.
    expect(visibleText(render(node, 0)).replace(/\s/g, "")).toBe("~0перевірок");
    const mid = visibleText(render(node, 20));
    const value = Number(mid.replace(/\D/g, ""));
    expect(value).toBeGreaterThan(0);
    expect(value).toBeLessThan(1200);
    for (const frame of [0, 20, 40]) expect(allText(render(node, frame)).length).toBe(text.length);
  });

  it("текст без числа — статичний", () => {
    expect(visibleText(render(<CountUp text="Без числа" startFrame={0} durationFrames={10} />, 3))).toBe(
      "Без числа",
    );
  });
});

describe("InputField", () => {
  const node = (
    <InputField text="webreportio.com" placeholder="Адреса" typeStart={10} framesPerChar={2} width={840} />
  );
  const typed = (frame: number) => visibleText(render(node, frame)).replace("Адреса", "");

  it("до typeStart — placeholder, далі символ кожні framesPerChar кадрів, розкладка за повним текстом", () => {
    expect(render(node, 0)).toContain("Адреса");
    expect(typed(0)).toBe("");
    expect(typed(10)).toBe("w");
    expect(typed(14)).toBe("web");
    expect(typed(10 + 14 * 2)).toBe("webreportio.com");
    expect(render(node, 30)).not.toContain("Адреса");
    expect(allText(render(node, 14)).replace("Адреса", "")).toBe("webreportio.com");
  });
});

describe("Ring і Bars", () => {
  it("Ring: до старту сегментів немає, після — частки кола за total", () => {
    const node = <Ring segments={[{ value: 87 }]} total={100} startFrame={10} size={200} thickness={20} />;
    expect(render(node, 0)).not.toContain("stroke-dasharray");
    const c = 2 * Math.PI * 90;
    const dash = /stroke-dasharray="([\d.]+) /.exec(render(node, 60))?.[1];
    expect(Number(dash)).toBeCloseTo(0.87 * c, 2);
  });

  it("Bars: висоти пропорційні значенням після осідання, highlight — accent", () => {
    const html = render(<Bars values={[5, 10]} startFrame={0} width={200} height={300} highlight={1} />, 120);
    const heights = [...html.matchAll(/height:([\d.]+)px/g)].map((m) => Number(m[1]));
    expect(heights.slice(1)).toEqual([expect.closeTo(150, 0), expect.closeTo(300, 0)]);
    expect(html).toContain(`background:${fixtureBrandKit.palette.accent}`);
  });
});

describe("ефекти", () => {
  it("Flash: нічого до `at`, пік на `at`, згасає за durationFrames", () => {
    const node = <Flash at={20} durationFrames={10} strength={0.8} />;
    expect(render(node, 19)).toBe("");
    expect(render(node, 20)).toContain("opacity:0.8");
    expect(render(node, 30)).toBe("");
  });

  it("ScanLine: поза проходом нічого, посередині — між from і to", () => {
    const node = <ScanLine startFrame={10} durationFrames={20} from={100} to={1100} />;
    expect(render(node, 5)).toBe("");
    const top = Number(/top:([\d.]+)px;height:4px/.exec(render(node, 20))?.[1]);
    expect(top).toBeGreaterThan(100);
    expect(top).toBeLessThan(1100);
    expect(render(node, 60)).toBe("");
  });

  it("Strike: до `at` лінії немає, після — на всю ширину", () => {
    const node = (
      <Strike at={10}>
        <b>$2000</b>
      </Strike>
    );
    expect(render(node, 9)).not.toContain("scaleX");
    expect(render(node, 40)).toContain("scaleX(1.0000)");
  });
});

describe("highlight: одна плашка на фразу", () => {
  const plates = (html: string) => html.split("data-adc-plate").length - 1;

  it("фраза з кількох слів — один прямокутник; дві фрази — два", () => {
    const one = render(
      <Headline
        text="Кава яку обсмажуємо самі"
        emphasis={["обсмажуємо самі"]}
        preset="highlight"
        width={3000}
      />,
      60,
    );
    expect(plates(one)).toBe(1);
    const two = render(
      <KineticText
        text="Капучино 75 грн і круасан 40 грн"
        emphasis={["75 грн", "40 грн"]}
        preset="highlight"
        maxFontSize={80}
        minFontSize={40}
        width={3000}
      />,
      60,
    );
    expect(plates(two)).toBe(2);
  });

  it("плашка має внутрішній відступ: виходить за бокс слів униз і вбік", () => {
    const html = render(
      <Headline text="Ваш сайт у порядку" emphasis={["у порядку"]} preset="highlight" width={3000} />,
      60,
    );
    expect(html).toMatch(
      /data-adc-plate="" style="position:absolute;left:-0.1em;right:-0.1em;top:0.040em;bottom:-0.100em/,
    );
  });

  it("слова фрази стають readableOn(accent), коли плашка дійшла до них", () => {
    const html = render(
      <Headline
        text="Кава яку обсмажуємо самі"
        emphasis={["обсмажуємо самі"]}
        preset="highlight"
        width={3000}
      />,
      0,
    );
    expect(plates(html)).toBe(1);
    expect(html).toContain("scaleX(0.0000)");
  });
});

describe("examples/ui-demo.tsx", () => {
  const base = fixtureStoryboard.scenes[1] as Scene;
  const scene: Scene = {
    ...base,
    id: "s2",
    items: [
      { id: "t1", role: "label", text: "webreportio.com", group: null, factIds: [] },
      { id: "t2", role: "button", text: "Аудит", group: null, factIds: [] },
      { id: "t3", role: "heading", text: "Що перевіряємо", group: null, factIds: [] },
      { id: "t4", role: "item", text: "Технічне SEO", group: "list", factIds: [] },
      { id: "t5", role: "item", text: "Швидкість завантаження", group: "list", factIds: [] },
      { id: "t6", role: "item", text: "Безпека", group: "list", factIds: [] },
      { id: "t7", role: "number", text: "~50 перевірок", group: null, factIds: [] },
      { id: "t8", role: "caption", text: "за 2 хвилини", group: null, factIds: [] },
    ],
    events: [
      { id: "type", at: 8, what: "Typing starts.", sound: null, textIds: ["t1"] },
      {
        id: "press",
        at: 45,
        what: "Button pressed.",
        sound: { cue: "click", accent: "normal" },
        textIds: [],
      },
      { id: "scan", at: 60, what: "Scan starts.", sound: { cue: "whoosh", accent: "soft" }, textIds: [] },
      { id: "checks", at: 90, what: "First check.", sound: { cue: "tick", accent: "normal" }, textIds: [] },
      {
        id: "count",
        at: 110,
        what: "Counter runs.",
        sound: { cue: "impact", accent: "hard" },
        textIds: ["t7"],
      },
    ],
  };

  it.each(FORMATS)(
    "%s: рендериться детерміновано, тексти лише з items, на кінці — число дослівно",
    (format) => {
      Object.assign(config, FORMAT_SIZE[format]);
      const node = <UiDemo scene={scene} brand={fixtureBrandKit} assets={{}} durationInFrames={180} />;
      for (const frame of [0, 30, 50, 70, 100, 179]) expect(render(node, frame)).toBe(render(node, frame));
      // Рядки розкладки — окремі блоки, тож порівнюємо без пробілів.
      const end = visibleText(render(node, 179)).replace(/\s/g, "");
      for (const t of [
        "webreportio.com",
        "Аудит",
        "Що перевіряємо",
        "Безпека",
        "~50 перевірок",
        "за 2 хвилини",
      ])
        expect(end).toContain(t.replace(/\s/g, ""));
      Object.assign(config, FORMAT_SIZE.vertical);
    },
  );

  it("сцена без потрібної події — помилка рендеру (eventFrame)", () => {
    const broken = { ...scene, events: scene.events.filter((e) => e.id !== "scan") };
    expect(() =>
      render(<UiDemo scene={broken} brand={fixtureBrandKit} assets={{}} durationInFrames={180} />, 0),
    ).toThrow(/scan/);
  });
});
