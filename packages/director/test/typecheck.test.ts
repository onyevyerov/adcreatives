import { describe, expect, it } from "vitest";
import { typecheckScenes } from "../src/typecheck.ts";
import { exampleSources } from "./helpers.ts";

describe("typecheckScenes", () => {
  it("еталонні сцени motion-kit проходять", () => {
    const ex = exampleSources();
    const res = typecheckScenes({ s1: ex["hook-photo"], s2: ex["offer-price"], s3: ex["cta-logo"] });
    expect(res.errors).toEqual([]);
    expect(res.ok).toBe(true);
  });

  it('Headline і Body приймають by="line" (як у стадії check)', () => {
    const scene = `import type { SceneProps } from "@adc/motion-kit";
import { Body, Headline, SafeArea } from "@adc/motion-kit";
export default function Scene(props: SceneProps) {
  return (
    <SafeArea>
      <Headline text={props.scene.text.headline} by="line" preset="rise" />
      <Body text={props.scene.text.sub ?? ""} by="line" preset="fade" />
    </SafeArea>
  );
}
`;
    const res = typecheckScenes({ s1: scene });
    expect(res.errors).toEqual([]);
    expect(res.ok).toBe(true);
    const bad = typecheckScenes({
      s1: scene.replace(
        '<Body text={props.scene.text.sub ?? ""} by="line"',
        '<Body text={props.scene.text.sub ?? ""} by="row"',
      ),
    });
    expect(bad.ok).toBe(false);
  });

  it("групує помилки по сценах", () => {
    const ex = exampleSources();
    const bad = `import type { SceneProps } from "@adc/motion-kit";
import { Headline } from "@adc/motion-kit";
export default function Scene(props: SceneProps) {
  return <Headline text={props.scene.text.title} size="huge" />;
}
`;
    const res = typecheckScenes({ s1: ex["hook-photo"], s2: bad });
    expect(res.ok).toBe(false);
    expect(Object.keys(res.byScene)).toEqual(["s2"]);
    const messages = res.byScene.s2?.map((e) => e.message).join("\n") ?? "";
    expect(messages).toMatch(/title/);
    expect(res.byScene.s2?.[0]?.line).toBe(4);
  });

  it("невідомий імпорт і зламаний синтаксис — помилки сцени", () => {
    const res = typecheckScenes({
      s1: `import { Nope } from "@adc/motion-kit";\nexport default function Scene() { return <Nope />; }\n`,
      s2: `export default function Scene( { return <div> }\n`,
    });
    expect(res.byScene.s1?.length).toBeGreaterThan(0);
    expect(res.byScene.s2?.length).toBeGreaterThan(0);
  });

  it("порушений контракт default export прив'язується до сцени", () => {
    const res = typecheckScenes({
      s4: `export default function Scene(props: { foo: number }) { return <div>{props.foo}</div>; }\n`,
      s5: `export const x = 1;\n`,
    });
    expect(res.byScene.s4?.some((e) => e.message.includes("контракт"))).toBe(true);
    expect(res.byScene.s5?.length).toBeGreaterThan(0);
  });
});
