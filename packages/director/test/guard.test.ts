import { allowedScreenTexts } from "@adc/shared";
import { fixtureBrandKit, fixtureStoryboard } from "@adc/shared/fixtures";
import { describe, expect, it } from "vitest";
import { guardScene, normalizeScreenText } from "../src/guard.ts";
import { exampleSources } from "./helpers.ts";

const rules = (code: string) => guardScene(code).violations.map((v) => v.rule);
const scene = (body: string, imports = "") =>
  `import type { SceneProps } from "@adc/motion-kit";\n${imports}\nexport default function Scene(props: SceneProps) {\n${body}\n}\n`;

describe("guardScene", () => {
  it.each(Object.entries(exampleSources()))("еталон %s проходить", (_name, code) => {
    expect(guardScene(code).violations).toEqual([]);
  });

  it("CSS transition / animation у style", () => {
    expect(rules(scene(`return <div style={{ transition: "opacity 1s" }} />;`))).toContain("css_animation");
    expect(rules(scene(`return <div style={{ animationName: "spin" }} />;`))).toContain("css_animation");
    expect(rules(scene(`return <div style={{ WebkitTransition: "all 1s" }} />;`))).toContain("css_animation");
    expect(rules(scene(`const s = { "transition-duration": "1s" }; return <div style={s} />;`))).toContain(
      "css_animation",
    );
    expect(rules(scene("return <div style={{ opacity: 1 }}>{`a; animation: x 1s`}</div>;"))).toContain(
      "css_animation",
    );
    // поле розкадровки transitionIn — не CSS
    expect(
      rules(
        scene(`const t = { transitionIn: props.scene.transitionIn }; return <div>{t.transitionIn}</div>;`),
      ),
    ).toEqual([]);
  });

  it("Date, Math.random, таймери, глобали", () => {
    expect(rules(scene(`const y = new Date().getFullYear(); return <div>{y}</div>;`))).toContain(
      "forbidden_global",
    );
    expect(rules(scene(`return <div>{Math.random()}</div>;`))).toContain("math_random");
    expect(rules(scene(`return <div>{Math["random"]()}</div>;`))).toContain("math_random");
    for (const g of [
      "setTimeout(() => 1, 5)",
      "window.innerWidth",
      "fetch('x')",
      "performance.now()",
      "eval('1')",
    ]) {
      expect(rules(scene(`const v = ${g}; return <div>{String(v)}</div>;`))).toContain("forbidden_global");
    }
    // властивість з такою назвою — не глобал
    expect(rules(scene(`const o = { window: 1, Date: 2 }; return <div>{o.window + o.Date}</div>;`))).toEqual(
      [],
    );
  });

  it("імпорти: whitelist модулів і членів", () => {
    expect(rules(scene("return null;", `import { Img } from "remotion";`))).toContain("import_member");
    expect(rules(scene("return null;", `import { useState } from "react";`))).toContain("import_member");
    expect(rules(scene("return null;", `import React from "remotion";`))).toContain("import_member");
    expect(rules(scene("return null;", `import fs from "node:fs";`))).toContain("import");
    expect(rules(scene("return null;", `import * as R from "remotion";`))).toContain("import_member");
    expect(
      rules(
        scene("return null;", `import { useMemo } from "react";\nimport { Circle } from "@remotion/shapes";`),
      ),
    ).toEqual([]);
    expect(
      rules(scene("return null;", `import type { CalculateMetadataFunction } from "remotion";`)),
    ).toEqual([]);
    expect(
      rules(scene(`React.useEffect(() => {}); return null;`, `import * as React from "react";`)),
    ).toContain("import_member");
  });

  it("динамічний import і require", () => {
    expect(rules(scene(`void import("x"); return null;`))).toContain("dynamic_import");
    expect(rules(scene(`const m = require("x"); return m;`))).toContain("forbidden_global");
  });

  it("заборонені теги, dangerouslySetInnerHTML, URL у рядках", () => {
    expect(rules(scene(`return <img src="a.png" />;`))).toContain("forbidden_tag");
    expect(rules(scene(`return <video />;`))).toContain("forbidden_tag");
    expect(rules(scene(`return <div><style>{"x"}</style></div>;`))).toContain("forbidden_tag");
    expect(rules(scene(`return <div dangerouslySetInnerHTML={{ __html: "x" }} />;`))).toContain(
      "dangerous_html",
    );
    expect(rules(scene(`return <div>{"https://example.com"}</div>;`))).toContain("url_string");
    expect(rules(scene(`const u = "//cdn.example/x.png"; return <div>{u}</div>;`))).toContain("url_string");
    expect(rules(scene(`return <div>see http://x.y</div>;`))).toContain("url_string");
  });

  it("контракт: default export і синтаксис", () => {
    expect(rules(`export const Scene = () => null;\n`)).toContain("default_export");
    expect(rules(`export default function Scene( { return <div> }`)).toContain("syntax");
    expect(guardScene(`const S = () => null;\nexport default S;\n`).ok).toBe(true);
  });

  it("порушення мають рядок", () => {
    const res = guardScene(scene(`const d = Date.now();\nreturn <div>{d}</div>;`));
    expect(res.ok).toBe(false);
    expect(res.violations[0]).toMatchObject({ rule: "forbidden_global", line: 4 });
  });

  describe("allowedTexts: тексти в кадрі лише з розкадровки", () => {
    const offer = fixtureStoryboard.scenes[1];
    if (!offer) throw new Error("фікстура без s2");
    const allowed = allowedScreenTexts(offer, fixtureBrandKit);
    const texts = (code: string, list: readonly string[] = allowed) =>
      guardScene(code, { allowedTexts: list })
        .violations.filter((v) => v.rule === "screen_text")
        .map((v) => v.message);

    it.each(Object.entries(exampleSources()))("еталон %s проходить з текстами сцени", (_name, code) => {
      expect(guardScene(code, { allowedTexts: allowed }).violations).toEqual([]);
    });

    it("відхиляє вигаданий текст; пропускає дані сцени і символи", () => {
      expect(texts(scene(`return <div>Найкращий сервіс</div>;`))).toHaveLength(1);
      expect(texts(scene(`return <div>Найкращий сервіс</div>;`))[0]).toMatch(/Найкращий сервіс/);
      expect(texts(scene(`return <div>{props.scene.items[0].text}</div>;`))).toEqual([]);
      expect(texts(scene(`return <span>•</span>;`))).toEqual([]);
      expect(texts(scene(`return <p>{"—"} {"→"} %</p>;`))).toEqual([]);
      expect(texts(scene(`return <div>{props.brand.cta.text}</div>;`))).toEqual([]);
    });

    it("дослівний збіг або підрядок; пробіли й переноси JSXText згортаються", () => {
      expect(texts(scene(`return <div>Капучино — 75 грн</div>;`))).toEqual([]);
      expect(texts(scene(`return <div>75 грн</div>;`))).toEqual([]);
      expect(texts(scene(`return <div>\n      Спешелті   еспресо\n      з молоком\n    </div>;`))).toEqual(
        [],
      );
      expect(texts(scene(`return <div>{"-10%"}</div>;`))).toEqual([]);
      expect(texts(scene(`return <div>80 грн</div>;`))).toHaveLength(1);
      expect(texts(scene(`return <div>{"Капучино"}</div>;`))).toEqual([]);
      expect(texts(scene(`return <div>{"Лате"}</div>;`))).toHaveLength(1);
      // апостроф і NFC
      expect(normalizeScreenText("З\u2019їжте  \n тут")).toBe("З'їжте тут");
      expect(texts(scene(`return <div>З'їжте</div>;`), ["З\u2019їжте тут"])).toEqual([]);
    });

    it("рядки-діти у виразах, шаблонах і текстових пропах", () => {
      expect(
        texts(scene(`return <div>{props.scene.text.sub ? props.scene.text.sub : "Скоро"}</div>;`)),
      ).toHaveLength(1);
      expect(texts(scene(`return <div>{props.scene.text.sub ?? "Скоро"}</div>;`))).toHaveLength(1);
      // шаблонний рядок дитиною JSX: перевіряються його статичні частини
      const tpl = (tail: string) => scene(`const n = 5; return <div>{\`\${n} ${tail}\`}</div>;`);
      expect(texts(tpl("відгуків"))).toHaveLength(1);
      expect(texts(tpl("грн"))).toEqual([]);
      expect(
        texts(
          scene(
            `return <Headline text="Найкращий сервіс" />;`,
            `import { Headline } from "@adc/motion-kit";`,
          ),
        ),
      ).toHaveLength(1);
      expect(
        texts(
          scene(
            `return <InputField text={"webreport.io"} placeholder="Введіть адресу" typeStart={0} width={600} />;`,
            `import { InputField } from "@adc/motion-kit";`,
          ),
        ),
      ).toHaveLength(2);
      expect(
        texts(
          scene(
            `return <Checklist items={["75 грн", "Безкоштовно"]} startFrame={0} width={600} />;`,
            `import { Checklist } from "@adc/motion-kit";`,
          ),
        ),
      ).toHaveLength(1);
      // не-текстові пропи й рядки поза кадром не перевіряються
      expect(
        texts(
          scene(
            `const role = "number"; return <Icon name="shield-check" size={80} color="accent" />;`,
            `import { Icon } from "@adc/motion-kit";`,
          ),
        ),
      ).toEqual([]);
      expect(
        texts(scene(`return <div style={{ fontFamily: "Inter" }}>{props.scene.text.headline}</div>;`)),
      ).toEqual([]);
    });

    it("без allowedTexts — тексти не перевіряються; порожній список — заборонено будь-який", () => {
      expect(rules(scene(`return <div>Найкращий сервіс</div>;`))).toEqual([]);
      expect(texts(scene(`return <div>Будь-що</div>;`), [])).toHaveLength(1);
      expect(texts(scene(`return <div>•</div>;`), [])).toEqual([]);
    });
  });
});
