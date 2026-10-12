import {
  CheckReport,
  countSerious,
  type Format,
  type ImageInput,
  inputsHash,
  type QaIssue,
  QaReport,
  revPaths,
  STILL_PLAN,
  type Stage,
  type StageContext,
  StageError,
  type Storage,
  type Storyboard,
  sha256,
  stripFrames,
} from "@adc/shared";
import sharp from "sharp";
import { z } from "zod";
import {
  baseRevOf,
  directorPaths,
  formatsOf,
  llmStageError,
  progress,
  readCurrentBrandKit,
  readOptional,
  readProject,
  readStoryboard,
  readTemplateScenes,
} from "../io.ts";
import { writeScenesIndex } from "../job.ts";
import { readLedger, rejectedScenes, type SceneLedger, type SceneVersion, writeLedger } from "../ledger.ts";
import { buildSceneImage, QA_IMAGE_MAX_SIDE, type SheetCell } from "../sheets.ts";
import { rebuildSheets, replaceSceneData, STRIP_STEP, versionStripSheet } from "./check.ts";

export const QA_PROMPT = "qa";

export const QaMeta = z.object({ inputsHash: z.string() });

/** Зображення для image block: JPEG, довша сторона ≤ `QA_IMAGE_MAX_SIDE`. */
export async function toQaJpeg(png: Buffer): Promise<ImageInput> {
  const data = await sharp(png)
    .resize(QA_IMAGE_MAX_SIDE, QA_IMAGE_MAX_SIDE, { fit: "inside", withoutEnlargement: true })
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .jpeg({ quality: 85 })
    .toBuffer();
  return { mediaType: "image/jpeg", data };
}

/** Зображення сцени в одному форматі для QA і fix. */
export interface QaSceneImage {
  sceneId: string;
  format: Format;
  /** `strip` — аркуш стрічки сцени; `stills` — запасні кадри 25/50/90% (аркуша стрічки немає). */
  kind: "strip" | "stills";
  /** JPEG, довша сторона ≤ `QA_IMAGE_MAX_SIDE`. */
  image: ImageInput;
  /** Хеш вмісту зображення — для хешу входів. */
  hash: string;
  /** Що на зображенні (без номера «Image k»). */
  legend: string;
}

const FRAMES_LEGEND = STILL_PLAN.map((p) => Math.round(p.fraction * 100)).join("/");

/** Легенда аркуша стрічки: кадри і як читати підписи. */
export function stripLegend(sceneId: string, format: Format, durationFrames: number, fps: number): string {
  const frames = stripFrames(durationFrames, STRIP_STEP);
  const step = Math.round((STRIP_STEP / fps) * 10) / 10;
  return (
    `scene ${sceneId}, format ${format}, strip of ${frames.length} frames every ${STRIP_STEP} frames ` +
    `(${step} s), left to right, top to bottom: ${frames.join(", ")}; label = frame · seconds from scene start`
  );
}

/**
 * Зображення для QA: на кожну сцену зі scope і кожен формат — аркуш стрічки (`revPaths.stripSheet`),
 * а якщо його немає (check.json до появи стрічки) або формат має runtime-помилку — одне зображення з
 * кадрами e/a/b. Сцена/формат без жодного стілу (помилка рендера) пропускається; відсутній окремий
 * кадр (напр., check.json без `e`) — сіра перекреслена клітинка.
 */
export async function qaSceneImages(
  storage: Storage,
  check: CheckReport,
  scope: readonly string[],
  formats: readonly Format[],
  storyboard: Pick<Storyboard, "fps" | "scenes">,
  paths: Pick<ReturnType<typeof revPaths>, "stripSheet">,
): Promise<QaSceneImage[]> {
  const out: QaSceneImage[] = [];
  for (const sceneId of scope) {
    const scene = storyboard.scenes.find((s) => s.id === sceneId);
    for (const format of formats) {
      const own = check.stills.filter((s) => s.sceneId === sceneId && s.format === format);
      if (own.length === 0) continue;
      const failed = check.runtimeErrors.some((e) => e.sceneId === sceneId && e.format === format);
      const sheetKey = paths.stripSheet(format, sceneId);
      if (scene && !failed && (await storage.exists(sheetKey))) {
        const data = await storage.read(sheetKey);
        out.push({
          sceneId,
          format,
          kind: "strip",
          image: await toQaJpeg(data),
          hash: sha256(data),
          legend: stripLegend(sceneId, format, scene.durationFrames, storyboard.fps),
        });
        continue;
      }
      const cells: SheetCell[] = [];
      const stills: Array<string | null> = [];
      for (const { variant, fraction } of STILL_PLAN) {
        const still = own.find((s) => s.variant === variant);
        const png = still && (await storage.exists(still.path)) ? await storage.read(still.path) : null;
        stills.push(png ? sha256(png) : null);
        cells.push({
          sceneId,
          variant,
          png,
          label: `${sceneId} · ${Math.round(fraction * 100)}%${still ? ` · кадр ${still.frame}` : ""}`,
          note: "немає кадру",
        });
      }
      if (stills.every((h) => h === null)) continue;
      out.push({
        sceneId,
        format,
        kind: "stills",
        image: await toQaJpeg(await buildSceneImage(format, cells)),
        hash: sha256(stills.join("|")),
        legend: `scene ${sceneId}, format ${format}, frames ${FRAMES_LEGEND}%`,
      });
    }
  }
  return out;
}

const round = (x: number, digits: number) => Math.round(x * 10 ** digits) / 10 ** digits;

/**
 * Скорочений storyboard для арт-директора: концепт, а по сцені — задум (`motionIntent`), тексти
 * в кадрі (`items`) і моменти (`events`) з кадрами й секундами від початку сцени.
 */
export function qaStoryboard(storyboard: Storyboard, templates: ReadonlySet<string>) {
  const { fps } = storyboard;
  const lastId = storyboard.scenes.at(-1)?.id;
  return {
    concept: storyboard.concept,
    hook: storyboard.hook,
    fps,
    scenes: storyboard.scenes.map((s) => ({
      id: s.id,
      purpose: s.purpose,
      final: s.id === lastId,
      durationSec: round(s.durationFrames / fps, 1),
      durationFrames: s.durationFrames,
      text: { headline: s.text.headline, sub: s.text.sub },
      items: s.items.map((i) => ({ id: i.id, role: i.role, text: i.text, group: i.group })),
      events: s.events.map((e) => ({
        id: e.id,
        at: e.at,
        atSec: round(e.at / fps, 2),
        what: e.what,
        sound: e.sound?.cue ?? null,
        textIds: e.textIds,
      })),
      layoutIntent: s.layoutIntent,
      motionIntent: s.motionIntent,
      transitionIn: s.transitionIn,
      assetIds: s.assetIds,
      template: templates.has(s.id),
    })),
  };
}

/**
 * Критерії рубрики «Showreel bar» (`prompts/qa.md`) → kind зауваження: макет, фон і колір — `off_brief`,
 * заповненість моків — `placeholder`. Оцінки живуть лише в `description` (`QaReport` не змінюється).
 */
export const SHOWREEL_CRITERIA = {
  layout: "off_brief",
  background: "off_brief",
  mocks: "placeholder",
  colour: "off_brief",
} as const satisfies Record<string, QaIssue["kind"]>;
export type ShowreelCriterion = keyof typeof SHOWREEL_CRITERIA;

/** Оцінка ≤ цього порогу — зауваження `major`, вище — лише згадка (не тягне сцену на fix). */
export const SHOWREEL_FIX_MAX_SCORE = 2;

const SHOWREEL_RE = /^\s*showreel bar\s*[·:—–-]?\s*(layout|background|mocks|colou?r)\s+([1-5])\s*\/\s*5/i;

/** Оцінка з опису зауваження `Showreel bar · <criterion> <score>/5: …`; null — це не оцінка рубрики. */
export function showreelScore(description: string): { criterion: ShowreelCriterion; score: number } | null {
  const m = SHOWREEL_RE.exec(description);
  if (!m?.[1] || !m[2]) return null;
  const name = m[1].toLowerCase();
  return { criterion: (name === "color" ? "colour" : name) as ShowreelCriterion, score: Number(m[2]) };
}

/**
 * Рубрика «Showreel bar» кодом, щоб вердикт не залежав від того, як модель поставила severity:
 * оцінка ≤ 2 → `major` (critical лишається) і kind свого критерію; оцінка 3–5 → `minor`;
 * на сцену й критерій лишається одне зауваження — з найнижчою оцінкою (перше за рівності).
 * Решта зауважень — без змін і в тому ж порядку.
 */
export function applyShowreelRubric(issues: readonly QaIssue[]): QaIssue[] {
  const best = new Map<string, { index: number; score: number }>();
  issues.forEach((issue, index) => {
    const s = showreelScore(issue.description);
    if (!s) return;
    const key = `${issue.sceneId}\0${s.criterion}`;
    const prev = best.get(key);
    if (!prev || s.score < prev.score) best.set(key, { index, score: s.score });
  });
  const out: QaIssue[] = [];
  issues.forEach((issue, index) => {
    const s = showreelScore(issue.description);
    if (!s) {
      out.push(issue);
      return;
    }
    if (best.get(`${issue.sceneId}\0${s.criterion}`)?.index !== index) return;
    out.push(
      s.score <= SHOWREEL_FIX_MAX_SCORE
        ? {
            ...issue,
            kind: SHOWREEL_CRITERIA[s.criterion],
            severity: issue.severity === "critical" ? "critical" : "major",
          }
        : { ...issue, severity: "minor" },
    );
  });
  return out;
}

export interface RollbackResult {
  /** sceneId → номер версії, до якої повернулись. */
  restored: Record<string, number>;
  written: string[];
}

/**
 * Вибір кращої версії кожної сцени зі `scope`: серед версій, що пройшли guard і check без помилок і
 * мають оцінку qa, лишається та, що має найменше серйозних зауважень (за рівності — поточна).
 * Якщо краща — не поточна, відновлюються її код, стіли, записи check.json і зауваження qa.
 */
export async function keepBestVersions(args: {
  storage: Storage;
  projectId: string;
  rev: number;
  ledger: SceneLedger;
  scope: readonly string[];
  check: CheckReport;
  issues: QaIssue[];
}): Promise<RollbackResult & { issues: QaIssue[] }> {
  const { storage, projectId, rev, ledger, check } = args;
  const rp = revPaths(projectId, rev);
  const dp = directorPaths(projectId, rev);
  let issues = args.issues;
  const restored: Record<string, number> = {};
  const written: string[] = [];
  for (const id of args.scope) {
    const entry = ledger.scenes[id];
    if (!entry) continue;
    const current = entry.versions.find((v) => v.v === entry.current);
    if (!current?.qa) continue;
    const usable = (v: SceneVersion) =>
      v.guardOk &&
      v.qa !== null &&
      v.check !== null &&
      v.check.compileErrors.length === 0 &&
      v.check.runtimeErrors.length === 0;
    const candidates = entry.versions.filter(usable);
    if (candidates.length === 0) continue;
    const best = candidates.reduce((a, b) => {
      const sa = a.qa?.serious ?? Number.POSITIVE_INFINITY;
      const sb = b.qa?.serious ?? Number.POSITIVE_INFINITY;
      if (sa !== sb) return sa < sb ? a : b;
      if (a.v === entry.current) return a;
      if (b.v === entry.current) return b;
      return a.v > b.v ? a : b;
    });
    if (best.v === entry.current || !best.check || !best.qa) continue;
    if ((current.qa.serious ?? 0) <= best.qa.serious && usable(current)) continue;

    const codeKey = dp.version(id, best.v);
    if (!(await storage.exists(codeKey))) continue;
    await storage.copy(codeKey, rp.scene(id));
    written.push(rp.scene(id));
    for (const s of best.check.stills) {
      const copy = dp.versionStill(id, best.v, s.format, s.variant);
      if (await storage.exists(copy)) {
        await storage.copy(copy, s.path);
        written.push(s.path);
      }
    }
    for (const format of new Set(best.check.stills.map((s) => s.format))) {
      const copy = versionStripSheet(projectId, rev, id, best.v, format);
      if (await storage.exists(copy)) {
        await storage.copy(copy, rp.stripSheet(format, id));
        written.push(rp.stripSheet(format, id));
      }
    }
    replaceSceneData(check, id, best.check, true);
    issues = [...issues.filter((i) => i.sceneId !== id), ...best.qa.issues];
    entry.current = best.v;
    restored[id] = best.v;
  }
  return { restored, written, issues };
}

/**
 * Стадія `qa` (арт-директор): аркуші стрічки сцен зі scope (кадри кожні 0.5 с у кожному обраному
 * форматі; запасний варіант — кадри 25/50/90%) + концепт, задум, тексти й моменти сцен + autoIssues →
 * `qa.json`. Сцени поза scope моделі не показуються — повторний QA після fix дешевший.
 * Вердикт — кодом: лишились major/critical → fix. Оцінки «Showreel bar» (у `description`) проходять
 * `applyShowreelRubric`: оцінка ≤ 2 відправляє сцену на fix навіть без дефектів.
 */
export function createQaStage(): Stage<"qa"> {
  return async (ctx: StageContext<"qa">) => {
    const { storage, projectId, rev, logger } = ctx;
    const rp = revPaths(projectId, rev);
    const dp = directorPaths(projectId, rev);
    const project = await readProject(storage, projectId);
    const brandFile = await readCurrentBrandKit(storage, projectId, project);
    const storyboard = await readStoryboard(storage, projectId, rev);
    const formats = formatsOf(project);
    const templates = new Set(await readTemplateScenes(storage, projectId, rev));
    const check = await readOptional(storage, rp.check, (v) => CheckReport.parse(v), logger);
    if (!check) {
      throw new StageError(
        `qa: немає ${rp.check}`,
        "check_missing",
        "Спершу потрібна перевірка кадрів.",
        false,
      );
    }
    const allIds = storyboard.scenes.map((s) => s.id);
    const scope = (ctx.params.sceneIds ?? allIds).filter((id) => allIds.includes(id) && !templates.has(id));
    // Зауваження сцен поза scope: з qa.json цієї ревізії, а в новій ревізії — з ревізії-основи.
    const baseForQa = baseRevOf(project, rev);
    const previous =
      (await readOptional(storage, rp.qa, (v) => QaReport.parse(v), logger)) ??
      (baseForQa !== null
        ? await readOptional(storage, revPaths(projectId, baseForQa).qa, (v) => QaReport.parse(v), logger)
        : null);

    await progress(ctx, "qa", "Перевіряю кадри…");
    const images = await qaSceneImages(storage, check, scope, formats, storyboard, rp);
    if (scope.length > 0 && images.length === 0) {
      throw new StageError(
        "qa: немає стілів сцен для перевірки",
        "sheets_missing",
        "Немає кадрів для перевірки.",
        true,
      );
    }
    const autoIssues = check.autoIssues.filter((i) => scope.includes(i.sceneId));
    const vars = {
      language: project?.language ?? brandFile.identity.language,
      formats: formats.filter((f) => images.some((img) => img.format === f)).join(", ") || "(немає)",
      scope: scope.join(", ") || "(немає)",
      sheetsLegend: images.map((img, i) => `Image ${i + 1}: ${img.legend}`).join("\n") || "(немає зображень)",
      storyboard: qaStoryboard(storyboard, templates),
      palette: brandFile.palette,
      logo: { type: brandFile.logo.type, textFallback: brandFile.logo.textFallback },
      autoIssues,
      failedScenes: [...new Set([...check.compileErrors, ...check.runtimeErrors].map((e) => e.sceneId))],
    };
    const promptHash = ctx.prompts.load(QA_PROMPT, vars).hash;
    const hash = inputsHash({
      images: images.map((img) => [img.sceneId, img.format, img.kind, img.hash]),
      autoIssues,
      scope,
      vars: { ...vars, autoIssues: null },
      prompt: promptHash,
    });

    // Пропуск за хешем входів: ті самі стіли в ревізії-основі.
    const base = baseRevOf(project, rev);
    if (base !== null) {
      const baseMeta = await readOptional(storage, directorPaths(projectId, base).qaMeta, (v) =>
        QaMeta.parse(v),
      );
      const baseQa = await readOptional(storage, revPaths(projectId, base).qa, (v) => QaReport.parse(v));
      if (baseMeta?.inputsHash === hash && baseQa) {
        await storage.writeJson(rp.qa, baseQa);
        await storage.writeJson(dp.qaMeta, { inputsHash: hash });
        return {
          artifacts: [rp.qa],
          outputs: { verdict: baseQa.verdict, seriousScenes: seriousScenes(baseQa.issues) },
          reused: true,
          inputsHash: hash,
        };
      }
    }

    let report: QaReport;
    if (scope.length === 0) {
      report = { verdict: "pass", issues: [], summary: "Немає сцен для перевірки (усі — шаблони)." };
    } else {
      try {
        const res = await ctx.llm.structured(QA_PROMPT, vars, QaReport, {
          images: images.map((img) => img.image),
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        report = res.data;
      } catch (err) {
        return llmStageError(err, "перевірка кадрів");
      }
    }

    // Лише сцени зі scope і обрані формати; зауваження інших сцен — з попереднього qa.json ревізії.
    // Оцінки «Showreel bar» — за рубрикою (≤ 2 → major, інакше minor).
    const fresh = applyShowreelRubric(
      report.issues.filter((i) => scope.includes(i.sceneId) && formats.includes(i.format)),
    );
    const kept = (previous?.issues ?? []).filter(
      (i) => !scope.includes(i.sceneId) && allIds.includes(i.sceneId),
    );
    let issues = [...kept, ...fresh];

    // Журнал версій: оцінка поточної версії і вибір кращої.
    const ledger = await readLedger(storage, projectId, rev);
    for (const id of scope) {
      const entry = ledger.scenes[id];
      const ver = entry?.versions.find((v) => v.v === entry.current);
      if (ver) {
        const own = fresh.filter((i) => i.sceneId === id);
        ver.qa = { serious: countSerious(own), issues: own };
      }
    }
    const rollback = await keepBestVersions({ storage, projectId, rev, ledger, scope, check, issues });
    issues = rollback.issues;
    const artifacts = new Set<string>(rollback.written);
    if (Object.keys(rollback.restored).length > 0) {
      logger.info("qa: повернуто кращі версії сцен", { restored: rollback.restored });
      for (const k of await rebuildSheets(storage, projectId, rev, allIds, formats, check)) artifacts.add(k);
      await storage.writeJson(rp.check, CheckReport.parse(check));
      artifacts.add(rp.check);
      artifacts.add(
        (
          await writeScenesIndex(storage, projectId, rev, storyboard, [
            ...rejectedScenes(ledger),
            ...templates,
          ])
        ).key,
      );
    }
    if (Object.keys(ledger.scenes).length) artifacts.add(await writeLedger(storage, projectId, rev, ledger));

    // Вердикт детермінований: лишились серйозні зауваження (major/critical) → fix.
    const final: QaReport = QaReport.parse({
      verdict: countSerious(issues) > 0 ? "fix" : "pass",
      issues,
      summary: report.summary,
    });
    await storage.writeJson(rp.qa, final);
    await storage.writeJson(dp.qaMeta, { inputsHash: hash });
    artifacts.add(rp.qa);

    return {
      artifacts: [...artifacts],
      outputs: { verdict: final.verdict, seriousScenes: seriousScenes(final.issues) },
      inputsHash: hash,
    };
  };
}

function seriousScenes(issues: readonly QaIssue[]): string[] {
  return [...new Set(issues.filter((i) => i.severity !== "minor").map((i) => i.sceneId))];
}

export const qaStage: Stage<"qa"> = createQaStage();
