/**
 * `@adc/director` — режисура: сценарій, код сцен, перевірка, фікси, QA, правки (блок B4).
 *
 * Стадії (`Stage<S>` з `@adc/shared`): storyboardStage, codegenStage, createCheckStage({engine}),
 * fixStage, qaStage, reviseStage. Для рендер-стадії воркера — prepareRenderJob.
 * Чисті хелпери: normalizeStoryboard, verifyClaims, guardScene, typecheckScenes.
 * Для стадії `author` (`@adc/author`) — без зміни реалізацій: guard/typecheck, авто-перевірки й
 * аркуші check, контекст і бренд codegen, журнал версій, реєстр сцен, розбір файлових блоків.
 */

export { extractClaims, verifyClaims } from "./claims.ts";
export { type CodegenContext, contextVars, loadCodegenContext } from "./context.ts";
export { parseFileBlocks, parseSingleScene, scenesIndexSource } from "./files.ts";
export {
  ALLOWED_MODULES,
  FORBIDDEN_GLOBALS,
  FORBIDDEN_TAGS,
  formatViolations,
  type GuardResult,
  type GuardViolation,
  guardScene,
} from "./guard.ts";
export { directorPaths } from "./io.ts";
export {
  type PreparedJob,
  type PrepareRenderJobOptions,
  prepareJob,
  prepareRenderJob,
  scenePreviewProps,
  writeScenesIndex,
} from "./job.ts";
export {
  addVersion,
  currentVersion,
  type NewVersion,
  readLedger,
  rejectedScenes,
  type SceneLedger,
  type SceneVersion,
  writeLedger,
} from "./ledger.ts";
export { checkCopy, type NormalizeResult, normalizeStoryboard, type TextIssue } from "./normalize.ts";
export {
  type CheckStageDeps,
  collectAutoIssues,
  createCheckStage,
  rebuildSheets,
  STRIP_STEP,
  versionStripSheet,
} from "./stages/check.ts";
export { brandForCode, type CodegenStageDeps, codegenStage, createCodegenStage } from "./stages/codegen.ts";
export { createFixStage, type FixStageDeps, fixStage } from "./stages/fix.ts";
export { createQaStage, keepBestVersions, qaStage } from "./stages/qa.ts";
export { createReviseStage, type RevisionRecord, reviseStage } from "./stages/revise.ts";
export { createStoryboardStage, storyboardStage } from "./stages/storyboard.ts";
export { type SceneTypeError, type TypecheckResult, typecheckScenes } from "./typecheck.ts";
