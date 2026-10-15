import { describe, expect, it } from "vitest";
import {
  effectiveVerdict,
  FilmReviewDraft,
  QaIssueKind,
  ReviewIssue,
  ReviewKind,
  routeOf,
  StoryboardCheckpointPayload,
} from "../src/index.ts";

const issue = (kind: ReviewKind, severity: "minor" | "major" | "critical") =>
  ReviewIssue.parse({ scope: "scene", sceneId: "s1", severity, kind, description: "d", fix: "f" });

describe("routeOf", () => {
  it("візуальні, склейки, ритм і темп → fix", () => {
    for (const k of QaIssueKind.options) expect(routeOf(k)).toBe("fix");
    for (const k of ["join_break", "throughline_lost", "rhythm", "pace"] as const) {
      expect(routeOf(k)).toBe("fix");
    }
  });
  it("sfx_* → sfx, music_* → music", () => {
    for (const k of ReviewKind.options.filter((x) => x.startsWith("sfx_"))) expect(routeOf(k)).toBe("sfx");
    expect(routeOf("music_mismatch")).toBe("music");
    expect(routeOf("music_level")).toBe("music");
  });
});

describe("effectiveVerdict", () => {
  it("fix лише для major/critical з маршрутом fix або sfx", () => {
    expect(effectiveVerdict([])).toBe("pass");
    expect(effectiveVerdict([issue("clipped_text", "minor"), issue("sfx_missing", "minor")])).toBe("pass");
    expect(effectiveVerdict([issue("music_level", "critical")])).toBe("pass");
    expect(effectiveVerdict([issue("join_break", "major")])).toBe("fix");
    expect(effectiveVerdict([issue("sfx_off_beat", "critical")])).toBe("fix");
  });
});

describe("FilmReviewDraft", () => {
  it("парсить дефолти зауваження і межі оцінки", () => {
    const r = FilmReviewDraft.parse({
      verdict: "fix",
      score: 6,
      summary: "s",
      issues: [{ scope: "film", sceneId: null, severity: "major", kind: "pace", description: "d", fix: "f" }],
    });
    expect(r.issues[0]).toMatchObject({ nextSceneId: null, eventId: null, frame: null, format: null });
    expect(() => FilmReviewDraft.parse({ verdict: "pass", score: 11, issues: [], summary: "" })).toThrow();
  });
});

describe("StoryboardCheckpointPayload.review", () => {
  const base = {
    checkpoint: "storyboard",
    primaryFormat: "vertical",
    stills: [],
    sheets: [],
    warnings: [],
    templateScenes: [],
    music: null,
    changedScenes: null,
  } as const;
  it("стара подія без review парситься; null і зауваження з маршрутом зберігаються", () => {
    expect(StoryboardCheckpointPayload.parse(base).review).toBeUndefined();
    expect(StoryboardCheckpointPayload.parse({ ...base, review: null }).review).toBeNull();
    const review = { score: 7, summary: "s", issues: [{ ...issue("join_break", "major"), route: "fix" }] };
    expect(StoryboardCheckpointPayload.parse({ ...base, review }).review).toEqual(review);
  });
});
