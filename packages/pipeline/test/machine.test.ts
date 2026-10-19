import {
  type PipelineCommand,
  type ProjectState,
  type ProjectStatus,
  type ReviewIssue,
  type StageDoneEvent,
  type StageName,
  type StageOutputsMap,
  t,
} from "@adc/shared";
import { fixtureProject } from "@adc/shared/fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type MachineState,
  nextStep,
  type StepContext,
  type StepInput,
  type StepResult,
} from "../src/machine.ts";
import { emptyPipe, type JobRecord, PipeState } from "../src/pipe.ts";
import { Harness, intent } from "./helpers.ts";

const NOW = "2026-10-06T12:00:00.000Z";
/**
 * Базові сценарії — у режимі звуку `storyboard` (як до звукорежисера): таблиці переходів не залежать
 * від `ADC_SFX_MODE`. Режим `designer` (звукорежисер і рецензент) — окремий блок наприкінці.
 */
const ctx = (over: Partial<StepContext> = {}): StepContext => ({ now: NOW, sfxMode: "storyboard", ...over });

function state(status: ProjectStatus, over: Partial<ProjectState> = {}, pipe: Partial<PipeState> = {}) {
  return {
    project: fixtureProject({ status, ...over }),
    pipe: { ...emptyPipe(), ...pipe },
  } satisfies MachineState;
}

let cmdN = 0;
function cmd(c: Record<string, unknown> & { type: PipelineCommand["type"] }): StepInput {
  cmdN += 1;
  return {
    kind: "command",
    command: { projectId: "p1", commandId: `c${cmdN}`, issuedAt: NOW, ...c } as PipelineCommand,
  };
}

function msg(text: string, parsed = intent(), deferred = false): StepInput {
  return { ...cmd({ type: "user_message", text, messageId: `m${cmdN}` }), intent: parsed, deferred };
}

/** Додає в стан незавершений job і повертає подію його завершення. */
function running<S extends StageName>(
  s: MachineState,
  stage: S,
  params: Record<string, unknown> = {},
  outputs: Partial<StageOutputsMap[S]> = {},
  opts: { rev?: number; fail?: boolean; retryable?: boolean } = {},
): StepInput {
  const rev = opts.rev ?? s.project.rev;
  // Якщо машина вже поставила job цієї стадії — завершуємо саме його.
  const existing = s.pipe.outstanding.find(
    (j) =>
      j.stage === stage &&
      (Object.keys(params).length === 0 || JSON.stringify(j.params) === JSON.stringify(params)),
  );
  const jobId = existing?.jobId ?? `p1.${stage}.r${rev}.t${s.pipe.outstanding.length + 1}`;
  if (!existing) s.pipe.outstanding.push({ jobId, projectId: "p1", rev, stage, attempt: 1, params });
  const common = { projectId: "p1", rev, stage, attempt: 1, jobId, durationMs: 500 };
  const event = opts.fail
    ? {
        ...common,
        type: "stage_failed" as const,
        error: {
          code: "x",
          message: "tech",
          userMessage: "Збій сервісу.",
          retryable: opts.retryable ?? true,
        },
      }
    : { ...common, type: "stage_done" as const, artifacts: [], outputs, reused: false };
  return { kind: "stage_event", event: event as StageDoneEvent };
}

const stages = (r: { jobs: Array<{ stage: string }> }) => r.jobs.map((j) => j.stage);

describe("nextStep — transition table", () => {
  const table: Array<{
    name: string;
    from: () => [MachineState, StepInput, StepContext?];
    status: ProjectStatus;
    jobs: string[];
  }> = [
    {
      name: "intake + start → crawling, crawl",
      from: () => [state("intake"), cmd({ type: "start" })],
      status: "crawling",
      jobs: ["crawl"],
    },
    {
      name: "repeated start is ignored",
      from: () => [state("crawling"), cmd({ type: "start" })],
      status: "crawling",
      jobs: [],
    },
    {
      name: "crawling + crawl done → brandkit",
      from: () => {
        const s = state("crawling");
        return [s, running(s, "crawl", { url: "x", manualText: null }, { partial: false })];
      },
      status: "brandkit",
      jobs: ["brandkit"],
    },
    {
      name: "brandkit + done → awaiting_brand",
      from: () => {
        const s = state("brandkit");
        return [s, running(s, "brandkit", {}, { version: 1 })];
      },
      status: "awaiting_brand",
      jobs: [],
    },
    {
      name: "awaiting_brand + approve → scripting, storyboard",
      from: () => [state("awaiting_brand"), cmd({ type: "approve", rev: null })],
      status: "scripting",
      jobs: ["storyboard"],
    },
    {
      name: "awaiting_brand + set_logo → brandkit, brandkit-patch",
      from: () => [state("awaiting_brand"), cmd({ type: "set_logo", assetId: "a02" })],
      status: "brandkit",
      jobs: ["brandkit-patch"],
    },
    {
      name: "scripting + storyboard done → awaiting_script",
      from: () => {
        const s = state("scripting");
        return [s, running(s, "storyboard")];
      },
      status: "awaiting_script",
      jobs: [],
    },
    {
      name: "awaiting_script + approve (no claims) → directing, codegen + audio",
      from: () => [
        state("awaiting_script"),
        cmd({ type: "approve", rev: null }),
        ctx({ unverifiedClaims: [] }),
      ],
      status: "directing",
      jobs: ["codegen", "audio"],
    },
    {
      name: "awaiting_script + approve with unverified claims → brandkit-patch with facts first",
      from: () => [
        state("awaiting_script"),
        cmd({ type: "approve", rev: null }),
        ctx({ unverifiedClaims: [{ kind: "discount", text: "-20%" }] }),
      ],
      status: "directing",
      jobs: ["brandkit-patch"],
    },
    {
      name: "awaiting_storyboard + approve → rendering, one render per format",
      from: () => [
        state("awaiting_storyboard", { formats: ["vertical", "landscape"] }),
        cmd({ type: "approve", rev: null }),
      ],
      status: "rendering",
      jobs: ["render", "render"],
    },
    {
      name: "busy + approve → ignored",
      from: () => [state("scripting"), cmd({ type: "approve", rev: null })],
      status: "scripting",
      jobs: [],
    },
    {
      name: "delivered + approve → ignored",
      from: () => [state("delivered"), cmd({ type: "approve", rev: null })],
      status: "delivered",
      jobs: [],
    },
    {
      name: "awaiting_script + edit → revising, revise",
      from: () => [
        state("awaiting_script"),
        msg("інший заголовок", intent({ kind: "edit", edits: "інший заголовок" })),
      ],
      status: "revising",
      jobs: ["revise"],
    },
    {
      name: "awaiting_storyboard + edit → revising, revise",
      from: () => [state("awaiting_storyboard"), msg("змінити s2", intent({ kind: "edit", edits: "s2" }))],
      status: "revising",
      jobs: ["revise"],
    },
    {
      name: "delivered + edit → revising, revise",
      from: () => [state("delivered"), msg("змінити s2", intent({ kind: "edit", edits: "s2" }))],
      status: "revising",
      jobs: ["revise"],
    },
    {
      name: "awaiting_brand + brand edit → brandkit, brandkit-patch",
      from: () => [
        state("awaiting_brand"),
        msg("зелений", intent({ kind: "edit", brandEdits: "акцент зелений" })),
      ],
      status: "brandkit",
      jobs: ["brandkit-patch"],
    },
    {
      name: "busy + user_message → deferred, no jobs",
      from: () => [state("directing"), msg("а можна швидше?")],
      status: "directing",
      jobs: [],
    },
    {
      name: "stage_failed → failed",
      from: () => {
        const s = state("scripting");
        return [s, running(s, "storyboard", {}, {}, { fail: true })];
      },
      status: "failed",
      jobs: [],
    },
    {
      name: "restart_confirmed without request → ignored",
      from: () => [state("awaiting_script"), cmd({ type: "restart_confirmed" })],
      status: "awaiting_script",
      jobs: [],
    },
    {
      name: "restart_confirmed after request → crawling, crawl",
      from: () => [state("awaiting_script", { restartRequested: true }), cmd({ type: "restart_confirmed" })],
      status: "crawling",
      jobs: ["crawl"],
    },
    {
      name: "retry when not failed → ignored",
      from: () => [state("awaiting_brand"), cmd({ type: "retry" })],
      status: "awaiting_brand",
      jobs: [],
    },
  ];

  for (const row of table) {
    it(row.name, () => {
      const [s, input, c] = row.from();
      const r = nextStep(s, input, c ?? ctx());
      expect(r.state.status).toBe(row.status);
      expect(stages(r)).toEqual(row.jobs);
    });
  }

  it("is pure: input state is not mutated", () => {
    const s = state("awaiting_brand");
    const snapshot = JSON.stringify(s);
    nextStep(s, cmd({ type: "approve", rev: null }), ctx());
    expect(JSON.stringify(s)).toBe(snapshot);
  });
});

describe("nextStep — checkpoints and commands", () => {
  it("start with uploads: crawl first, ingest queued behind it (never concurrent)", () => {
    const r = nextStep(
      state("intake"),
      cmd({ type: "start" }),
      ctx({ uploads: ["projects/p1/uploads/a.jpg"] }),
    );
    expect(stages(r)).toEqual(["crawl"]);
    expect(r.pipe.ioQueue).toEqual([{ stage: "ingest", params: { files: ["projects/p1/uploads/a.jpg"] } }]);
    expect(r.state.input.url).toBe("https://zerno.example.com/");
    expect(r.jobs[0]?.params).toEqual({ url: "https://zerno.example.com/", manualText: null });
  });

  it("crawl done with queued ingest: ingest runs before brandkit", () => {
    const s = state("crawling", {}, { ioQueue: [{ stage: "ingest", params: { files: ["u.jpg"] } }] });
    const r1 = nextStep(s, running(s, "crawl"), ctx());
    expect(r1.state.status).toBe("crawling");
    expect(stages(r1)).toEqual(["ingest"]);
    const s2 = { project: r1.state, pipe: r1.pipe };
    const ingestJob = r1.pipe.outstanding[0] as JobRecord;
    const r2 = nextStep(
      s2,
      {
        kind: "stage_event",
        event: {
          projectId: "p1",
          rev: 1,
          stage: "ingest",
          attempt: 1,
          jobId: ingestJob.jobId,
          durationMs: 1,
          type: "stage_done",
          artifacts: [],
          outputs: { assetIds: ["u01"] },
          reused: false,
        },
      },
      ctx(),
    );
    expect(r2.state.status).toBe("brandkit");
    expect(stages(r2)).toEqual(["brandkit"]);
  });

  it("photos_added while crawl runs → queued; while idle → ingest immediately; duplicates skipped", () => {
    const s = state("crawling");
    s.pipe.outstanding.push({ jobId: "j", projectId: "p1", rev: 1, stage: "crawl", attempt: 1, params: {} });
    const r = nextStep(s, cmd({ type: "photos_added", files: ["x.jpg"] }), ctx());
    expect(stages(r)).toEqual([]);
    expect(r.pipe.ioQueue).toHaveLength(1);

    const idle = state("awaiting_script");
    const r2 = nextStep(
      idle,
      cmd({ type: "photos_added", files: ["x.jpg", "projects/p1/uploads/x.jpg"] }),
      ctx(),
    );
    expect(stages(r2)).toEqual(["ingest"]);
    expect(r2.jobs[0]?.params).toEqual({ files: ["projects/p1/uploads/x.jpg"] });
    const r3 = nextStep(
      { project: r2.state, pipe: r2.pipe },
      cmd({ type: "photos_added", files: ["x.jpg"] }),
      ctx(),
    );
    expect(stages(r3)).toEqual([]);
  });

  it("brand approve fills default answers and language from the brand kit", () => {
    const r = nextStep(
      state("awaiting_brand", { answers: { q2: "своє" } }),
      cmd({ type: "approve", rev: null }),
      ctx({
        brand: {
          language: "uk",
          languageVersions: 1,
          questions: [
            { id: "q1", default: "Привести гостей" },
            { id: "q2", default: "дефолт" },
          ],
        },
      }),
    );
    expect(r.state.answers).toEqual({ q1: "Привести гостей", q2: "своє" });
    expect(r.state.language).toBe("uk");
    expect(r.jobs[0]?.params).toEqual({ durationSeconds: null });
  });

  it("approve with a stale rev is ignored with a message", () => {
    const r = nextStep(state("awaiting_script", { rev: 2 }), cmd({ type: "approve", rev: 1 }), ctx());
    expect(r.state.status).toBe("awaiting_script");
    expect(r.events).toContainEqual(expect.objectContaining({ type: "message", text: t("approveIgnored") }));
  });

  it("mixed message is never an approval", () => {
    const r = nextStep(
      state("awaiting_script"),
      msg("так, але ціна 70 грн", intent({ kind: "approve", facts: [{ kind: "price", text: "70 грн" }] })),
      ctx(),
    );
    expect(r.state.status).toBe("revising");
    expect(stages(r)).toEqual(["brandkit-patch"]);
    expect(r.jobs[0]?.params).toEqual({
      instruction: null,
      logoAssetId: null,
      facts: [{ kind: "price", text: "70 грн" }],
    });
    expect(r.pipe.pendingRevise).toEqual({ text: "так, але ціна 70 грн", at: "script" });
    expect(r.events).toContainEqual(expect.objectContaining({ text: t("mixedMessageNotApproval") }));
  });

  it("approve by chat text with answers and formats at checkpoint 1", () => {
    const r = nextStep(
      state("awaiting_brand"),
      msg(
        "так, 9:16 і 16:9",
        intent({
          kind: "approve",
          formats: ["landscape", "vertical"],
          answers: [{ questionId: "q1", answer: "Гості" }],
        }),
      ),
      ctx(),
    );
    expect(r.state.status).toBe("scripting");
    expect(r.state.formats).toEqual(["vertical", "landscape"]);
    expect(r.state.answers.q1).toBe("Гості");
  });

  it("answers-only message at checkpoint 1 saves and stays", () => {
    const r = nextStep(
      state("awaiting_brand"),
      msg("1:1", intent({ kind: "answer", formats: ["square"] })),
      ctx(),
    );
    expect(r.state.status).toBe("awaiting_brand");
    expect(r.state.formats).toEqual(["square"]);
    expect(r.events.some((e) => e.type === "message" && e.text.startsWith("Записав"))).toBe(true);
  });

  it("question → reply effect", () => {
    const r = nextStep(
      state("awaiting_script"),
      msg("скільки це триватиме?", intent({ kind: "question", question: "скільки триватиме?" })),
      ctx(),
    );
    expect(r.effects).toEqual([{ type: "reply", question: "скільки триватиме?" }]);
    expect(r.state.status).toBe("awaiting_script");
  });

  it("restart intent asks for confirmation (button), confirmation restarts with a new revision", () => {
    const r = nextStep(
      state("awaiting_storyboard"),
      msg("почнемо заново", intent({ kind: "restart" })),
      ctx(),
    );
    expect(r.state.restartRequested).toBe(true);
    expect(r.state.status).toBe("awaiting_storyboard");
    expect(r.events).toContainEqual(expect.objectContaining({ buttons: ["restart_confirm"] }));
    const r2 = nextStep({ project: r.state, pipe: r.pipe }, cmd({ type: "restart_confirmed" }), ctx());
    expect(r2.state.status).toBe("crawling");
    expect(r2.state.rev).toBe(2);
    expect(r2.state.revisions[1]).toMatchObject({ n: 2, reason: "restart", basedOn: null });
    expect(r2.state.restartRequested).toBe(false);
  });

  it("busy message is stored and answered with the busy template", () => {
    const r = nextStep(state("rendering"), msg("додайте лого більше"), ctx());
    expect(r.state.pendingMessages).toEqual([
      expect.objectContaining({ text: "додайте лого більше", receivedIn: "rendering" }),
    ]);
    expect(r.events).toContainEqual(expect.objectContaining({ text: t("busy") }));
  });

  it("deferred approve never approves; pending messages are cleared", () => {
    const s = state("awaiting_script", {
      pendingMessages: [{ id: "m1", text: "ок", receivedAt: NOW, receivedIn: "scripting" }],
    });
    const r = nextStep(s, msg("ок", intent({ kind: "approve" }), true), ctx());
    expect(r.state.status).toBe("awaiting_script");
    expect(r.state.pendingMessages).toEqual([]);
    expect(r.events).toContainEqual(expect.objectContaining({ text: t("deferredApproveIgnored") }));
  });

  it("deferred edit at a checkpoint starts a revision", () => {
    const s = state("awaiting_script", {
      pendingMessages: [{ id: "m1", text: "інший CTA", receivedAt: NOW, receivedIn: "scripting" }],
    });
    const r = nextStep(s, msg("інший CTA", intent({ kind: "edit", edits: "інший CTA" }), true), ctx());
    expect(r.state.status).toBe("revising");
    expect(r.state.pendingMessages).toEqual([]);
  });

  it("set_logo outside checkpoint 1 is refused politely", () => {
    const r = nextStep(state("awaiting_script"), cmd({ type: "set_logo", assetId: "a02" }), ctx());
    expect(stages(r)).toEqual([]);
    expect(r.events).toContainEqual(expect.objectContaining({ text: t("logoLocked") }));
  });

  it("emits a state event on each status change", () => {
    const r = nextStep(state("awaiting_brand"), cmd({ type: "approve", rev: null }), ctx());
    expect(r.events[0]).toEqual({ type: "state", status: "scripting", prev: "awaiting_brand", rev: 1 });
  });
});

describe("nextStep — directing: branches, fix and QA limits", () => {
  function directing(): MachineState {
    return state("directing", { branches: { video: "running", audio: "running" } });
  }
  const advance = (s: MachineState, input: StepInput, over: Partial<StepContext> = {}) => {
    const r = nextStep(s, input, ctx(over));
    return { r, s: { project: r.state, pipe: r.pipe } as MachineState };
  };
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("codegen → check(all) → qa(all) → video done; joins with audio → checkpoint 3", () => {
    let s = directing();
    let r: StepResult;
    ({ r, s } = advance(s, running(s, "codegen", {}, { sceneIds: ["s1", "s2"] })));
    expect(r.jobs).toEqual([expect.objectContaining({ stage: "check", params: { sceneIds: null } })]);
    ({ r, s } = advance(s, running(s, "check", {}, { failedScenes: [], issueScenes: [] })));
    expect(r.jobs).toEqual([expect.objectContaining({ stage: "qa", params: { sceneIds: null } })]);
    ({ r, s } = advance(s, running(s, "qa", {}, { verdict: "pass", seriousScenes: [] })));
    expect(r.state.branches.video).toBe("done");
    expect(r.state.status).toBe("directing");
    ({ r, s } = advance(s, running(s, "audio", {}, { planHash: "ph1", reusedMusic: false, mixed: true })));
    expect(r.state.audioPlanHash).toBe("ph1");
    expect(r.state.status).toBe("awaiting_storyboard");
    expect(r.effects).toContainEqual({
      type: "checkpoint",
      checkpoint: "storyboard",
      rev: 1,
      changedScenes: null,
    });
  });

  it("audio first, then video: join waits for both", () => {
    let s = directing();
    let r: StepResult;
    ({ r, s } = advance(s, running(s, "audio", {}, { planHash: "ph2", reusedMusic: true, mixed: true })));
    expect(r.state.status).toBe("directing");
    expect(r.state.audioPlanHash).toBe("ph2");
    ({ r, s } = advance(s, running(s, "qa", {}, { verdict: "pass", seriousScenes: [] })));
    expect(r.state.status).toBe("awaiting_storyboard");
  });

  it("2 compile-fix rounds per scene, then TemplateScene", () => {
    let s = directing();
    let r: StepResult;
    ({ r, s } = advance(s, running(s, "check", {}, { failedScenes: ["s2"], issueScenes: [] })));
    expect(r.jobs).toEqual([
      expect.objectContaining({ stage: "fix", params: { sceneIds: ["s2"], reason: "check" } }),
    ]);
    ({ r, s } = advance(s, running(s, "fix", { sceneIds: ["s2"], reason: "check" }, { sceneIds: ["s2"] })));
    expect(r.jobs).toEqual([expect.objectContaining({ stage: "check", params: { sceneIds: ["s2"] } })]);
    ({ r, s } = advance(s, running(s, "check", {}, { failedScenes: ["s2"], issueScenes: [] })));
    expect(stages(r)).toEqual(["fix"]);
    expect(r.pipe.fixRounds.s2).toBe(2);
    ({ r, s } = advance(s, running(s, "fix", { sceneIds: ["s2"], reason: "check" }, { sceneIds: ["s2"] })));
    ({ r, s } = advance(s, running(s, "check", {}, { failedScenes: ["s2"], issueScenes: [] })));
    expect(r.pipe.templateScenes).toEqual(["s2"]);
    expect(r.jobs).toEqual([expect.objectContaining({ stage: "qa", params: { sceneIds: null } })]);
  });

  it("qaMaxRounds: 1 — one QA round: fix(qa) → check → qa(changed only) → done regardless of verdict", () => {
    let s = directing();
    let r: StepResult;
    const one = { qaMaxRounds: 1 };
    ({ r, s } = advance(s, running(s, "qa", {}, { verdict: "fix", seriousScenes: ["s1", "s3"] }), one));
    expect(r.jobs).toEqual([
      expect.objectContaining({ stage: "fix", params: { sceneIds: ["s1", "s3"], reason: "qa" } }),
    ]);
    expect(r.pipe.qaRounds).toBe(1);
    ({ r, s } = advance(
      s,
      running(s, "fix", { sceneIds: ["s1", "s3"], reason: "qa" }, { sceneIds: ["s1", "s3"] }),
    ));
    expect(r.jobs).toEqual([expect.objectContaining({ stage: "check", params: { sceneIds: ["s1", "s3"] } })]);
    ({ r, s } = advance(s, running(s, "check", {}, { failedScenes: [], issueScenes: [] })));
    expect(r.jobs).toEqual([expect.objectContaining({ stage: "qa", params: { sceneIds: ["s1", "s3"] } })]);
    ({ r, s } = advance(s, running(s, "qa", {}, { verdict: "fix", seriousScenes: ["s1"] }), one));
    expect(stages(r)).toEqual([]);
    expect(r.state.branches.video).toBe("done");
  });

  it("qaMaxRounds: 2 — two rounds QA → fix, then checkpoint 3 even if QA still says fix", () => {
    let s = state("directing", { branches: { video: "running", audio: "done" } });
    let r: StepResult;
    const two = { qaMaxRounds: 2 };
    // коло 1
    ({ r, s } = advance(s, running(s, "qa", {}, { verdict: "fix", seriousScenes: ["s1", "s3"] }), two));
    expect(r.jobs).toEqual([
      expect.objectContaining({ stage: "fix", params: { sceneIds: ["s1", "s3"], reason: "qa" } }),
    ]);
    expect(r.pipe.qaRounds).toBe(1);
    ({ r, s } = advance(
      s,
      running(s, "fix", { sceneIds: ["s1", "s3"], reason: "qa" }, { sceneIds: ["s1", "s3"] }),
      two,
    ));
    ({ r, s } = advance(s, running(s, "check", {}, { failedScenes: [], issueScenes: [] }), two));
    expect(r.jobs).toEqual([expect.objectContaining({ stage: "qa", params: { sceneIds: ["s1", "s3"] } })]);
    // коло 2: лише сцени, які щойно виправляли (s2 з попередніх зауважень не додається)
    ({ r, s } = advance(s, running(s, "qa", {}, { verdict: "fix", seriousScenes: ["s1", "s2"] }), two));
    expect(r.jobs).toEqual([
      expect.objectContaining({ stage: "fix", params: { sceneIds: ["s1"], reason: "qa" } }),
    ]);
    expect(r.pipe.qaRounds).toBe(2);
    expect(r.pipe.dirtyScenes).toEqual(["s1"]);
    ({ r, s } = advance(s, running(s, "fix", { sceneIds: ["s1"], reason: "qa" }, { sceneIds: ["s1"] }), two));
    ({ r, s } = advance(s, running(s, "check", {}, { failedScenes: [], issueScenes: [] }), two));
    expect(r.jobs).toEqual([expect.objectContaining({ stage: "qa", params: { sceneIds: ["s1"] } })]);
    // після двох кіл — чекпоінт 3, навіть якщо QA досі хоче fix
    ({ r, s } = advance(s, running(s, "qa", {}, { verdict: "fix", seriousScenes: ["s1"] }), two));
    expect(stages(r)).toEqual([]);
    expect(r.pipe.qaRounds).toBe(2);
    expect(r.state.branches.video).toBe("done");
    expect(r.state.status).toBe("awaiting_storyboard");
    expect(r.effects).toContainEqual(
      expect.objectContaining({ type: "checkpoint", checkpoint: "storyboard" }),
    );
  });

  it("qaMaxRounds: 0 — no fix after QA; without ctx — Tuning from env (ADC_QA_MAX_ROUNDS)", () => {
    const s = state("directing", { branches: { video: "running", audio: "done" } });
    const qa = () => running(s, "qa", {}, { verdict: "fix", seriousScenes: ["s1"] });
    const none = nextStep(s, qa(), ctx({ qaMaxRounds: 0 }));
    expect(stages(none)).toEqual([]);
    expect(none.state.status).toBe("awaiting_storyboard");

    vi.stubEnv("ADC_QA_MAX_ROUNDS", "0");
    expect(stages(nextStep(s, qa(), ctx()))).toEqual([]);
    vi.stubEnv("ADC_QA_MAX_ROUNDS", "");
    // дефолт Tuning — 2 кола: після одного кола ще є друге
    const after1 = state(
      "directing",
      { branches: { video: "running", audio: "done" } },
      { qaRounds: 1, videoPhase: "qa_fix", dirtyScenes: ["s1"] },
    );
    const r = nextStep(after1, running(after1, "qa", {}, { verdict: "fix", seriousScenes: ["s1"] }), ctx());
    expect(r.jobs).toEqual([
      expect.objectContaining({ stage: "fix", params: { sceneIds: ["s1"], reason: "qa" } }),
    ]);
  });

  it("QA ignores scenes already replaced by templates", () => {
    const s = state(
      "directing",
      { branches: { video: "running", audio: "done" } },
      { templateScenes: ["s2"] },
    );
    const r = nextStep(s, running(s, "qa", {}, { verdict: "fix", seriousScenes: ["s2"] }), ctx());
    expect(stages(r)).toEqual([]);
    expect(r.state.status).toBe("awaiting_storyboard");
  });

  it("branch failure → failed; sibling still completes; retry rejoins", () => {
    let s = directing();
    let r: StepResult;
    ({ r, s } = advance(s, running(s, "audio", {}, {}, { fail: true })));
    expect(r.state.status).toBe("failed");
    expect(r.state.failure).toMatchObject({ stage: "audio", resumeStatus: "directing", retryable: true });
    expect(r.state.branches.audio).toBe("failed");
    expect(r.events).toContainEqual(expect.objectContaining({ type: "error", stage: "audio" }));
    ({ r, s } = advance(s, running(s, "qa", {}, { verdict: "pass", seriousScenes: [] })));
    expect(r.state.status).toBe("failed");
    expect(r.state.branches.video).toBe("done");
    ({ r, s } = advance(s, cmd({ type: "retry" })));
    expect(r.state.status).toBe("directing");
    expect(r.jobs).toEqual([expect.objectContaining({ stage: "audio", attempt: 1 })]);
    const retried = r.pipe.outstanding.find((j) => j.stage === "audio") as JobRecord;
    ({ r, s } = advance(s, {
      kind: "stage_event",
      event: {
        projectId: "p1",
        rev: 1,
        stage: "audio",
        attempt: retried.attempt,
        jobId: retried.jobId,
        durationMs: 1,
        type: "stage_done",
        artifacts: [],
        outputs: { planHash: "ph", reusedMusic: false, mixed: true },
        reused: false,
      },
    }));
    expect(r.state.status).toBe("awaiting_storyboard");
  });

  it("stale or duplicate stage events are ignored", () => {
    const s = directing();
    const input: StepInput = {
      kind: "stage_event",
      event: {
        projectId: "p1",
        rev: 1,
        stage: "check",
        attempt: 9,
        jobId: "p1.check.r1.a9",
        durationMs: 1,
        type: "stage_done",
        artifacts: [],
        outputs: { failedScenes: [], issueScenes: [] },
        reused: false,
      },
    };
    const r = nextStep(s, input, ctx());
    expect(r.jobs).toEqual([]);
    expect(r.events).toEqual([]);
    expect(r.effects).toEqual([]);
    expect(r.state).toEqual(s.project);
  });

  it("every accepted stage event yields a cost effect", () => {
    const s = directing();
    const r = nextStep(s, running(s, "codegen", {}, { sceneIds: ["s1"] }), ctx());
    expect(r.effects).toContainEqual({ type: "cost", stage: "codegen", rev: 1, durationMs: 500 });
  });
});

describe("nextStep — revisions", () => {
  it("revision at checkpoint 3 regenerates only affected scenes; templates of others carry over", () => {
    const s0 = state("awaiting_storyboard", {}, { templateScenes: ["s1", "s2"], attempts: { codegen: 1 } });
    const r1 = nextStep(
      s0,
      msg("у другій сцені інший заголовок", intent({ kind: "edit", edits: "s2" })),
      ctx(),
    );
    expect(r1.state.rev).toBe(2);
    expect(r1.state.revisions[1]).toMatchObject({ n: 2, basedOn: 1, reason: "edit", at: "storyboard" });
    expect(r1.jobs).toEqual([
      expect.objectContaining({
        stage: "revise",
        rev: 2,
        params: { text: "у другій сцені інший заголовок", at: "storyboard" },
      }),
    ]);
    const s1: MachineState = { project: r1.state, pipe: r1.pipe };
    const r2 = nextStep(
      s1,
      running(s1, "revise", {}, { scenesToRegenerate: ["s2"], musicChanged: false, durationChanged: false }),
      ctx(),
    );
    expect(r2.state.status).toBe("directing");
    expect(r2.jobs).toEqual([
      expect.objectContaining({
        stage: "codegen",
        params: {
          sceneIds: ["s2"],
          instructions: [{ sceneId: "s2", instruction: "у другій сцені інший заголовок" }],
        },
      }),
      expect.objectContaining({ stage: "audio" }),
    ]);
    expect(r2.pipe.templateScenes).toEqual(["s1"]);
    expect(r2.pipe.changedScenes).toEqual(["s2"]);
    const s2: MachineState = { project: r2.state, pipe: r2.pipe };
    const r3 = nextStep(s2, running(s2, "codegen", {}, { sceneIds: ["s2"] }), ctx());
    expect(r3.jobs).toEqual([expect.objectContaining({ stage: "check", params: { sceneIds: ["s2"] } })]);
  });

  it("duration change after storyboard re-checks all scenes", () => {
    const s = state("revising", {
      rev: 2,
      revisions: [
        { n: 1, createdAt: NOW, basedOn: null, reason: "initial", at: null, instruction: null },
        { n: 2, createdAt: NOW, basedOn: 1, reason: "edit", at: "delivered", instruction: "20 секунд" },
      ],
    });
    const r = nextStep(
      s,
      running(s, "revise", {}, { scenesToRegenerate: ["s1"], musicChanged: true, durationChanged: true }),
      ctx(),
    );
    expect(r.pipe.changedScenes).toBeNull();
  });

  it("formats change at checkpoint 3 is a revision (new stills needed)", () => {
    const r = nextStep(
      state("awaiting_storyboard"),
      msg("додай квадрат", intent({ kind: "edit", formats: ["vertical", "square"] })),
      ctx(),
    );
    expect(r.state.formats).toEqual(["vertical", "square"]);
    expect(r.state.status).toBe("revising");
  });

  it("revision at checkpoint 2 returns to checkpoint 2", () => {
    const s = state("revising", {
      rev: 2,
      revisions: [
        { n: 1, createdAt: NOW, basedOn: null, reason: "initial", at: null, instruction: null },
        { n: 2, createdAt: NOW, basedOn: 1, reason: "edit", at: "script", instruction: "x" },
      ],
    });
    const r = nextStep(
      s,
      running(s, "revise", {}, { scenesToRegenerate: [], musicChanged: false, durationChanged: false }),
      ctx(),
    );
    expect(r.state.status).toBe("awaiting_script");
    expect(r.effects).toContainEqual({
      type: "checkpoint",
      checkpoint: "script",
      rev: 2,
      changedScenes: null,
    });
  });

  it("render: all formats done → delivered, phase revision, firstDeliveredAt kept", () => {
    let s = state("rendering", { formats: ["vertical", "square"] });
    const inV = running(s, "render", { format: "vertical" });
    const inS = running(s, "render", { format: "square" });
    let r = nextStep(s, inV, ctx());
    expect(r.state.status).toBe("rendering");
    s = { project: r.state, pipe: r.pipe };
    r = nextStep(s, inS, ctx());
    expect(r.state.status).toBe("delivered");
    expect(r.state.phase).toBe("revision");
    expect(r.state.firstDeliveredAt).toBe(NOW);
    expect(r.effects).toContainEqual({ type: "delivery", rev: 1, formats: ["vertical", "square"] });
  });

  it("render failure on one format: retry re-renders only that format", () => {
    let s = state("rendering", { formats: ["vertical", "square"] });
    const inV = running(s, "render", { format: "vertical" }, {}, { fail: true });
    const inS = running(s, "render", { format: "square" });
    let r = nextStep(s, inV, ctx());
    expect(r.state.status).toBe("failed");
    s = { project: r.state, pipe: r.pipe };
    r = nextStep(s, inS, ctx());
    expect(r.state.status).toBe("failed");
    s = { project: r.state, pipe: r.pipe };
    r = nextStep(s, cmd({ type: "retry" }), ctx());
    expect(r.state.status).toBe("rendering");
    expect(r.jobs).toEqual([expect.objectContaining({ stage: "render", params: { format: "vertical" } })]);
    expect(r.jobs[0]?.jobId).toBe("p1.render.r1.a1.vertical");
  });
});

describe("nextStep — failures", () => {
  it("crawl failure: next message becomes manual description", () => {
    const s0 = state("crawling");
    const r1 = nextStep(s0, running(s0, "crawl", {}, {}, { fail: true, retryable: false }), ctx());
    expect(r1.state.status).toBe("failed");
    expect(r1.events).toContainEqual(expect.objectContaining({ text: t("manualModePrompt") }));
    const r2 = nextStep(
      { project: r1.state, pipe: r1.pipe },
      msg("Кав'ярня у Львові, капучино 75 грн"),
      ctx(),
    );
    expect(r2.state.status).toBe("crawling");
    expect(r2.state.input.kind).toBe("manual");
    expect(r2.jobs).toEqual([
      expect.objectContaining({
        stage: "crawl",
        params: { url: null, manualText: "Кав'ярня у Львові, капучино 75 грн" },
      }),
    ]);
  });

  it("ingest failure does not fail the project", () => {
    const s = state("awaiting_script");
    const r = nextStep(
      s,
      running(s, "ingest", { files: ["x"] }, {}, { fail: true, retryable: false }),
      ctx(),
    );
    expect(r.state.status).toBe("awaiting_script");
    expect(r.state.failure).toBeNull();
  });

  it("retry restores the resume status and re-enqueues with a fresh attempt", () => {
    const s0 = state("scripting", {}, { attempts: { storyboard: 1 } });
    const r1 = nextStep(s0, running(s0, "storyboard", {}, {}, { fail: true }), ctx());
    const r2 = nextStep({ project: r1.state, pipe: r1.pipe }, cmd({ type: "retry" }), ctx());
    expect(r2.state.status).toBe("scripting");
    expect(r2.state.failure).toBeNull();
    expect(r2.jobs).toEqual([
      expect.objectContaining({ stage: "storyboard", attempt: 2, jobId: "p1.storyboard.r1.a2" }),
    ]);
  });
});

describe("nextStep — speculative render (Tuning.speculativeRender)", () => {
  const SPEC = ctx({ speculativeRender: true });
  const step = (s: MachineState, input: StepInput, c: StepContext = SPEC) => {
    const r = nextStep(s, input, c);
    return { r, s: { project: r.state, pipe: r.pipe } as MachineState };
  };
  /** Подія завершення вже поставленого job (за jobId). */
  function finish(s: MachineState, jobId: string, opts: { fail?: boolean } = {}): StepInput {
    const job = s.pipe.outstanding.find((j) => j.jobId === jobId) as JobRecord;
    const format = (job.params as { format: string }).format;
    const common = {
      projectId: "p1",
      rev: job.rev,
      stage: job.stage,
      attempt: job.attempt,
      jobId,
      durationMs: 700,
      format,
    };
    const event = opts.fail
      ? {
          ...common,
          type: "stage_failed" as const,
          error: { code: "x", message: "tech", userMessage: "Збій рендеру.", retryable: true },
        }
      : {
          ...common,
          type: "stage_done" as const,
          artifacts: [],
          outputs: { format, out: `renders/${format}.mp4`, durationMs: 700 },
          reused: false,
        };
    return { kind: "stage_event", event: event as StageDoneEvent };
  }
  /** Відео й аудіо готові: подія qa приводить на чекпоінт 3. */
  function joinToCheckpoint3(c: StepContext = SPEC) {
    const s0 = state("directing", {
      formats: ["vertical", "square"],
      branches: { video: "running", audio: "done" },
    });
    return step(s0, running(s0, "qa", {}, { verdict: "pass", seriousScenes: [] }), c);
  }

  it("entering awaiting_storyboard enqueues a speculative render per selected format", () => {
    const { r } = joinToCheckpoint3();
    expect(r.state.status).toBe("awaiting_storyboard");
    expect(r.effects).toContainEqual(
      expect.objectContaining({ type: "checkpoint", checkpoint: "storyboard" }),
    );
    expect(r.jobs).toEqual([
      expect.objectContaining({
        stage: "render",
        jobId: "p1.render.r1.a1.spec-vertical",
        params: { format: "vertical", speculative: true },
      }),
      expect.objectContaining({
        stage: "render",
        jobId: "p1.render.r1.a1.spec-square",
        params: { format: "square", speculative: true },
      }),
    ]);
  });

  it("flag off → no speculative jobs (current behaviour)", () => {
    for (const c of [ctx(), ctx({ speculativeRender: false })]) {
      const { r } = joinToCheckpoint3(c);
      expect(r.state.status).toBe("awaiting_storyboard");
      expect(r.jobs).toEqual([]);
      expect(r.pipe.outstanding).toEqual([]);
    }
  });

  it("speculative success at checkpoint 3: no status change, no delivery; approve renders as usual", () => {
    let { s, r } = joinToCheckpoint3();
    ({ s, r } = step(s, finish(s, "p1.render.r1.a1.spec-vertical")));
    ({ s, r } = step(s, finish(s, "p1.render.r1.a1.spec-square")));
    expect(r.state.status).toBe("awaiting_storyboard");
    expect(r.effects).toEqual([{ type: "cost", stage: "render", rev: 1, durationMs: 700 }]);
    expect(r.events).toEqual([]);
    expect(r.pipe.outstanding).toEqual([]);

    ({ s, r } = step(s, cmd({ type: "approve", rev: null })));
    expect(r.state.status).toBe("rendering");
    expect(r.jobs.map((j) => [j.jobId, j.params])).toEqual([
      ["p1.render.r1.a1.vertical", { format: "vertical" }],
      ["p1.render.r1.a1.square", { format: "square" }],
    ]);
    ({ s, r } = step(s, finish(s, "p1.render.r1.a1.vertical")));
    ({ s, r } = step(s, finish(s, "p1.render.r1.a1.square")));
    expect(r.state.status).toBe("delivered");
    expect(r.effects).toContainEqual({ type: "delivery", rev: 1, formats: ["vertical", "square"] });
  });

  it("speculative failure: status unchanged, not in failedJobs, no error in chat", () => {
    const { s: s0 } = joinToCheckpoint3();
    const { r } = step(s0, finish(s0, "p1.render.r1.a1.spec-vertical", { fail: true }));
    expect(r.state.status).toBe("awaiting_storyboard");
    expect(r.state.failure).toBeNull();
    expect(r.pipe.failedJobs).toEqual([]);
    expect(r.events).toEqual([]);
    expect(r.pipe.outstanding.map((j) => j.jobId)).toEqual(["p1.render.r1.a1.spec-square"]);
  });

  it("approve during spec: normal jobs deliver; spec events (even failures) change nothing", () => {
    let { s, r } = joinToCheckpoint3();
    ({ s, r } = step(s, cmd({ type: "approve", rev: null })));
    expect(r.state.status).toBe("rendering");
    ({ s, r } = step(s, finish(s, "p1.render.r1.a1.spec-vertical")));
    expect(r.state.status).toBe("rendering");
    expect(r.effects.some((e) => e.type === "delivery")).toBe(false);
    // Спекулятивний square падає під час «Рендерю…» — проєкт не падає.
    ({ s, r } = step(s, finish(s, "p1.render.r1.a1.spec-square", { fail: true })));
    expect(r.state.status).toBe("rendering");
    expect(r.pipe.failedJobs).toEqual([]);
    ({ s, r } = step(s, finish(s, "p1.render.r1.a1.vertical")));
    expect(r.state.status).toBe("rendering");
    ({ s, r } = step(s, finish(s, "p1.render.r1.a1.square")));
    expect(r.state.status).toBe("delivered");
    expect(r.effects.filter((e) => e.type === "delivery")).toHaveLength(1);
  });

  it("normal render finishing before its spec still delivers; the late spec event is a no-op", () => {
    let { s, r } = joinToCheckpoint3();
    ({ s, r } = step(s, cmd({ type: "approve", rev: null })));
    ({ s, r } = step(s, finish(s, "p1.render.r1.a1.vertical")));
    ({ s, r } = step(s, finish(s, "p1.render.r1.a1.square")));
    expect(r.state.status).toBe("delivered");
    const deliveredAt = r.state.deliveredAt;
    ({ s, r } = step(s, finish(s, "p1.render.r1.a1.spec-vertical")));
    expect(r.state.status).toBe("delivered");
    expect(r.effects.some((e) => e.type === "delivery")).toBe(false);
    expect(r.state.deliveredAt).toBe(deliveredAt);
  });

  it("edit at checkpoint 3 during spec: new revision, spec events of the old revision are ignored", () => {
    const { s: old } = joinToCheckpoint3();
    const { s, r } = step(old, msg("змінити s2", intent({ kind: "edit", edits: "s2" })));
    expect(r.state.rev).toBe(2);
    expect(r.pipe.outstanding.map((j) => j.stage)).toEqual(["revise"]);
    for (const jobId of ["p1.render.r1.a1.spec-vertical", "p1.render.r1.a1.spec-square"]) {
      const late = nextStep(s, finish(old, jobId), SPEC);
      expect(late.state).toEqual(s.project);
      expect(late.pipe).toEqual(s.pipe);
      expect(late.effects).toEqual([]);
      expect(late.jobs).toEqual([]);
    }
  });

  it("retry after a normal render failure never re-enqueues speculative jobs", () => {
    let { s, r } = joinToCheckpoint3();
    ({ s, r } = step(s, finish(s, "p1.render.r1.a1.spec-vertical", { fail: true })));
    ({ s, r } = step(s, cmd({ type: "approve", rev: null })));
    ({ s, r } = step(s, finish(s, "p1.render.r1.a1.vertical", { fail: true })));
    expect(r.state.status).toBe("failed");
    expect(r.pipe.failedJobs.map((j) => j.jobId)).toEqual(["p1.render.r1.a1.vertical"]);
    ({ s, r } = step(s, cmd({ type: "retry" })));
    expect(r.jobs.map((j) => [j.jobId, j.params])).toEqual([
      ["p1.render.r1.a2.vertical", { format: "vertical" }],
    ]);
  });
});

describe("nextStep — агентний режим (стадія author)", () => {
  const AGENT = { generationMode: "agent" } as const;
  const advance = (s: MachineState, input: StepInput, over: Partial<StepContext> = {}) => {
    const r = nextStep(s, input, ctx(over));
    return { r, s: { project: r.state, pipe: r.pipe } as MachineState };
  };
  const approveScript = (over: Partial<StepContext>) =>
    advance(state("awaiting_script"), cmd({ type: "approve", rev: null }), { unverifiedClaims: [], ...over });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("затвердження сценарію: author замість codegen з тими самими параметрами", () => {
    const { r } = approveScript(AGENT);
    expect(r.state.status).toBe("directing");
    expect(r.jobs).toEqual([
      expect.objectContaining({ stage: "author", params: { sceneIds: null, instructions: [] } }),
      expect.objectContaining({ stage: "audio" }),
    ]);
    expect(r.events).toContainEqual(expect.objectContaining({ type: "progress", stage: "author" }));
  });

  it("pipeline-режим не змінюється: той самий сценарій подій — та сама послідовність джобів і стан", () => {
    const run = (over: Partial<StepContext>) => {
      let { r, s } = approveScript(over);
      const jobs = [...stages(r)];
      const results: StepResult[] = [r];
      for (const input of [
        () => running(s, "codegen", {}, { sceneIds: ["s1", "s2", "s3"], guardRejected: [] }),
        () => running(s, "check", {}, { failedScenes: ["s2"], issueScenes: [] }),
        () => running(s, "fix", {}, { sceneIds: ["s2"] }),
        () => running(s, "check", {}, { failedScenes: [], issueScenes: [] }),
        () => running(s, "qa", {}, { verdict: "fix", seriousScenes: ["s1"] }),
        () => running(s, "fix", {}, { sceneIds: ["s1"] }),
        () => running(s, "check", {}, { failedScenes: [], issueScenes: [] }),
        () => running(s, "qa", {}, { verdict: "fix", seriousScenes: ["s1"] }),
        () => running(s, "fix", {}, { sceneIds: ["s1"] }),
        () => running(s, "check", {}, { failedScenes: [], issueScenes: [] }),
        () => running(s, "qa", {}, { verdict: "pass", seriousScenes: [] }),
        () => running(s, "audio", {}, { planHash: "ph", reusedMusic: false, mixed: true }),
      ]) {
        ({ r, s } = advance(s, input(), over));
        jobs.push(...stages(r));
        results.push(r);
      }
      return { jobs, results, final: s };
    };
    const base = run({});
    expect(base.jobs).toEqual([
      "codegen",
      "audio",
      "check",
      "fix",
      "check",
      "qa",
      "fix",
      "check",
      "qa",
      "fix",
      "check",
      "qa",
    ]);
    expect(base.final.project.status).toBe("awaiting_storyboard");
    const explicit = run({ generationMode: "pipeline" });
    expect(JSON.stringify(explicit.results)).toBe(JSON.stringify(base.results));
  });

  it("author → check(усі) ↔ fix → qa; QA після агента — не більше 1 кола за замовчуванням", () => {
    let { r, s } = approveScript(AGENT);
    ({ r, s } = advance(
      s,
      running(
        s,
        "author",
        {},
        { sceneIds: ["s1", "s2", "s3"], iterations: 12, renders: 40, usd: 9, stoppedBy: "done" },
      ),
      AGENT,
    ));
    expect(r.jobs).toEqual([expect.objectContaining({ stage: "check", params: { sceneIds: null } })]);
    ({ r, s } = advance(s, running(s, "check", {}, { failedScenes: ["s3"], issueScenes: [] }), AGENT));
    expect(r.jobs).toEqual([
      expect.objectContaining({ stage: "fix", params: { sceneIds: ["s3"], reason: "check" } }),
    ]);
    ({ r, s } = advance(s, running(s, "fix", {}, { sceneIds: ["s3"] }), AGENT));
    ({ r, s } = advance(s, running(s, "check", {}, { failedScenes: [], issueScenes: [] }), AGENT));
    expect(stages(r)).toEqual(["qa"]);
    ({ r, s } = advance(s, running(s, "qa", {}, { verdict: "fix", seriousScenes: ["s2"] }), AGENT));
    expect(r.jobs).toEqual([
      expect.objectContaining({ stage: "fix", params: { sceneIds: ["s2"], reason: "qa" } }),
    ]);
    ({ r, s } = advance(s, running(s, "fix", {}, { sceneIds: ["s2"] }), AGENT));
    ({ r, s } = advance(s, running(s, "check", {}, { failedScenes: [], issueScenes: [] }), AGENT));
    ({ r, s } = advance(s, running(s, "qa", {}, { verdict: "fix", seriousScenes: ["s2"] }), AGENT));
    // Друге коло не ставиться: відео готове, чекаємо аудіо.
    expect(r.jobs).toEqual([]);
    expect(r.state.branches.video).toBe("done");
    ({ r } = advance(s, running(s, "audio", {}, { planHash: "ph", reusedMusic: false, mixed: true }), AGENT));
    expect(r.state.status).toBe("awaiting_storyboard");
  });

  it("ADC_QA_MAX_ROUNDS=0 вимикає QA-фікси і після агента; явний ctx.qaMaxRounds має пріоритет", () => {
    vi.stubEnv("ADC_QA_MAX_ROUNDS", "0");
    const authored = state(
      "directing",
      { branches: { video: "running", audio: "done" } },
      { attempts: { author: 1 } },
    );
    const qaFix = (s: MachineState) => running(s, "qa", {}, { verdict: "fix", seriousScenes: ["s1"] });
    expect(nextStep(authored, qaFix(authored), ctx(AGENT)).jobs).toEqual([]);
    vi.stubEnv("ADC_QA_MAX_ROUNDS", "3");
    const s2 = state(
      "directing",
      { branches: { video: "running", audio: "done" } },
      { attempts: { author: 1 } },
    );
    expect(stages(nextStep(s2, qaFix(s2), ctx({ ...AGENT, qaMaxRounds: 2 })))).toEqual(["fix"]);
  });

  it("правка після стілів іде через author (підмножина); після нього — check лише цих сцен", () => {
    const s0 = state("awaiting_storyboard", {}, { attempts: { author: 1 } });
    const r1 = nextStep(
      s0,
      msg("у другій сцені інший заголовок", intent({ kind: "edit", edits: "s2" })),
      ctx(AGENT),
    );
    const s1: MachineState = { project: r1.state, pipe: r1.pipe };
    const r2 = nextStep(
      s1,
      running(s1, "revise", {}, { scenesToRegenerate: ["s2"], musicChanged: false, durationChanged: false }),
      ctx(AGENT),
    );
    expect(r2.jobs).toEqual([
      expect.objectContaining({
        stage: "author",
        params: {
          sceneIds: ["s2"],
          instructions: [{ sceneId: "s2", instruction: "у другій сцені інший заголовок" }],
        },
      }),
      expect.objectContaining({ stage: "audio" }),
    ]);
    const s2: MachineState = { project: r2.state, pipe: r2.pipe };
    const r3 = nextStep(
      s2,
      running(
        s2,
        "author",
        {},
        { sceneIds: ["s2"], iterations: 3, renders: 10, usd: 2, stoppedBy: "budget" },
      ),
      ctx(AGENT),
    );
    expect(r3.jobs).toEqual([expect.objectContaining({ stage: "check", params: { sceneIds: ["s2"] } })]);
  });

  it("збій author: відеогілка failed, retry ставить author знову", () => {
    let { r, s } = approveScript(AGENT);
    ({ r, s } = advance(s, running(s, "author", {}, {}, { fail: true }), AGENT));
    expect(r.state.status).toBe("failed");
    expect(r.state.branches.video).toBe("failed");
    ({ r, s } = advance(s, cmd({ type: "retry" }), AGENT));
    expect(r.jobs).toEqual([expect.objectContaining({ stage: "author", attempt: 2 })]);
    expect(r.state.branches.video).toBe("running");
  });
});

describe("nextStep — звукорежисер і рецензент (sfxMode: designer)", () => {
  const D = { sfxMode: "designer", filmReview: true, reviewMaxRounds: 1 } as const;
  /** Провайдери audio за замовчуванням (без ctx і env) — фіксуються в pipe і йдуть у параметри. */
  const ELEVEN = { musicProvider: "elevenlabs", sfxProvider: "elevenlabs" } as const;
  const advance = (s: MachineState, input: StepInput, over: Partial<StepContext> = {}) => {
    const r = nextStep(s, input, ctx({ ...D, ...over }));
    return { r, s: { project: r.state, pipe: r.pipe } as MachineState };
  };
  /** Подія завершення вже поставленого job стадії (першого з outstanding). */
  function done<S extends StageName>(s: MachineState, stage: S, outputs: Partial<StageOutputsMap[S]> = {}) {
    const job = s.pipe.outstanding.find((j) => j.stage === stage);
    if (!job) throw new Error(`немає job ${stage}`);
    return running(s, stage, job.params, outputs);
  }
  function failed(s: MachineState, stage: StageName, retryable = false) {
    const job = s.pipe.outstanding.find((j) => j.stage === stage);
    if (!job) throw new Error(`немає job ${stage}`);
    return running(s, stage, job.params, {}, { fail: true, retryable });
  }
  const PASS = { verdict: "pass" as const, seriousScenes: [] as string[] };
  const MUSIC = { planHash: "ph", reusedMusic: false, mixed: false } as const;
  const MIXED = { planHash: "ph", reusedMusic: true, mixed: true } as const;
  const SFX = { sceneIds: ["s1", "s2", "s3"], changed: 2, muted: 1 };
  const OK = { failedScenes: [], issueScenes: [] };
  const review = (
    verdict: "pass" | "fix",
    routes: Partial<StageOutputsMap["review"]["routes"]> = {},
  ): Partial<StageOutputsMap["review"]> => ({
    verdict,
    score: verdict === "pass" ? 8 : 5,
    routes: { fix: [], sfx: [], music: 0, ...routes },
  });
  function issue(over: Partial<ReviewIssue>): ReviewIssue {
    return {
      scope: "scene",
      sceneId: "s1",
      nextSceneId: null,
      eventId: null,
      frame: null,
      format: null,
      severity: "major",
      kind: "low_contrast",
      description: "d",
      fix: "f",
      ...over,
    };
  }
  /** Затвердження сценарію → codegen + audio{music}. */
  const approve = (over: Partial<StepContext> = {}) =>
    advance(state("awaiting_script"), cmd({ type: "approve", rev: null }), { unverifiedClaims: [], ...over });

  /** Відеогілка: codegen → check → qa(pass). */
  function video(s0: MachineState, over: Partial<StepContext> = {}) {
    let s = s0;
    let r: StepResult;
    const results: StepResult[] = [];
    ({ r, s } = advance(s, done(s, "codegen", { sceneIds: ["s1", "s2", "s3"], guardRejected: [] }), over));
    results.push(r);
    ({ r, s } = advance(s, done(s, "check", OK), over));
    results.push(r);
    ({ r, s } = advance(s, done(s, "qa", PASS), over));
    results.push(r);
    return { s, results, last: r };
  }

  /** Від затвердження до запущеної рецензії (music раніше за sfx). */
  function toReview(): MachineState {
    let { s } = approve();
    ({ s } = advance(s, done(s, "audio", MUSIC)));
    ({ s } = video(s));
    ({ s } = advance(s, done(s, "sfx", SFX)));
    ({ s } = advance(s, done(s, "audio", MIXED)));
    return s;
  }

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("перша генерація: codegen → check → qa → sfx → mix → review → чекпоінт 3", () => {
    let { r, s } = approve();
    const jobs = r.jobs.map((j) => [j.stage, j.params]);
    expect(r.pipe.sfxMode).toBe("designer");
    const results: StepResult[] = [];
    for (const input of [
      () => done(s, "codegen", { sceneIds: ["s1", "s2", "s3"], guardRejected: [] }),
      () => done(s, "check", OK),
      () => done(s, "qa", PASS),
      () => done(s, "audio", MUSIC),
      () => done(s, "sfx", SFX),
      () => done(s, "audio", MIXED),
      () => done(s, "review", review("pass")),
    ]) {
      ({ r, s } = advance(s, input()));
      jobs.push(...r.jobs.map((j) => [j.stage, j.params]));
      results.push(r);
    }
    expect(jobs).toEqual([
      ["codegen", { sceneIds: null, instructions: [] }],
      ["audio", { phase: "music", ...ELEVEN }],
      ["check", { sceneIds: null }],
      ["qa", { sceneIds: null }],
      ["sfx", { sceneIds: null, instructions: [] }],
      ["audio", { phase: "mix", ...ELEVEN }],
      ["review", { round: 0 }],
    ]);
    // Після QA відеогілка ще не done: її закриває зведення.
    expect(results[2]?.state.branches).toEqual({ video: "running", audio: "running" });
    expect(results[2]?.events).toContainEqual(
      expect.objectContaining({ type: "progress", stage: "sfx", label: t("sfxProgress") }),
    );
    // Зведення: обидві гілки done, але чекпоінт — лише після рецензії.
    expect(results[5]?.state.branches).toEqual({ video: "done", audio: "done" });
    expect(results[5]?.state.status).toBe("directing");
    expect(results[5]?.events).toContainEqual(
      expect.objectContaining({ type: "progress", stage: "review", label: t("reviewProgress") }),
    );
    expect(r.state.status).toBe("awaiting_storyboard");
    expect(r.effects).toContainEqual({
      type: "checkpoint",
      checkpoint: "storyboard",
      rev: 1,
      changedScenes: null,
    });
    expect(r.pipe.reviewRounds).toBe(0);
  });

  it("music раніше за sfx і навпаки — рівно один mix, після другої з подій", () => {
    const mixes = (results: StepResult[]) =>
      results
        .flatMap((x) => x.jobs)
        .filter((j) => j.stage === "audio" && (j.params as { phase?: string }).phase === "mix");

    // music → (відео) → sfx
    let { s } = approve();
    let r: StepResult;
    const a: StepResult[] = [];
    ({ r, s } = advance(s, done(s, "audio", MUSIC)));
    a.push(r);
    expect(r.pipe.musicDone).toBe(true);
    expect(stages(r)).toEqual([]);
    const v1 = video(s);
    a.push(...v1.results);
    ({ r, s } = advance(v1.s, done(v1.s, "sfx", SFX)));
    a.push(r);
    expect(stages(r)).toEqual(["audio"]);
    expect(mixes(a)).toHaveLength(1);

    // (відео) → sfx → music
    ({ s } = approve());
    const b: StepResult[] = [];
    const v2 = video(s);
    b.push(...v2.results);
    ({ r, s } = advance(v2.s, done(v2.s, "sfx", SFX)));
    b.push(r);
    expect(r.pipe.sfxDone).toBe(true);
    expect(stages(r)).toEqual([]);
    ({ r, s } = advance(s, done(s, "audio", MUSIC)));
    b.push(r);
    expect(stages(r)).toEqual(["audio"]);
    expect(mixes(b)).toHaveLength(1);
    expect(mixes(b)[0]?.jobId).toBe("p1.audio.r1.a2");
  });

  it("коло fix+sfx: fix(review) → check без QA → sfx(сцени + звукові зауваження) → mix → review{1}", () => {
    let s = toReview();
    let r: StepResult;
    const sound = issue({ sceneId: "s3", kind: "sfx_missing", description: "удар без звуку" });
    const visual = issue({ sceneId: "s1", kind: "low_contrast" });
    const music = issue({ scope: "film", sceneId: null, kind: "music_mismatch" });
    ({ r, s } = advance(s, done(s, "review", review("fix", { fix: ["s1"], sfx: ["s3"], music: 1 })), {
      reviewIssues: [visual, sound, music],
    }));
    expect(r.jobs).toEqual([
      expect.objectContaining({ stage: "fix", params: { sceneIds: ["s1"], reason: "review" } }),
    ]);
    expect(r.events).toContainEqual(
      expect.objectContaining({ type: "progress", stage: "fix", label: t("reviewFixProgress") }),
    );
    expect(r.pipe.reviewRounds).toBe(1);
    expect(r.pipe.videoPhase).toBe("review_fix");
    expect(r.pipe.dirtyScenes).toEqual(["s1", "s3"]);
    expect(r.state.status).toBe("directing");
    ({ r, s } = advance(s, done(s, "fix", { sceneIds: ["s1"] })));
    expect(r.jobs).toEqual([expect.objectContaining({ stage: "check", params: { sceneIds: ["s1"] } })]);
    // Сцена не зібралась — як завжди: fix(check) ↔ check, потім sfx.
    ({ r, s } = advance(s, done(s, "check", { failedScenes: ["s1"], issueScenes: [] })));
    expect(r.jobs).toEqual([
      expect.objectContaining({ stage: "fix", params: { sceneIds: ["s1"], reason: "check" } }),
    ]);
    ({ r, s } = advance(s, done(s, "fix", { sceneIds: ["s1"] })));
    ({ r, s } = advance(s, done(s, "check", OK)));
    expect(r.jobs).toEqual([
      expect.objectContaining({ stage: "sfx", params: { sceneIds: ["s1", "s3"], instructions: [sound] } }),
    ]);
    expect(r.pipe.pendingSfx).toBeNull();
    ({ r, s } = advance(s, done(s, "sfx", SFX)));
    expect(r.jobs).toEqual([
      expect.objectContaining({ stage: "audio", params: { phase: "mix", ...ELEVEN } }),
    ]);
    ({ r, s } = advance(s, done(s, "audio", MIXED)));
    expect(r.jobs).toEqual([expect.objectContaining({ stage: "review", params: { round: 1 } })]);
    // Кола вичерпано (reviewMaxRounds: 1): навіть fix → чекпоінт 3.
    ({ r, s } = advance(s, done(s, "review", review("fix", { fix: ["s1"] }))));
    expect(stages(r)).toEqual([]);
    expect(r.state.status).toBe("awaiting_storyboard");
    expect(r.pipe.failedJobs).toEqual([]);
    expect(s.pipe.reviewRounds).toBe(1);
  });

  it("коло лише зі звуком: одразу sfx → mix → review{1}", () => {
    let s = toReview();
    let r: StepResult;
    const sound = issue({ sceneId: "s2", kind: "sfx_off_beat" });
    const other = issue({ sceneId: "s1", kind: "sfx_level" });
    ({ r, s } = advance(s, done(s, "review", review("fix", { sfx: ["s2"] })), {
      reviewIssues: [sound, other],
    }));
    expect(r.jobs).toEqual([
      expect.objectContaining({ stage: "sfx", params: { sceneIds: ["s2"], instructions: [sound] } }),
    ]);
    expect(r.pipe.reviewRounds).toBe(1);
    ({ r, s } = advance(s, done(s, "sfx", SFX)));
    expect(stages(r)).toEqual(["audio"]);
    ({ r, s } = advance(s, done(s, "audio", MIXED)));
    expect(r.jobs).toEqual([expect.objectContaining({ stage: "review", params: { round: 1 } })]);
    ({ r } = advance(s, done(s, "review", review("pass"))));
    expect(r.state.status).toBe("awaiting_storyboard");
  });

  it("pass, вичерпані кола, лише музика чи template-сцени — одразу чекпоінт 3", () => {
    const cases: Array<[Partial<StageOutputsMap["review"]>, Partial<StepContext>, Partial<PipeState>]> = [
      [review("pass"), {}, {}],
      [review("fix", { fix: ["s1"] }), { reviewMaxRounds: 0 }, {}],
      [review("fix", { music: 2 }), {}, {}],
      [review("fix", { fix: ["s2"], sfx: ["s2"] }), {}, { templateScenes: ["s2"] }],
    ];
    for (const [out, over, pipe] of cases) {
      const s0 = toReview();
      const s: MachineState = { project: s0.project, pipe: { ...s0.pipe, ...pipe } };
      const { r } = advance(s, done(s, "review", out), over);
      expect(stages(r)).toEqual([]);
      expect(r.state.status).toBe("awaiting_storyboard");
      expect(r.pipe.reviewRounds).toBe(0);
    }
  });

  it("збій sfx: «звук за розкадровкою», зведення без плану, ревізія йде далі; не у failedJobs", () => {
    let { s } = approve();
    let r: StepResult;
    ({ s } = advance(s, done(s, "audio", MUSIC)));
    ({ s } = video(s));
    ({ r, s } = advance(s, failed(s, "sfx")));
    expect(r.state.status).toBe("directing");
    expect(r.state.failure).toBeNull();
    expect(r.pipe.failedJobs).toEqual([]);
    expect(r.events).toContainEqual(expect.objectContaining({ type: "message", text: t("sfxFallback") }));
    expect(r.events.some((e) => e.type === "error")).toBe(false);
    expect(r.jobs).toEqual([
      expect.objectContaining({ stage: "audio", params: { phase: "mix", ...ELEVEN } }),
    ]);
    ({ r, s } = advance(s, done(s, "audio", MIXED)));
    expect(stages(r)).toEqual(["review"]);

    // Повторюваний збій — так само (спроби BullMQ уже відпрацьовано); трек ще не готовий — mix пізніше.
    const early = video(approve().s).s;
    const { r: r2 } = advance(early, failed(early, "sfx", true));
    expect(r2.pipe.failedJobs).toEqual([]);
    expect(r2.pipe.sfxDone).toBe(true);
    expect(stages(r2)).toEqual([]);
  });

  it("збій review: попередження в чат і чекпоінт 3; не у failedJobs, без retry", () => {
    const s = toReview();
    const { r } = advance(s, failed(s, "review", true));
    expect(r.state.status).toBe("awaiting_storyboard");
    expect(r.state.failure).toBeNull();
    expect(r.pipe.failedJobs).toEqual([]);
    expect(r.events).toContainEqual({ type: "message", role: "assistant", text: t("reviewFailed") });
    expect(r.events.some((e) => e.type === "error")).toBe(false);
  });

  it("збій audio{mix} — як збій audio: failed, retry ставить mix знову", () => {
    let { s } = approve();
    let r: StepResult;
    ({ s } = advance(s, done(s, "audio", MUSIC)));
    ({ s } = video(s));
    ({ s } = advance(s, done(s, "sfx", SFX)));
    ({ r, s } = advance(s, failed(s, "audio", true)));
    expect(r.state.status).toBe("failed");
    expect(r.pipe.failedJobs.map((j) => j.params)).toEqual([{ phase: "mix", ...ELEVEN }]);
    ({ r, s } = advance(s, cmd({ type: "retry" })));
    expect(r.jobs).toEqual([
      expect.objectContaining({ stage: "audio", params: { phase: "mix", ...ELEVEN } }),
    ]);
    ({ r } = advance(s, done(s, "audio", MIXED)));
    expect(stages(r)).toEqual(["review"]);
  });

  it("ревізія після ЧП3 зі scope: sfx лише по зачеплених сценах, review по всьому фільму з round 0", () => {
    const s0 = state("awaiting_storyboard", {}, { reviewRounds: 1, sfxMode: "designer" });
    let { r, s } = advance(s0, msg("у другій сцені інший заголовок", intent({ kind: "edit", edits: "s2" })));
    expect(r.pipe.reviewRounds).toBe(0);
    ({ r, s } = advance(
      s,
      done(s, "revise", { scenesToRegenerate: ["s2"], musicChanged: false, durationChanged: false }),
    ));
    expect(r.jobs.map((j) => [j.stage, j.params])).toEqual([
      [
        "codegen",
        {
          sceneIds: ["s2"],
          instructions: [{ sceneId: "s2", instruction: "у другій сцені інший заголовок" }],
        },
      ],
      ["audio", { phase: "music", ...ELEVEN }],
    ]);
    const jobs: unknown[] = [];
    const steps: Array<() => StepInput> = [
      () => done(s, "codegen", { sceneIds: ["s2"], guardRejected: [] }),
      () => done(s, "check", OK),
      () => done(s, "qa", PASS),
      () => done(s, "audio", MUSIC),
      () => done(s, "sfx", { sceneIds: ["s2"], changed: 1, muted: 0 }),
      () => done(s, "audio", MIXED),
    ];
    for (const input of steps) {
      ({ r, s } = advance(s, input()));
      jobs.push(...r.jobs.map((j) => [j.stage, j.params]));
    }
    expect(jobs).toEqual([
      ["check", { sceneIds: ["s2"] }],
      ["qa", { sceneIds: ["s2"] }],
      ["sfx", { sceneIds: ["s2"], instructions: [] }],
      ["audio", { phase: "mix", ...ELEVEN }],
      ["review", { round: 0 }],
    ]);
    expect(r.jobs[0]?.jobId).toBe("p1.review.r2.a1");
    ({ r } = advance(s, done(s, "review", review("pass"))));
    expect(r.effects).toContainEqual({
      type: "checkpoint",
      checkpoint: "storyboard",
      rev: 2,
      changedScenes: ["s2"],
    });
  });

  it("filmReview: off — після зведення одразу чекпоінт 3", () => {
    let { s } = approve();
    ({ s } = advance(s, done(s, "audio", MUSIC)));
    ({ s } = video(s));
    ({ s } = advance(s, done(s, "sfx", SFX)));
    const { r } = advance(s, done(s, "audio", MIXED), { filmReview: false });
    expect(stages(r)).toEqual([]);
    expect(r.state.status).toBe("awaiting_storyboard");
  });

  it("режим storyboard: audio{full}, без sfx і review навіть з filmReview", () => {
    const SB = { sfxMode: "storyboard" } as const;
    const { r, s } = approve(SB);
    expect(r.jobs.map((j) => [j.stage, j.params])).toEqual([
      ["codegen", { sceneIds: null, instructions: [] }],
      ["audio", { phase: "full", ...ELEVEN }],
    ]);
    const v = video(s, SB);
    expect(v.results.flatMap((x) => stages(x))).toEqual(["check", "qa"]);
    expect(v.last.state.branches.video).toBe("done");
    const end = advance(v.s, done(v.s, "audio", { planHash: "ph", reusedMusic: false, mixed: true }), SB);
    expect(stages(end.r)).toEqual([]);
    expect(end.r.state.status).toBe("awaiting_storyboard");
  });

  it("режим фіксується на старті ревізії; без ctx — з env (ADC_SFX_MODE, дефолт designer)", () => {
    // Ревізія стартувала в designer — зміна перемикача посеред ревізії її не перемикає.
    let { s } = approve();
    ({ s } = advance(s, done(s, "audio", MUSIC)));
    expect(stages(video(s, { sfxMode: "storyboard" }).last)).toEqual(["sfx"]);
    // pipeline.json ревізій до B4 (без поля) — storyboard: їхній audio вже поставлено без фази.
    expect(PipeState.parse({ ...emptyPipe(), sfxMode: undefined }).sfxMode).toBe("storyboard");

    const bare = () =>
      nextStep(state("awaiting_script"), cmd({ type: "approve", rev: null }), {
        now: NOW,
        unverifiedClaims: [],
      });
    vi.stubEnv("ADC_SFX_MODE", "");
    vi.stubEnv("ADC_MUSIC_PROVIDER", "");
    vi.stubEnv("ADC_SFX_PROVIDER", "");
    expect(bare().jobs[1]?.params).toEqual({ phase: "music", ...ELEVEN });
    vi.stubEnv("ADC_SFX_MODE", "storyboard");
    expect(bare().jobs[1]?.params).toEqual({ phase: "full", ...ELEVEN });
  });

  it("провайдери фіксуються на ревізію: audio{music} і audio{mix} несуть ті самі, навіть якщо ctx змінився", () => {
    const EP = { musicProvider: "epidemic", sfxProvider: "epidemic" } as const;
    let { r, s } = approve(EP);
    expect(r.pipe).toMatchObject(EP);
    expect(r.jobs.find((j) => j.stage === "audio")?.params).toEqual({ phase: "music", ...EP });
    // Посеред ревізії перемикач змінився — зведення однаково з провайдерами ревізії.
    ({ s } = advance(s, done(s, "audio", MUSIC), ELEVEN));
    ({ s } = video(s, ELEVEN));
    ({ r, s } = advance(s, done(s, "sfx", SFX), ELEVEN));
    expect(r.jobs.map((j) => [j.stage, j.params])).toEqual([["audio", { phase: "mix", ...EP }]]);
    expect(s.pipe).toMatchObject(EP);
  });

  it("провайдери: без ctx — з env (ADC_MUSIC_PROVIDER/ADC_SFX_PROVIDER, дефолт elevenlabs)", () => {
    const bare = (mode: "designer" | "storyboard") =>
      nextStep(state("awaiting_script"), cmd({ type: "approve", rev: null }), {
        now: NOW,
        sfxMode: mode,
        unverifiedClaims: [],
      });
    vi.stubEnv("ADC_MUSIC_PROVIDER", "");
    vi.stubEnv("ADC_SFX_PROVIDER", "");
    expect(bare("designer").jobs[1]?.params).toEqual({
      phase: "music",
      musicProvider: "elevenlabs",
      sfxProvider: "elevenlabs",
    });
    vi.stubEnv("ADC_MUSIC_PROVIDER", "epidemic");
    const full = bare("storyboard");
    expect(full.jobs[1]?.params).toEqual({
      phase: "full",
      musicProvider: "epidemic",
      sfxProvider: "elevenlabs",
    });
    expect(full.pipe).toMatchObject({ musicProvider: "epidemic", sfxProvider: "elevenlabs" });
    // pipeline.json до Epidemic (без полів) — ElevenLabs.
    const { musicProvider: _m, sfxProvider: _s, ...old } = emptyPipe();
    expect(PipeState.parse(old)).toMatchObject({ musicProvider: "elevenlabs", sfxProvider: "elevenlabs" });
  });
});

describe("драйвер: звукорежисер і рецензент (Harness)", () => {
  async function toCheckpoint3(h: Harness) {
    await h.create();
    await h.start();
    await h.runUntilIdle();
    await h.approve();
    await h.runUntilIdle();
    await h.approve();
    await h.runUntilIdle();
  }

  it("звукові зауваження з review.json ідуть у sfx кола; перша генерація доходить до ЧП3", async () => {
    const sound: ReviewIssue = {
      scope: "scene",
      sceneId: "s2",
      nextSceneId: null,
      eventId: "e1",
      frame: 12,
      format: null,
      severity: "major",
      kind: "sfx_wrong_cue",
      description: "клік замість удару",
      fix: "impact на e1",
    };
    const h = new Harness({
      tuning: () => ({ speculativeRender: false, sfxMode: "designer", filmReview: true, reviewMaxRounds: 1 }),
      reviewIssues: (n) => (n === 1 ? [sound] : []),
      behaviors: {
        review: (_job, n) =>
          n === 1 ? { verdict: "fix", score: 6, routes: { fix: [], sfx: ["s2"], music: 0 } } : undefined,
      },
    });
    await toCheckpoint3(h);
    const s = await h.project();
    expect(s.project.status).toBe("awaiting_storyboard");
    expect(h.jobsOf("sfx").map((j) => j.params)).toEqual([
      { sceneIds: null, instructions: [] },
      { sceneIds: ["s2"], instructions: [sound] },
    ]);
    expect(h.jobsOf("audio").map((j) => j.params.phase)).toEqual(["music", "mix", "mix"]);
    expect(h.jobsOf("review").map((j) => j.params.round)).toEqual([0, 1]);
    expect(s.pipe.reviewRounds).toBe(1);
    expect(h.checkpoints().map((c) => c.checkpoint)).toEqual(["brand", "script", "storyboard"]);
  });

  it("збої sfx і review не зупиняють ревізію", async () => {
    const h = new Harness({
      tuning: () => ({ speculativeRender: false, sfxMode: "designer", filmReview: true }),
      behaviors: {
        sfx: () => ({ fail: { code: "not_implemented", retryable: false } }),
        review: () => ({ fail: { code: "not_implemented", retryable: false } }),
      },
    });
    await toCheckpoint3(h);
    const s = await h.project();
    expect(s.project.status).toBe("awaiting_storyboard");
    expect(s.pipe.failedJobs).toEqual([]);
    expect(h.messages()).toEqual(expect.arrayContaining([t("sfxFallback"), t("reviewFailed")]));
    expect(h.eventsOf("error")).toEqual([]);
  });
});
