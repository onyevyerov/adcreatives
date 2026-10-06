import { describe, expect, it } from "vitest";
import { guardScene } from "../src/guard.ts";
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
});
