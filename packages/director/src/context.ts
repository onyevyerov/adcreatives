import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type LogoInfo, shortHash } from "@adc/shared";

/**
 * Довідковий контекст для промптів `codegen` і `code-fix` (system-частина, кешується):
 * - вендорна копія https://www.remotion.dev/system-prompt.txt (`vendor/remotion-system-prompt.txt`,
 *   завантажено 2026-10-06; оновлювати вручну);
 * - `packages/motion-kit/API.md` (поведінка компонентів) + `API.generated.md` (декларації з .d.ts);
 * - еталонні сцени `packages/motion-kit/examples/*.tsx`.
 */

const require = createRequire(import.meta.url);
const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function motionKitDir(): string {
  return path.dirname(require.resolve("@adc/motion-kit/package.json"));
}

export interface CodegenContext {
  remotionSystemPrompt: string;
  motionKitApi: string;
  motionKitDeclarations: string;
  /** Еталонні сцени: файл → код. */
  examples: Record<string, string>;
  /** Еталони одним текстом у форматі `<file>`. */
  examplesText: string;
  /** Хеш усього контексту — входить у хеш входів codegen/fix. */
  hash: string;
}

let cached: CodegenContext | null = null;

/** Еталонні сцени motion-kit: ім'я файлу без розширення → код. */
export function readExampleScenes(): Record<string, string> {
  const dir = path.join(motionKitDir(), "examples");
  const out: Record<string, string> = {};
  for (const f of readdirSync(dir).sort()) {
    if (f.endsWith(".tsx"))
      out[f.slice(0, -4)] = readFileSync(path.join(dir, f), "utf8").replaceAll("\r\n", "\n");
  }
  return out;
}

/** Завантажує контекст (раз на процес; у dev — щоразу, як і промпти). */
export function loadCodegenContext(opts: { reload?: boolean } = {}): CodegenContext {
  const reload = opts.reload ?? process.env.NODE_ENV !== "production";
  if (cached && !reload) return cached;
  const mk = motionKitDir();
  const read = (p: string) => readFileSync(p, "utf8").replaceAll("\r\n", "\n").trim();
  const remotionSystemPrompt = read(path.join(PACKAGE_DIR, "vendor", "remotion-system-prompt.txt"));
  const motionKitApi = read(path.join(mk, "API.md"));
  const motionKitDeclarations = read(path.join(mk, "API.generated.md"));
  const examples = readExampleScenes();
  const examplesText = Object.entries(examples)
    .map(([name, code]) => `<file name="examples/${name}.tsx">\n${code.trim()}\n</file>`)
    .join("\n\n");
  const hash = shortHash(
    [remotionSystemPrompt, motionKitApi, motionKitDeclarations, examplesText].join("\0"),
  );
  cached = { remotionSystemPrompt, motionKitApi, motionKitDeclarations, examples, examplesText, hash };
  return cached;
}

type LogoRef = Pick<LogoInfo, "type" | "assetId">;

/**
 * Чи лого векторне — з бренд-кіта, без читання файлу: `logo.type === "svg"` (finalize ставить його за
 * mime асета лого `image/svg+xml`) і лого має `assetId`. Це «можливо векторне»: SVG лише з `<text>` чи
 * з вбудованим растром дасть `useLogoGeometry() === null`, тож код сцени завжди має фолбек на `<Logo>`.
 */
export function logoIsVector(logo: LogoRef): boolean {
  return logo.type === "svg" && logo.assetId !== null;
}

/** Без бренду: модель сама дивиться `logo.type` у `<brand>`. */
const LOGO_HINT_GENERIC =
  "Look at `logo.type` in `<brand>`: `svg` means a vector logo, and `useLogoGeometry()` returns its " +
  "`viewBox` and `paths` for `<LogoPath>`; `image` and `text` mean `useLogoGeometry()` returns `null` and " +
  "the logo is shown with `<Logo>`. Always fall back to `<Logo>` when the hook returns `null`.";

/**
 * Підказка для коду фіналу: чи можна малювати лого з геометрії (`useLogoGeometry` / `LogoPath`).
 * Англійською, як і промпти коду; без бренду — загальне правило за `logo.type` з `<brand>`.
 */
export function logoGeometryHint(logo?: LogoRef | null): string {
  if (!logo) return LOGO_HINT_GENERIC;
  if (logoIsVector(logo)) {
    return (
      "The logo is vector (SVG): `useLogoGeometry()` returns its `viewBox` and `paths`, so the final can " +
      "draw it with `<LogoPath>` or build it from its paths; still fall back to `<Logo>` when the hook " +
      "returns `null` (an SVG with only text or a bitmap inside)."
    );
  }
  if (logo.type === "text" || logo.assetId === null) {
    return (
      "The brand has no logo image: `<Logo>` draws the logo's text fallback in the heading font, and " +
      "`useLogoGeometry()` returns `null`."
    );
  }
  return (
    "The logo is a raster image: `useLogoGeometry()` returns `null`, so show it with `<Logo>` (reveal it " +
    "with a mask, a scale or the film's line; it cannot be drawn stroke by stroke)."
  );
}

/**
 * Змінні промптів codegen / code-fix: system-частина (довідка, однакова для всіх проєктів) і
 * `logoGeometryHint` — чи лого векторне. З `brand` підказка конкретна, без нього — загальне правило за
 * `logo.type` з `<brand>` (промпт однаково бачить `<brand>`).
 */
export function contextVars(ctx: CodegenContext, brand?: { logo: LogoRef } | null): Record<string, string> {
  return {
    remotionSystemPrompt: ctx.remotionSystemPrompt,
    motionKitApi: ctx.motionKitApi,
    motionKitDeclarations: ctx.motionKitDeclarations,
    examples: ctx.examplesText,
    logoGeometryHint: logoGeometryHint(brand?.logo),
  };
}
