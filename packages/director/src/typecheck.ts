import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * `typecheckScenes` — перевірка типів сцен через TypeScript compiler API проти типів `motion-kit`,
 * React і Remotion. Сцени перевіряються в пам'яті як віртуальні файли всередині теки пакета
 * `@adc/director`: так імпорти (`@adc/motion-kit`, `remotion`, `react`, `@remotion/*`) резолвляться
 * з його node_modules, де б не лежала тека ревізії (DATA_DIR).
 *
 * Крім самих сцен перевіряється контракт: default export сцени присвоюється
 * `ComponentType<SceneProps>` у службовому файлі; помилка там прив'язується до сцени.
 *
 * Налаштування строгості: `strict`, але без `noUncheckedIndexedAccess` і `verbatimModuleSyntax`
 * (вони не ловлять runtime-помилок, а лише марно спалюють кола фіксів).
 */

export interface SceneTypeError {
  sceneId: string;
  message: string;
  /** 1-based; null — помилка не прив'язана до позиції. */
  line: number | null;
  column: number | null;
  code: number;
}

export interface TypecheckResult {
  ok: boolean;
  errors: SceneTypeError[];
  /** Помилки по сценах (лише сцени з помилками). */
  byScene: Record<string, SceneTypeError[]>;
  durationMs: number;
}

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VIRTUAL_DIR = path.join(PACKAGE_DIR, ".virtual-scenes");
const CONTRACT_FILE = path.join(VIRTUAL_DIR, "__contract__.ts");

export const TYPECHECK_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2023,
  lib: ["lib.es2023.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  moduleDetection: ts.ModuleDetectionKind.Force,
  jsx: ts.JsxEmit.ReactJSX,
  strict: true,
  noUncheckedIndexedAccess: false,
  noEmit: true,
  skipLibCheck: true,
  allowImportingTsExtensions: true,
  resolveJsonModule: true,
  isolatedModules: true,
  types: [],
};

/** Кеш розібраних файлів поза сценами (lib.d.ts, @types/react, motion-kit) — між викликами. */
const sourceCache = new Map<string, ts.SourceFile>();
let previousProgram: ts.Program | undefined;

const normalize = (p: string) => path.resolve(p).toLowerCase();

function contractSource(sceneIds: readonly string[]): { text: string; lineToScene: Map<number, string> } {
  const lines = [
    'import type { ComponentType } from "react";',
    'import type { SceneProps } from "@adc/motion-kit";',
  ];
  const lineToScene = new Map<number, string>();
  for (const id of sceneIds) {
    lines.push(`import Scene_${id} from "./${id}.tsx";`);
  }
  for (const id of sceneIds) {
    lines.push(`export const contract_${id}: ComponentType<SceneProps> = Scene_${id};`);
    lineToScene.set(lines.length, id);
  }
  return { text: `${lines.join("\n")}\n`, lineToScene };
}

function toError(sceneId: string, d: ts.Diagnostic): SceneTypeError {
  let line: number | null = null;
  let column: number | null = null;
  if (d.file && d.start !== undefined) {
    const pos = d.file.getLineAndCharacterOfPosition(d.start);
    line = pos.line + 1;
    column = pos.character + 1;
  }
  return {
    sceneId,
    message: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
    line,
    column,
    code: d.code,
  };
}

/** Перевіряє типи сцен: sceneId → TSX. */
export function typecheckScenes(scenes: Readonly<Record<string, string>>): TypecheckResult {
  const started = Date.now();
  const ids = Object.keys(scenes).filter((id) => /^s\d{1,2}$/.test(id));
  if (ids.length === 0) return { ok: true, errors: [], byScene: {}, durationMs: 0 };

  const virtual = new Map<string, string>();
  for (const id of ids) {
    virtual.set(normalize(path.join(VIRTUAL_DIR, `${id}.tsx`)), scenes[id] as string);
  }
  const contract = contractSource(ids);
  virtual.set(normalize(CONTRACT_FILE), contract.text);

  const base = ts.createCompilerHost(TYPECHECK_OPTIONS, true);
  const host: ts.CompilerHost = {
    ...base,
    fileExists: (f) => virtual.has(normalize(f)) || base.fileExists(f),
    readFile: (f) => virtual.get(normalize(f)) ?? base.readFile(f),
    directoryExists: (d) =>
      normalize(d) === normalize(VIRTUAL_DIR) || (base.directoryExists ? base.directoryExists(d) : true),
    getSourceFile: (fileName, languageVersion, onError, shouldCreate) => {
      const v = virtual.get(normalize(fileName));
      if (v !== undefined) {
        return ts.createSourceFile(
          fileName,
          v,
          languageVersion,
          true,
          fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
        );
      }
      const key = `${normalize(fileName)}|${JSON.stringify(languageVersion)}`;
      const cached = sourceCache.get(key);
      if (cached) return cached;
      const sf = base.getSourceFile(fileName, languageVersion, onError, shouldCreate);
      if (sf) sourceCache.set(key, sf);
      return sf;
    },
  };

  const rootNames = [...ids.map((id) => path.join(VIRTUAL_DIR, `${id}.tsx`)), CONTRACT_FILE];
  const program = ts.createProgram({
    rootNames,
    options: TYPECHECK_OPTIONS,
    host,
    ...(previousProgram ? { oldProgram: previousProgram } : {}),
  });
  previousProgram = program;

  const errors: SceneTypeError[] = [];
  for (const id of ids) {
    const sf = program.getSourceFile(path.join(VIRTUAL_DIR, `${id}.tsx`));
    if (!sf) {
      errors.push({ sceneId: id, message: "файл сцени не завантажився", line: null, column: null, code: 0 });
      continue;
    }
    const diags = [...program.getSyntacticDiagnostics(sf), ...program.getSemanticDiagnostics(sf)];
    for (const d of diags) {
      if (d.category !== ts.DiagnosticCategory.Error) continue;
      errors.push(toError(id, d));
    }
  }

  // Контракт default export: помилки службового файлу → сцена за номером рядка.
  const contractSf = program.getSourceFile(CONTRACT_FILE);
  if (contractSf) {
    for (const d of program.getSemanticDiagnostics(contractSf)) {
      if (d.category !== ts.DiagnosticCategory.Error || d.start === undefined) continue;
      const line = contractSf.getLineAndCharacterOfPosition(d.start).line + 1;
      const sceneId =
        contract.lineToScene.get(line) ??
        ids.find((id) => contractSf.text.split("\n")[line - 1]?.includes(`Scene_${id}`)) ??
        null;
      if (!sceneId) continue;
      // Відсутній default export уже видно як помилку імпорту — додаємо пояснення контракту.
      errors.push({
        sceneId,
        message: `контракт сцени: default export має бути \`function Scene(props: SceneProps)\` — ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`,
        line: null,
        column: null,
        code: d.code,
      });
    }
  }

  const byScene: Record<string, SceneTypeError[]> = {};
  for (const e of errors) byScene[e.sceneId] = [...(byScene[e.sceneId] ?? []), e];
  return { ok: errors.length === 0, errors, byScene, durationMs: Date.now() - started };
}

/** Помилки сцени одним текстом (для промпта `code-fix`). */
export function formatTypeErrors(errors: readonly SceneTypeError[]): string {
  return errors
    .map((e) => `${e.line !== null ? `рядок ${e.line}:${e.column ?? 0} ` : ""}TS${e.code}: ${e.message}`)
    .join("\n");
}
