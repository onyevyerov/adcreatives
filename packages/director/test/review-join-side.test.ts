import { FilmReview, type ReviewIssue } from "@adc/shared";
import { fixtureStoryboard } from "@adc/shared/fixtures";
import { describe, expect, it } from "vitest";
import { reviewLine, reviewProblemLines } from "../src/review-issues.ts";
import { describeProblems } from "../src/stages/fix.ts";
import { routesOf, sanitizeIssues } from "../src/stages/review.ts";

const sb = fixtureStoryboard;

const issue = (over: Partial<ReviewIssue> & Pick<ReviewIssue, "kind">): ReviewIssue => ({
  scope: "scene",
  sceneId: "s1",
  nextSceneId: null,
  eventId: null,
  frame: null,
  format: null,
  severity: "major",
  description: `${over.kind}: опис`,
  fix: `${over.kind}: інструкція`,
  fixSceneId: null,
  ...over,
});

/** Склейка s2→s3, яку править s3, і власне зауваження s2 (тягне s2 у fix з іншої причини). */
const JOIN = issue({
  scope: "join",
  sceneId: "s2",
  nextSceneId: "s3",
  fixSceneId: "s3",
  kind: "join_break",
  frame: 40,
  description: "чашка зникає на склейці",
  fix: "доведи чашку до центру",
});
const OWN_S2 = issue({ sceneId: "s2", kind: "off_brief", description: "ціна без чашки", fix: "постав ціну" });

describe("sanitizeIssues: fixSceneId", () => {
  const fixSides = (issues: ReviewIssue[], templates: ReadonlySet<string> = new Set()) =>
    sanitizeIssues(sb, issues, templates, true).kept.map((i) => i.fixSceneId);

  it("join — sceneId або нормалізований nextSceneId; інше → null; scene і film → null", () => {
    expect(
      fixSides([
        issue({ scope: "join", sceneId: "s2", fixSceneId: "s3", kind: "join_break" }),
        issue({ scope: "join", sceneId: "s2", fixSceneId: "s2", kind: "join_break" }),
        issue({ scope: "join", sceneId: "s2", fixSceneId: "s9", kind: "join_break" }),
        issue({ scope: "join", sceneId: "s2", fixSceneId: null, kind: "join_break" }),
        // модель назвала не ту наступну сцену: fixSceneId рахується від нормалізованої
        issue({ scope: "join", sceneId: "s1", nextSceneId: "s7", fixSceneId: "s7", kind: "join_break" }),
        issue({ scope: "join", sceneId: "s1", nextSceneId: "s7", fixSceneId: "s2", kind: "join_break" }),
        // остання сцена: склейки немає, правити можна лише її
        issue({ scope: "join", sceneId: "s3", fixSceneId: "s3", kind: "join_break" }),
        issue({ sceneId: "s1", fixSceneId: "s1", kind: "off_brief" }),
        issue({ scope: "film", sceneId: null, fixSceneId: "s1", kind: "pace" }),
      ]),
    ).toEqual(["s3", "s2", null, null, null, "s2", "s3", null, null]);
  });

  it("названа template-сторона → інша сторона", () => {
    expect(
      fixSides(
        [
          issue({ scope: "join", sceneId: "s2", fixSceneId: "s3", kind: "join_break" }),
          issue({ scope: "join", sceneId: "s1", fixSceneId: "s1", kind: "join_break" }),
        ],
        new Set(["s3", "s1"]),
      ),
    ).toEqual(["s2", "s2"]);
  });

  it("вхід не мутується", () => {
    const raw = issue({ scope: "join", sceneId: "s2", fixSceneId: "s9", kind: "join_break" });
    sanitizeIssues(sb, [raw], new Set(), true);
    expect(raw.fixSceneId).toBe("s9");
  });
});

describe("routesOf: режим склейок", () => {
  const routes = (issues: ReviewIssue[], joinSide?: "both" | "one") =>
    routesOf(sb, issues, new Set(), joinSide);

  it("both (і дефолт) — обидві сторони, як до перемикача", () => {
    expect(routes([JOIN])).toEqual({ fix: ["s2", "s3"], sfx: [], music: 0 });
    expect(routes([JOIN], "both")).toEqual(routes([JOIN]));
  });

  it("one + fixSceneId — лише ця сцена; інша сторона — лише з власними major/critical", () => {
    expect(routes([JOIN], "one").fix).toEqual(["s3"]);
    expect(routes([JOIN, OWN_S2], "one").fix).toEqual(["s2", "s3"]);
    expect(routes([JOIN, { ...OWN_S2, severity: "minor" }], "one").fix).toEqual(["s3"]);
  });

  it("one без fixSceneId — обидві сторони; маршрут sfx не змінюється", () => {
    expect(routes([{ ...JOIN, fixSceneId: null }], "one").fix).toEqual(["s2", "s3"]);
    const sfx = issue({
      scope: "join",
      sceneId: "s1",
      nextSceneId: "s2",
      fixSceneId: "s2",
      kind: "sfx_excess",
    });
    expect(routes([sfx], "one")).toEqual({ fix: [], sfx: ["s1", "s2"], music: 0 });
  });
});

describe("зауваження рецензента для fix: режим склейок", () => {
  const S3_LINE =
    "- [major, frame 40 of s2, join_break] чашка зникає на склейці → fix: доведи чашку до центру At the join with s2 (it comes before this scene): first state of this scene must continue the last state of s2.";
  const S2_LINE =
    "- [major, frame 40, join_break] чашка зникає на склейці → fix: доведи чашку до центру At the join with s3: last state of this scene must become first state of the next.";
  const HEAD = "Film reviewer's remarks (from watching the whole film, frames are local to the scene named):";

  it("both і старий review.json (без joinSide) — рядки як до перемикача", () => {
    for (const joinSide of [undefined, "both"] as const) {
      expect(reviewLine(JOIN, "s3", joinSide)).toBe(S3_LINE);
      expect(reviewLine(JOIN, "s2", joinSide)).toBe(S2_LINE);
    }
    expect(reviewProblemLines({ issues: [JOIN, OWN_S2] }, "s2")).toEqual([
      HEAD,
      S2_LINE,
      "- [major, off_brief] ціна без чашки → fix: постав ціну",
    ]);
  });

  it("one: сцена fixSceneId — рядок свого боку; друга сторона — «keep your … frames»", () => {
    const review = { issues: [JOIN, OWN_S2], joinSide: "one" as const };
    expect(reviewProblemLines(review, "s3")).toEqual([HEAD, S3_LINE]);
    expect(reviewProblemLines(review, "s2")).toEqual([
      HEAD,
      "- [major, join] At the cut with s3 the other scene is changed to match you: keep your last frames exactly as they are.",
      "- [major, off_brief] ціна без чашки → fix: постав ціну",
    ]);
    // править попередня сцена — наступна тримає свої перші кадри
    const before = { ...JOIN, fixSceneId: "s2", severity: "critical" as const };
    expect(reviewLine(before, "s3", "one")).toBe(
      "- [critical, join] At the cut with s2 the other scene is changed to match you: keep your first frames exactly as they are.",
    );
    expect(reviewLine(before, "s2", "one")).toBe(S2_LINE.replace("[major,", "[critical,"));
  });

  it("one без fixSceneId — обидві сторони отримують рядок як у both", () => {
    const loose = { ...JOIN, fixSceneId: null };
    expect(reviewLine(loose, "s2", "one")).toBe(S2_LINE);
    expect(reviewLine(loose, "s3", "one")).toBe(S3_LINE);
  });

  it("describeProblems (fix) бачить joinSide повного review.json", () => {
    const review = FilmReview.parse({
      version: 1,
      round: 0,
      inputsHash: "h",
      verdict: "fix",
      score: 6,
      issues: [JOIN, OWN_S2],
      summary: "-",
      routes: { fix: ["s2", "s3"], sfx: [], music: 0 },
      joinSide: "one",
    });
    const text = describeProblems({
      sceneId: "s2",
      reason: "review",
      check: null,
      qa: null,
      review,
      guardViolations: [],
    });
    expect(text).toContain("keep your last frames exactly as they are.");
    expect(text).not.toContain("доведи чашку до центру");
  });
});
