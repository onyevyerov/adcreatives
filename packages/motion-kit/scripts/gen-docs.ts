/**
 * Генерує `API.generated.md` з `.d.ts` пакета: TypeScript emitDeclarationOnly (у пам'ять),
 * далі склеювання декларацій модулів у markdown. Запуск: `pnpm --filter @adc/motion-kit docs`.
 * Результат підставляється в промпт `codegen` разом з API.md і examples/.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");
const OUT = path.join(ROOT, "API.generated.md");

/** Порядок і заголовки розділів (модулі без розділу додаються в кінець). */
const SECTIONS: Array<[string, string]> = [
  ["index", "Вхід пакета (`@adc/motion-kit`)"],
  ["format", "Формат і safe-зона"],
  ["theme", "Тема, асети, тривалість сцени"],
  ["text/components", "Текст: FitText, KineticText, Headline, Body, Pill, CTAButton"],
  ["text/TextBlock", "Текст: пресети анімації"],
  ["media/BrandImage", "Зображення"],
  ["media/Logo", "Лого"],
  ["media/Backdrop", "Фон"],
  ["motion", "Рух: springs, easings, progress"],
  ["color", "Кольори і контраст"],
  ["devices/motion", "Девайси: useBeat, Breathe"],
  ["devices/reveal", "Девайси: ColorField, ClipReveal"],
  ["devices/shape", "Девайси: DrawPath, MorphShape"],
  ["devices/blur", "Девайси: MotionBlur, Trail"],
  ["devices/camera", "Девайси: Camera"],
  ["icons/Icon", "Іконки: Icon"],
  ["icons/names", "Іконки: назви (IconName)"],
  ["icons/paths", "Іконки: шляхи (дані lucide)"],
  ["ui/number", "Числа з текстів: numberIn"],
  ["ui/data", "Дані: CountUp, Ring, Bars"],
  ["ui/widgets", "Інтерфейс: UICard, Checkbox, Checklist, InputField, Cursor"],
  ["ui/effects", "Ефекти: ScanLine, Flash, Glow, Strike"],
  ["ui/paint", "Колір прийому (внутрішнє)"],
  ["qa", "QA-режим (лише хост)"],
  ["host/TemplateScene", "TemplateScene (лише хост)"],
  ["host/audio", "Звук (лише хост)"],
  ["fonts", "Шрифти (лише хост)"],
  ["text/layout", "Розкладка тексту (чисті функції)"],
  ["text/measure", "Вимірювання тексту (внутрішнє)"],
];

const configPath = path.join(ROOT, "tsconfig.json");
const parsed = ts.parseJsonConfigFileContent(
  ts.readConfigFile(configPath, ts.sys.readFile).config,
  ts.sys,
  ROOT,
);
const program = ts.createProgram({
  rootNames: [path.join(SRC, "index.ts")],
  options: {
    ...parsed.options,
    noEmit: false,
    declaration: true,
    emitDeclarationOnly: true,
    declarationMap: false,
    sourceMap: false,
    rootDir: ROOT,
    outDir: path.join(ROOT, ".d-ts"),
  },
});

const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length > 0) {
  const host: ts.FormatDiagnosticsHost = {
    getCanonicalFileName: (f) => f,
    getCurrentDirectory: () => ROOT,
    getNewLine: () => "\n",
  };
  console.error(ts.formatDiagnostics(diagnostics, host));
  process.exit(1);
}

const declarations = new Map<string, string>();
const outSrc = path.join(ROOT, ".d-ts", "src");
program.emit(undefined, (fileName, text) => {
  const rel = path.relative(outSrc, fileName).replace(/\\/g, "/");
  if (rel.startsWith("..") || !rel.endsWith(".d.ts")) return;
  declarations.set(rel.replace(/\.d\.ts$/, ""), text.replace(/\/\/# sourceMappingURL=.*$/m, "").trim());
});

const ordered = [
  ...SECTIONS.filter(([mod]) => declarations.has(mod)),
  ...[...declarations.keys()]
    .filter((m) => !SECTIONS.some(([s]) => s === m))
    .map((m): [string, string] => [m, m]),
];

const parts = [
  "# `@adc/motion-kit` — декларації API (згенеровано)",
  "",
  "> Не редагувати вручну. Згенеровано з `.d.ts` командою `pnpm --filter @adc/motion-kit docs`.",
  "> Контракт і правила для сцен — `CONTRACT.md`; еталонні сцени — `examples/*.tsx`.",
  "",
];
for (const [mod, title] of ordered) {
  parts.push(`## ${title}`, "", `\`src/${mod}\``, "", "```ts", declarations.get(mod) ?? "", "```", "");
}
writeFileSync(OUT, `${parts.join("\n").trimEnd()}\n`, "utf8");
console.log(`API.generated.md: ${ordered.length} модулів → ${path.relative(process.cwd(), OUT)}`);
