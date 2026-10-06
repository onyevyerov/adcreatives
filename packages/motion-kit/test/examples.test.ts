import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Еталонні сцени: компілюються через TypeScript compiler API проти типів motion-kit
 * і дотримуються контракту сцени (спрощена копія правил AST-guard з ТЗ — сам guard у B4).
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXAMPLES = path.join(ROOT, "examples");
const sceneFiles = readdirSync(EXAMPLES)
  .filter((f) => f.endsWith(".tsx"))
  .map((f) => path.join(EXAMPLES, f));

const ALLOWED_IMPORTS: Record<string, "*" | Set<string>> = {
  react: "*",
  remotion: new Set([
    "useCurrentFrame",
    "useVideoConfig",
    "interpolate",
    "spring",
    "Easing",
    "AbsoluteFill",
    "Sequence",
  ]),
  "@remotion/layout-utils": "*",
  "@remotion/shapes": "*",
  "@remotion/paths": "*",
  "@adc/motion-kit": "*",
};
const FORBIDDEN_REACT = new Set(["useState", "useEffect", "useLayoutEffect"]);
const FORBIDDEN_IDENTIFIERS = new Set([
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "eval",
  "Function",
  "require",
  "process",
  "globalThis",
  "window",
  "document",
  "Date",
  "performance",
  "setTimeout",
  "setInterval",
  "requestAnimationFrame",
]);
const FORBIDDEN_TAGS = new Set([
  "img",
  "video",
  "audio",
  "iframe",
  "script",
  "link",
  "style",
  "object",
  "embed",
]);

function guard(file: string, text = readFileSync(file, "utf8")): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const problems: string[] = [];
  let hasDefault = false;
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const mod = node.moduleSpecifier.text;
      const allowed = ALLOWED_IMPORTS[mod];
      if (!allowed) problems.push(`імпорт з ${mod}`);
      const named = node.importClause?.namedBindings;
      if (named && ts.isNamedImports(named)) {
        for (const el of named.elements) {
          const name = (el.propertyName ?? el.name).text;
          if (mod === "react" && FORBIDDEN_REACT.has(name)) problems.push(`react.${name}`);
          if (
            allowed instanceof Set &&
            !node.importClause?.isTypeOnly &&
            !el.isTypeOnly &&
            !allowed.has(name)
          ) {
            problems.push(`${mod}.${name}`);
          }
        }
      }
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)
      problems.push("dynamic import");
    if (ts.isIdentifier(node) && FORBIDDEN_IDENTIFIERS.has(node.text)) problems.push(node.text);
    if (ts.isPropertyAccessExpression(node) && node.getText(source) === "Math.random")
      problems.push("Math.random");
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      FORBIDDEN_TAGS.has(node.tagName.getText(source))
    ) {
      problems.push(`<${node.tagName.getText(source)}>`);
    }
    if (ts.isJsxAttribute(node) && node.name.getText(source) === "dangerouslySetInnerHTML")
      problems.push("dangerouslySetInnerHTML");
    if (ts.isPropertyAssignment(node) && ["transition", "animation"].includes(node.name.getText(source))) {
      problems.push(`style ${node.name.getText(source)}`);
    }
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      /https?:\/\/|\/\//.test(node.text)
    ) {
      problems.push(`URL у рядку: ${node.text}`);
    }
    if (
      ts.isFunctionDeclaration(node) &&
      node.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)
    ) {
      hasDefault = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!hasDefault) problems.push("немає export default function Scene");
  return problems;
}

// Навмисно погана сцена для самоперевірки guard.
const BAD_SCENE = `
import { useState } from "react";
import { Img } from "remotion";
export default function Scene() {
  const [n] = useState(Math.random());
  return (
    <div style={{ transition: "all 1s" }}>
      <img src="x.png" />
      <Img src="y.png" />
      {n}{new Date().getFullYear()}
    </div>
  );
}
`;

describe("еталонні сцени (examples/*.tsx)", () => {
  it("їх 4–5", () => {
    expect(sceneFiles.length).toBeGreaterThanOrEqual(4);
    expect(sceneFiles.length).toBeLessThanOrEqual(5);
  });

  it("компілюються проти типів motion-kit без помилок", () => {
    const configPath = path.join(ROOT, "tsconfig.json");
    const parsed = ts.parseJsonConfigFileContent(
      ts.readConfigFile(configPath, ts.sys.readFile).config,
      ts.sys,
      ROOT,
    );
    const program = ts.createProgram({
      rootNames: [...sceneFiles, path.join(EXAMPLES, "index.ts")],
      options: { ...parsed.options, noEmit: true },
    });
    const diagnostics = ts.getPreEmitDiagnostics(program).map((d) => {
      const where = d.file
        ? `${path.basename(d.file.fileName)}:${d.file.getLineAndCharacterOfPosition(d.start ?? 0).line + 1}`
        : "";
      return `${where} ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`;
    });
    expect(diagnostics).toEqual([]);
  });

  it.each(sceneFiles.map((f) => [path.basename(f), f]))("%s дотримується контракту сцени", (_name, file) => {
    expect(guard(file)).toEqual([]);
  });

  it("guard ловить порушення (самоперевірка тесту)", () => {
    expect(guard("bad.tsx", BAD_SCENE)).toEqual(
      expect.arrayContaining([
        "react.useState",
        "remotion.Img",
        "Math.random",
        "<img>",
        "style transition",
        "Date",
      ]),
    );
  });
});
