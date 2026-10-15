import {
  FilmReview,
  type LocalStorage,
  type MockReply,
  noopLogger,
  type QaReport,
  type ReviewIssue,
  readTuning,
  revPaths,
} from "@adc/shared";
import { describe, expect, it } from "vitest";
import { createCheckStage } from "../src/stages/check.ts";
import { codegenStage } from "../src/stages/codegen.ts";
import { createFixStage, describeProblems, reviewIssuesFor } from "../src/stages/fix.ts";
import {
  exampleSources,
  fileBlocks,
  makeCtx,
  PROJECT_ID,
  type Reply,
  seedProject,
  tmpStorage,
  userText,
} from "./helpers.ts";
import { movingEngine } from "./strip-engine.ts";

const ex = exampleSources();
const CODE: Record<string, string> = { s1: ex["hook-photo"], s2: ex["offer-price"], s3: ex["cta-logo"] };

type Params = {
  output_config?: { effort?: string };
  messages: Array<{ content: Array<{ type: string; text?: string }> }>;
};
const sceneOf = (params: unknown) => /Repair scene (\w+) /.exec(userText(params))?.[1];
const images = (p: unknown) => ((p as Params).messages[0]?.content ?? []).filter((b) => b.type === "image");

/** Відповіді за сценою з хвоста промпта — не залежать від порядку паралельних викликів. */
function byScene(ids: readonly string[]): Reply[] {
  return ids.map(() => (params: unknown): MockReply => {
    const id = sceneOf(params);
    const code = id ? CODE[id] : undefined;
    if (!id || !code) throw new Error(`немає відповіді для сцени ${id}`);
    return { text: fileBlocks({ [id]: code }) };
  });
}

/** Проєкт (vertical + square) зі згенерованими сценами s1–s3 і check.json зі стрічками. */
async function checked(): Promise<LocalStorage> {
  const storage = tmpStorage();
  await seedProject(storage);
  await codegenStage(
    makeCtx(
      storage,
      "codegen",
      { sceneIds: null, instructions: [] },
      Object.entries(CODE).map(([id, code]) => ({ text: fileBlocks({ [id]: code }) })),
    ),
  );
  await createCheckStage({ engine: movingEngine() })(makeCtx(storage, "check", { sceneIds: null }));
  return storage;
}

const issue = (over: Partial<ReviewIssue> & Pick<ReviewIssue, "kind" | "description">): ReviewIssue => ({
  scope: "scene",
  sceneId: "s1",
  nextSceneId: null,
  eventId: null,
  frame: null,
  format: null,
  severity: "major",
  fix: `${over.kind}: інструкція`,
  ...over,
});

/** Рецензія: склейка s1→s2, своє зауваження s2, чуже s3, звукове s2, музичне на фільм. */
const ISSUES: ReviewIssue[] = [
  issue({
    scope: "join",
    sceneId: "s1",
    nextSceneId: "s2",
    frame: 149,
    kind: "join_break",
    description: "чашка зникає на склейці s1→s2",
    fix: "доведи чашку до центру кадру на останніх 10 кадрах",
  }),
  issue({
    sceneId: "s2",
    frame: 60,
    format: "vertical",
    kind: "off_brief",
    description: "ціна з'являється без чашки",
    fix: "постав ціну на чашку з кадру 30",
  }),
  issue({ sceneId: "s3", kind: "clipped_text", description: "кнопку s3 обрізано" }),
  issue({ sceneId: "s2", eventId: "coins", kind: "sfx_wrong_cue", description: "монети звучать як pop" }),
  issue({ scope: "film", sceneId: null, kind: "music_mismatch", description: "трек надто сумний" }),
];

async function writeReview(storage: LocalStorage, issues: ReviewIssue[] = ISSUES): Promise<void> {
  const review: FilmReview = FilmReview.parse({
    version: 1,
    round: 0,
    inputsHash: "h",
    verdict: "fix",
    score: 6,
    issues,
    summary: "-",
    routes: { fix: ["s1", "s2", "s3"], sfx: ["s2"], music: 1 },
  });
  await storage.writeJson(revPaths(PROJECT_ID, 1).review, review);
}

/** qa.json зі зауваженням s1: для `reason: "review"` воно не потрапляє в промпт. */
async function writeQa(storage: LocalStorage): Promise<void> {
  const report: QaReport = {
    verdict: "fix",
    issues: [
      {
        sceneId: "s1",
        format: "vertical",
        severity: "major",
        kind: "clipped_text",
        description: "заголовок s1 обрізано",
        fix: "зменшити size до lg",
      },
    ],
    summary: "-",
  };
  await storage.writeJson(revPaths(PROJECT_ID, 1).qa, report);
}

const stage = () => createFixStage({ tuning: () => readTuning({ ADC_FIX_CHECK_EFFORT: "low" }) });

describe("fixStage: reason review", () => {
  it("кожна сцена бере лише свої зауваження рецензента (включно з join з обох боків) і свої кадри", async () => {
    const storage = await checked();
    await writeReview(storage);
    await writeQa(storage);
    const ctx = makeCtx(storage, "fix", { sceneIds: ["s1", "s2"], reason: "review" }, byScene(["s1", "s2"]));
    const res = await stage()(ctx);
    expect(res.outputs.sceneIds.sort()).toEqual(["s1", "s2"]);

    const calls = ctx.anthropic.calls.slice(1).map((c) => c.params);
    expect(calls.map(sceneOf).sort()).toEqual(["s1", "s2"]);
    for (const p of calls) {
      const id = sceneOf(p) as string;
      const text = userText(p);
      // кадри сцени в обох форматах, як для qa; effort — frontmatter, не fixCheckEffort
      expect(images(p)).toHaveLength(2);
      expect(text).toContain(`Image 1: scene ${id}, format vertical, strip of`);
      expect(text).toContain(`Image 2: scene ${id}, format square, strip of`);
      expect(text).not.toContain(`Image 3:`);
      expect(text).not.toContain(`scene ${id === "s1" ? "s2" : "s1"}, format`);
      expect((p as Params).output_config?.effort).toBe("high");
      expect(text).toContain("Reason for the fix: review (");
      expect(text).toContain("Film reviewer's remarks");
      // чужі, звукові й музичні зауваження, а також QA — не потрапляють
      expect(text).not.toContain("кнопку s3 обрізано");
      expect(text).not.toContain("монети звучать як pop");
      expect(text).not.toContain("трек надто сумний");
      expect(text).not.toContain("заголовок s1 обрізано");
      expect(text).not.toContain("Art director's remarks");
    }
    const s1 = userText(calls.find((p) => sceneOf(p) === "s1"));
    const s2 = userText(calls.find((p) => sceneOf(p) === "s2"));
    expect(s1).toContain(
      "- [major, frame 149, join_break] чашка зникає на склейці s1→s2 → fix: доведи чашку до центру кадру на останніх 10 кадрах At the join with s2: last state of this scene must become first state of the next.",
    );
    expect(s1).not.toContain("ціна з'являється без чашки");
    expect(s2).toContain(
      "- [major, vertical, frame 60, off_brief] ціна з'являється без чашки → fix: постав ціну на чашку з кадру 30",
    );
    expect(s2).toContain(
      "- [major, frame 149 of s1, join_break] чашка зникає на склейці s1→s2 → fix: доведи чашку до центру кадру на останніх 10 кадрах At the join with s1 (it comes before this scene): first state of this scene must continue the last state of s1.",
    );
    expect(s2.indexOf("Image 1:")).toBeLessThan(s2.indexOf("Film reviewer's remarks"));
  });

  it("без review.json — попередження в лог, фікс лише за автоперевірками", async () => {
    const storage = await checked();
    const ctx = makeCtx(storage, "fix", { sceneIds: ["s3"], reason: "review" }, byScene(["s3"]));
    const warnings: string[] = [];
    ctx.logger = { ...noopLogger, warn: (msg) => void warnings.push(msg) };
    const res = await stage()(ctx);
    expect(res.outputs.sceneIds).toEqual(["s3"]);
    expect(warnings).toContain("fix: немає review.json — фікс без зауважень рецензента");
    const text = userText(ctx.anthropic.calls[0]?.params);
    expect(text).not.toContain("Film reviewer's remarks");
    expect(images(ctx.anthropic.calls[0]?.params)).toHaveLength(2);
  });
});

describe("зауваження рецензента для fix", () => {
  it("reviewIssuesFor: маршрут fix, сцена — sceneId або nextSceneId склейки", () => {
    const review = { issues: ISSUES };
    expect(reviewIssuesFor(review, "s1").map((i) => i.kind)).toEqual(["join_break"]);
    expect(reviewIssuesFor(review, "s2").map((i) => i.kind)).toEqual(["join_break", "off_brief"]);
    expect(reviewIssuesFor(review, "s3").map((i) => i.kind)).toEqual(["clipped_text"]);
    expect(reviewIssuesFor(null, "s1")).toEqual([]);
    // nextSceneId рахується лише для join
    const odd = issue({ sceneId: "s1", nextSceneId: "s2", kind: "pace", description: "-" });
    expect(reviewIssuesFor({ issues: [odd] }, "s2")).toEqual([]);
  });

  it("describeProblems: зауваження рецензента лише для reason review; склейка з останньої сцени — без хвоста", () => {
    const review = {
      issues: [issue({ scope: "join", sceneId: "s3", kind: "join_break", description: "фінал обривається" })],
    };
    const base = { sceneId: "s3", check: null, qa: null, review, guardViolations: [] };
    expect(describeProblems({ ...base, reason: "review" })).toBe(
      "Film reviewer's remarks (from watching the whole film, frames are local to the scene named):\n" +
        "- [major, join_break] фінал обривається → fix: join_break: інструкція",
    );
    expect(describeProblems({ ...base, reason: "qa" })).not.toContain("фінал обривається");
    expect(describeProblems({ ...base, reason: "check" })).not.toContain("фінал обривається");
  });
});
