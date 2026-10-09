import ts from "typescript";

/**
 * AST-guard сцени (у складі `codegen` і `fix`): статична перевірка TSX, згенерованого моделлю,
 * за правилами ТЗ («Режисура → AST-guard»). Порушення не виправляються, а повертаються списком:
 * сцена з порушенням не потрапляє в `video/scenes/`, а йде у `fix` з цим списком.
 */

export type GuardRule =
  | "syntax"
  | "import"
  | "import_member"
  | "forbidden_global"
  | "math_random"
  | "dynamic_import"
  | "css_animation"
  | "forbidden_tag"
  | "dangerous_html"
  | "url_string"
  | "default_export";

export interface GuardViolation {
  rule: GuardRule;
  message: string;
  /** 1-based; null — до файлу загалом. */
  line: number | null;
  column: number | null;
}

export interface GuardResult {
  ok: boolean;
  violations: GuardViolation[];
}

/** Модулі, які може імпортувати сцена. `*` — будь-які члени (з урахуванням FORBIDDEN_REACT_MEMBERS). */
export const ALLOWED_MODULES: Readonly<Record<string, "*" | ReadonlySet<string>>> = {
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

export const FORBIDDEN_REACT_MEMBERS: ReadonlySet<string> = new Set([
  "useState",
  "useEffect",
  "useLayoutEffect",
]);

export const FORBIDDEN_GLOBALS: ReadonlySet<string> = new Set([
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

export const FORBIDDEN_TAGS: ReadonlySet<string> = new Set([
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

/** CSS-властивості transition/animation (camelCase, з вендорними префіксами або без). */
const CSS_ANIMATION_PROP =
  /^(?:webkit|moz|ms|o)?(?:transition|animation)(?:property|duration|timingfunction|delay|behavior|name|iterationcount|direction|fillmode|playstate|composition|timeline|range\w*)?$/i;
/** Те саме всередині CSS-рядка: `transition: …`, `animation-name: …`, `@keyframes`. */
const CSS_ANIMATION_TEXT =
  /(?:^|[;{\s"'`])(?:-(?:webkit|moz|ms|o)-)?(?:transition|animation)(?:-[a-z-]+)?\s*:|@keyframes/i;
const URL_TEXT = /https?:\/\/|\/\//i;

function camel(name: string): string {
  return name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

function propertyNameText(name: ts.PropertyName | ts.JsxAttributeName): string | null {
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name))
    return name.text;
  if (ts.isJsxNamespacedName(name)) return `${name.namespace.text}:${name.name.text}`;
  if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression)) return name.expression.text;
  return null;
}

/** Ідентифікатор у позиції імені властивості/атрибута — не звертання до глобала. */
function isPropertyNamePosition(id: ts.Identifier): boolean {
  const p = id.parent;
  if (!p) return false;
  if (ts.isPropertyAccessExpression(p) && p.name === id) return true;
  if (ts.isQualifiedName(p) && p.right === id) return true;
  if (
    (ts.isPropertyAssignment(p) ||
      ts.isPropertySignature(p) ||
      ts.isPropertyDeclaration(p) ||
      ts.isMethodDeclaration(p) ||
      ts.isMethodSignature(p) ||
      ts.isGetAccessorDeclaration(p) ||
      ts.isSetAccessorDeclaration(p) ||
      ts.isEnumMember(p)) &&
    p.name === id
  )
    return true;
  if (ts.isBindingElement(p) && p.propertyName === id) return true;
  if (ts.isJsxAttribute(p) && p.name === id) return true;
  if ((ts.isImportSpecifier(p) || ts.isExportSpecifier(p)) && p.propertyName === id) return true;
  if (ts.isLabeledStatement(p) || ts.isBreakOrContinueStatement(p)) return true;
  return false;
}

function jsxTagName(node: ts.JsxOpeningLikeElement | ts.JsxClosingElement): string | null {
  const t = node.tagName;
  return ts.isIdentifier(t) ? t.text : null;
}

export interface GuardOptions {
  /** Для повідомлень. */
  fileName?: string;
  /**
   * Точні рядки, які сцена може показати в кадрі (`allowedScreenTexts`). Перевірка — у B5;
   * поки параметр ігнорується.
   */
  allowedTexts?: readonly string[];
}

/** Перевіряє код сцени. */
export function guardScene(code: string, opts: GuardOptions = {}): GuardResult {
  const fileName = opts.fileName ?? "scene.tsx";
  const source = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const violations: GuardViolation[] = [];
  const seen = new Set<string>();

  const add = (rule: GuardRule, message: string, node?: ts.Node) => {
    let line: number | null = null;
    let column: number | null = null;
    if (node) {
      const pos = source.getLineAndCharacterOfPosition(node.getStart(source));
      line = pos.line + 1;
      column = pos.character + 1;
    }
    const key = `${rule}|${message}|${line}`;
    if (seen.has(key)) return;
    seen.add(key);
    violations.push({ rule, message, line, column });
  };

  // Синтаксичні помилки: далі аналізувати немає сенсу лише якщо дерево зовсім биті, тож ідемо далі.
  const parseDiagnostics =
    (source as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? [];
  for (const d of parseDiagnostics) {
    const pos = source.getLineAndCharacterOfPosition(d.start ?? 0);
    const key = `syntax|${d.start}`;
    if (seen.has(key)) continue;
    seen.add(key);
    violations.push({
      rule: "syntax",
      message: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
      line: pos.line + 1,
      column: pos.character + 1,
    });
  }

  let hasDefaultExport = false;

  const checkModule = (spec: ts.Expression, node: ts.Node): string | null => {
    if (!ts.isStringLiteralLike(spec)) {
      add("import", "імпорт з нерядкового модуля", node);
      return null;
    }
    const mod = spec.text;
    if (!(mod in ALLOWED_MODULES)) {
      add(
        "import",
        `імпорт з «${mod}» заборонено (дозволено: ${Object.keys(ALLOWED_MODULES).join(", ")})`,
        node,
      );
      return null;
    }
    return mod;
  };

  const checkMember = (mod: string, name: string, node: ts.Node, typeOnly: boolean) => {
    if (mod === "react" && FORBIDDEN_REACT_MEMBERS.has(name)) {
      add(
        "import_member",
        `react.${name} заборонено: стан і ефекти не детерміновані при покадровому рендері`,
        node,
      );
      return;
    }
    const allowed = ALLOWED_MODULES[mod];
    if (allowed instanceof Set && !typeOnly && !allowed.has(name)) {
      add("import_member", `${mod}.${name} заборонено (дозволено: ${[...allowed].join(", ")})`, node);
    }
  };

  const visit = (node: ts.Node): void => {
    // ---------- імпорти й реекспорти ----------
    if (ts.isImportDeclaration(node)) {
      const mod = checkModule(node.moduleSpecifier, node);
      const clause = node.importClause;
      if (mod && clause) {
        const typeOnly = clause.isTypeOnly;
        if (clause.name && !typeOnly && ALLOWED_MODULES[mod] !== "*") {
          add("import_member", `default-імпорт з «${mod}» заборонено`, clause.name);
        }
        const named = clause.namedBindings;
        if (named && ts.isNamespaceImport(named) && !typeOnly && mod !== "@adc/motion-kit") {
          add(
            "import_member",
            `імпорт «* as ${named.name.text}» з «${mod}» заборонено — імпортуйте члени поіменно`,
            named,
          );
        }
        if (named && ts.isNamedImports(named)) {
          for (const el of named.elements) {
            checkMember(mod, (el.propertyName ?? el.name).text, el, typeOnly || el.isTypeOnly);
          }
        }
      }
      return;
    }
    if (ts.isImportEqualsDeclaration(node)) {
      add("import", "import = require(...) заборонено", node);
      return;
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const mod = checkModule(node.moduleSpecifier, node);
      if (mod && node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const el of node.exportClause.elements) {
          checkMember(mod, (el.propertyName ?? el.name).text, el, node.isTypeOnly || el.isTypeOnly);
        }
      }
    }

    // ---------- default export ----------
    if (ts.isExportAssignment(node) && !node.isExportEquals) hasDefaultExport = true;
    if (
      (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
      node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) &&
      node.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)
    ) {
      hasDefaultExport = true;
    }
    if (ts.isExportSpecifier(node) && node.name.text === "default") hasDefaultExport = true;

    // ---------- динамічний import() / require ----------
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      add("dynamic_import", "динамічний import() заборонено", node);
    }

    // ---------- глобали ----------
    if (ts.isIdentifier(node) && FORBIDDEN_GLOBALS.has(node.text) && !isPropertyNamePosition(node)) {
      add("forbidden_global", `«${node.text}» заборонено в сцені`, node);
    }

    // ---------- Math.random ----------
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "Math" &&
      node.name.text === "random"
    ) {
      add("math_random", "Math.random заборонено — рендер має бути детермінованим", node);
    }
    if (
      ts.isElementAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "Math" &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      node.argumentExpression.text === "random"
    ) {
      add("math_random", "Math.random заборонено — рендер має бути детермінованим", node);
    }

    // ---------- хуки React через namespace (React.useEffect) ----------
    if (
      ts.isPropertyAccessExpression(node) &&
      FORBIDDEN_REACT_MEMBERS.has(node.name.text) &&
      ts.isIdentifier(node.expression) &&
      /^react$/i.test(node.expression.text)
    ) {
      add("import_member", `${node.expression.text}.${node.name.text} заборонено`, node);
    }

    // ---------- CSS transition / animation ----------
    if (
      (ts.isPropertyAssignment(node) ||
        ts.isShorthandPropertyAssignment(node) ||
        ts.isMethodDeclaration(node)) &&
      node.name
    ) {
      const name = propertyNameText(node.name);
      if (name && CSS_ANIMATION_PROP.test(camel(name))) {
        add("css_animation", `CSS-властивість «${name}» заборонена: анімуйте через useCurrentFrame()`, node);
      }
      if (name === "dangerouslySetInnerHTML")
        add("dangerous_html", "dangerouslySetInnerHTML заборонено", node);
    }

    // ---------- JSX ----------
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = jsxTagName(node);
      if (tag && FORBIDDEN_TAGS.has(tag)) {
        add(
          "forbidden_tag",
          `тег <${tag}> заборонено (зображення — лише <BrandImage>/<Logo>, звук і відео — справа хоста)`,
          node,
        );
      }
    }
    if (ts.isJsxAttribute(node)) {
      const name = propertyNameText(node.name);
      if (name === "dangerouslySetInnerHTML")
        add("dangerous_html", "dangerouslySetInnerHTML заборонено", node);
      if (name === "style" && node.initializer && ts.isStringLiteral(node.initializer)) {
        if (CSS_ANIMATION_TEXT.test(node.initializer.text)) {
          add("css_animation", "CSS transition/animation у style заборонено", node);
        }
      }
    }

    // ---------- рядки ----------
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node) ||
      ts.isJsxText(node)
    ) {
      const text = node.text;
      const inImport =
        node.parent &&
        (ts.isImportDeclaration(node.parent) ||
          ts.isExportDeclaration(node.parent) ||
          ts.isExternalModuleReference(node.parent));
      if (!inImport) {
        if (URL_TEXT.test(text)) {
          add("url_string", `рядок з адресою заборонено: «${text.trim().slice(0, 60)}»`, node);
        }
        if (CSS_ANIMATION_TEXT.test(text)) {
          add("css_animation", "CSS transition/animation у рядку заборонено", node);
        }
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(source);

  if (!hasDefaultExport) {
    add("default_export", "немає `export default function Scene(props: SceneProps)`");
  }
  return { ok: violations.length === 0, violations };
}

/** Порушення одним текстом — для check.json і промпта `code-fix`. */
export function formatViolations(violations: readonly GuardViolation[]): string {
  return violations
    .map((v) => `${v.line !== null ? `рядок ${v.line}: ` : ""}[${v.rule}] ${v.message}`)
    .join("\n");
}
