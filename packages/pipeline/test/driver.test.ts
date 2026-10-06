import { PipelineCounters, ProjectState, projectPaths, t } from "@adc/shared";
import { describe, expect, it } from "vitest";
import { Harness, intent } from "./helpers.ts";

function userText(h: Harness, callIndex: number): string {
  const call = h.anthropic.calls[callIndex];
  const content = call?.params.messages[0]?.content;
  if (!Array.isArray(content)) return String(content ?? "");
  return content.map((b) => (b.type === "text" ? b.text : "")).join("");
}

describe("driver — happy path through three checkpoints", () => {
  it("intake → … → delivered with checkpoints, costs, audio hash and serialized crawl/ingest", async () => {
    const h = new Harness({ unverified: [{ sceneId: "s2", text: "-10%", kind: "percent" }] });
    await h.create({ photos: ["a.heic"] });
    await h.start();

    let s = await h.project();
    expect(s.project.status).toBe("crawling");
    expect(s.project.input).toEqual({ kind: "site", url: "https://zerno.example.com/", manualText: null });
    expect(h.pendingJobs().map((j) => j.stage)).toEqual(["crawl"]);

    // Фото під час краулінгу — у чергу, не паралельно з crawl.
    await h.storage.write(projectPaths("p1").upload("b.jpg"), "img");
    await h.command({ ...h.base(), type: "photos_added", files: [projectPaths("p1").upload("b.jpg")] });
    expect(h.pendingJobs().map((j) => j.stage)).toEqual(["crawl"]);

    await h.runUntilIdle();
    expect(h.maxConcurrentIo).toBe(1);
    expect(h.queue.stages.map((j) => j.stage)).toEqual(["crawl", "ingest", "ingest", "brandkit"]);
    expect(h.jobsOf("ingest").map((j) => j.params.files)).toEqual([
      ["projects/p1/uploads/a.heic"],
      ["projects/p1/uploads/b.jpg"],
    ]);

    // Чекпоінт 1.
    s = await h.project();
    expect(s.project.status).toBe("awaiting_brand");
    expect(s.project.brandkitVersion).toBe(1);
    const brand = h.checkpoints().at(-1);
    expect(brand?.checkpoint).toBe("brand");
    expect(brand?.payload.checkpoint === "brand" && brand.payload.formats).toEqual(["vertical"]);
    expect(h.messages().at(-1)).toContain("Зерно");

    // Формати з кнопок сторінки — без LLM.
    await h.say("Формати: 9:16, 1:1");
    expect(h.anthropic.calls).toHaveLength(0);
    s = await h.project();
    expect(s.project.formats).toEqual(["vertical", "square"]);
    await h.say("Мова відео: uk");
    expect((await h.project()).project.language).toBe("uk");

    await h.approve();
    s = await h.project();
    expect(s.project.status).toBe("scripting");
    expect(s.project.answers.q1).toBe("Привести нових гостей");
    await h.runUntilIdle();

    // Чекпоінт 2 з непідтвердженим твердженням.
    s = await h.project();
    expect(s.project.status).toBe("awaiting_script");
    const script = h.checkpoints().at(-1);
    expect(script?.payload.checkpoint).toBe("script");
    if (script?.payload.checkpoint === "script") {
      expect(script.payload.claims.unverified).toHaveLength(1);
      expect(script.payload.durationSeconds).toBeCloseTo(15);
      expect(script.payload.thumbnails).toEqual([
        { assetId: "a01", url: "/files/projects/p1/crawl/assets/a01.jpg" },
      ]);
    }
    expect(h.messages().at(-1)).toContain("⚠");

    // «Затвердити» записує непідтверджене як факт клієнта.
    await h.approve(1);
    const patch = h.pendingJobs()[0];
    expect(patch?.stage).toBe("brandkit-patch");
    expect(patch?.params).toEqual({
      instruction: null,
      logoAssetId: null,
      facts: [{ kind: "discount", text: "-10%" }],
    });
    await h.runUntilIdle();

    // Чекпоінт 3.
    s = await h.project();
    expect(s.project.status).toBe("awaiting_storyboard");
    expect(s.project.audioPlanHash).toBe("plan-1");
    expect(s.project.branches).toEqual({ video: "done", audio: "done" });
    const sb = h.checkpoints().at(-1);
    expect(sb?.payload.checkpoint).toBe("storyboard");
    if (sb?.payload.checkpoint === "storyboard") {
      expect(sb.payload.primaryFormat).toBe("vertical");
      expect(sb.payload.stills).toHaveLength(6);
      expect(sb.payload.sheets).toEqual([
        { format: "square", url: "/files/projects/p1/rev/1/sheets/square.png" },
      ]);
      expect(sb.payload.warnings).toHaveLength(1);
      expect(sb.payload.music).toEqual({ url: "/files/projects/p1/rev/1/video/public/music.mp3" });
      expect(sb.payload.templateScenes).toEqual([]);
    }

    await h.approve();
    expect(h.pendingJobs().map((j) => [j.stage, j.jobId])).toEqual([
      ["render", "p1.render.r1.a1.vertical"],
      ["render", "p1.render.r1.a1.square"],
    ]);
    await h.runUntilIdle();

    s = await h.project();
    expect(s.project.status).toBe("delivered");
    expect(s.project.phase).toBe("revision");
    expect(s.project.firstDeliveredAt).not.toBeNull();
    const artifacts = h.eventsOf("artifact");
    expect(artifacts.map((a) => [a.kind, a.format])).toEqual([
      ["video", "vertical"],
      ["video", "square"],
      ["poster", "vertical"],
    ]);

    // Подія cost після кожної стадії (+ підсумок із розбивкою при видачі).
    const costs = h.eventsOf("cost");
    const stageCosts = costs.filter((c) => c.stage !== null);
    expect(stageCosts).toHaveLength(h.queue.stages.length);
    expect(stageCosts.every((c) => c.stageUsd === 0.1)).toBe(true);
    const final = costs.at(-1);
    expect(final?.breakdown?.length).toBeGreaterThan(5);
    expect(final?.totalUsd).toBeCloseTo(0.1 * h.queue.stages.length);

    // project.json валідний, pipeline.json читається як PipelineCounters.
    ProjectState.parse(await h.storage.readJson(projectPaths("p1").project));
    const counters = PipelineCounters.parse(await h.storage.readJson(projectPaths("p1").rev(1).pipeline));
    expect(counters.templateScenes).toEqual([]);
    expect(h.maxConcurrentIo).toBe(1);
  });

  it("creates project.json from intake.json on start; does not echo user messages", async () => {
    const h = new Harness();
    await h.create({ url: null, manualText: "Кав'ярня у Львові" });
    await h.start();
    const s = await h.project();
    expect(s.project.input).toEqual({ kind: "manual", url: null, manualText: "Кав'ярня у Львові" });
    expect(h.pendingJobs()[0]?.params).toEqual({ url: null, manualText: "Кав'ярня у Львові" });
    await h.say("привіт");
    expect(h.eventsOf("message").some((m) => m.role === "user")).toBe(false);
  });
});

async function toBrand(h: Harness) {
  await h.create();
  await h.start();
  await h.runUntilIdle();
}
async function toScript(h: Harness) {
  await toBrand(h);
  await h.approve();
  await h.runUntilIdle();
}
async function toStoryboard(h: Harness) {
  await toScript(h);
  await h.approve();
  await h.runUntilIdle();
}

describe("driver — edits on each checkpoint", () => {
  it("checkpoint 1: brand edit → brandkit-patch → checkpoint 1 again", async () => {
    const h = new Harness();
    await toBrand(h);
    await h.say("акцент зробіть зеленим", intent({ kind: "edit", brandEdits: "акцентний колір — зелений" }));
    expect(h.pendingJobs()[0]).toMatchObject({
      stage: "brandkit-patch",
      params: { instruction: "акцентний колір — зелений", logoAssetId: null, facts: [] },
    });
    expect(userText(h, 0)).toContain("step: brand");
    await h.runUntilIdle();
    const s = await h.project();
    expect(s.project.status).toBe("awaiting_brand");
    expect(s.project.brandkitVersion).toBe(2);
    expect(h.checkpoints().filter((c) => c.checkpoint === "brand")).toHaveLength(2);
    expect(h.messages()).toContain(t("brandkitUpdated", { summary: "колір змінено" }));
  });

  it("checkpoint 1: logo pick via set_logo", async () => {
    const h = new Harness();
    await toBrand(h);
    await h.command({ ...h.base(), type: "set_logo", assetId: "a02" });
    expect(h.pendingJobs()[0]).toMatchObject({ stage: "brandkit-patch", params: { logoAssetId: "a02" } });
    await h.runUntilIdle();
    expect((await h.project()).project.status).toBe("awaiting_brand");
  });

  it("checkpoint 2: edit → new revision → checkpoint 2 again", async () => {
    const h = new Harness();
    await toScript(h);
    await h.say("у другій сцені інший заголовок", intent({ kind: "edit", edits: "s2: інший заголовок" }));
    let s = await h.project();
    expect(s.project.status).toBe("revising");
    expect(s.project.rev).toBe(2);
    expect(h.pendingJobs()[0]).toMatchObject({
      stage: "revise",
      rev: 2,
      params: { text: "у другій сцені інший заголовок", at: "script" },
    });
    await h.runUntilIdle();
    s = await h.project();
    expect(s.project.status).toBe("awaiting_script");
    expect(h.checkpoints().at(-1)).toMatchObject({ checkpoint: "script", rev: 2 });
  });

  it("checkpoint 2: number written by the client becomes a client fact before revise", async () => {
    const h = new Harness();
    await toScript(h);
    await h.say(
      "додайте знижку 15% на сніданки",
      intent({
        kind: "edit",
        edits: "додати знижку 15% на сніданки",
        facts: [{ kind: "discount", text: "-15% на сніданки" }],
      }),
    );
    expect(h.pendingJobs().map((j) => j.stage)).toEqual(["brandkit-patch"]);
    await h.runNext();
    expect(h.pendingJobs()[0]).toMatchObject({ stage: "revise", rev: 2 });
    await h.runUntilIdle();
    expect((await h.project()).project.status).toBe("awaiting_script");
  });

  it("checkpoint 3 and after delivery: only affected scenes, music reused by the audio stage", async () => {
    const h = new Harness();
    await toStoryboard(h);
    await h.say("у другій сцені інший заголовок", intent({ kind: "edit", edits: "s2" }));
    await h.runNext("revise");
    const codegen = h.pendingJobs().find((j) => j.stage === "codegen");
    expect(codegen?.params).toEqual({
      sceneIds: ["s2"],
      instructions: [{ sceneId: "s2", instruction: "у другій сцені інший заголовок" }],
    });
    expect(h.pendingJobs().some((j) => j.stage === "audio" && j.rev === 2)).toBe(true);
    await h.runUntilIdle();
    let s = await h.project();
    expect(s.project.status).toBe("awaiting_storyboard");
    expect(
      h
        .jobsOf("check")
        .filter((j) => j.rev === 2)
        .map((j) => j.params.sceneIds),
    ).toEqual([["s2"]]);
    const cp = h.checkpoints().at(-1);
    if (cp?.payload.checkpoint !== "storyboard") throw new Error("очікувався чекпоінт 3");
    expect(cp.payload.changedScenes).toEqual(["s2"]);
    expect(cp.payload.stills.map((x) => x.sceneId)).toEqual(["s2", "s2"]);
    expect(h.jobsOf("crawl")).toHaveLength(1);
    expect(h.jobsOf("brandkit")).toHaveLength(1);

    await h.approve();
    await h.runUntilIdle();
    s = await h.project();
    expect(s.project.status).toBe("delivered");
    const first = s.project.firstDeliveredAt;

    await h.say("заголовок першої сцени коротший", intent({ kind: "edit", edits: "s1 коротший" }));
    s = await h.project();
    expect(s.project.rev).toBe(3);
    expect(s.project.revisions.at(-1)).toMatchObject({ at: "delivered", basedOn: 2 });
    await h.runUntilIdle();
    await h.approve();
    await h.runUntilIdle();
    s = await h.project();
    expect(s.project.status).toBe("delivered");
    expect(s.project.firstDeliveredAt).toBe(first);
    expect(h.jobsOf("crawl")).toHaveLength(1);
  });
});

describe("driver — failures, duplicates, deferred messages, restart", () => {
  it("stage failure → failed with a reason and a retry button; retry continues", async () => {
    const h = new Harness({
      behaviors: {
        storyboard: (_j, n) => (n === 1 ? { fail: { userMessage: "Модель перевантажена." } } : undefined),
      },
    });
    await toBrand(h);
    await h.approve();
    await h.runUntilIdle();
    let s = await h.project();
    expect(s.project.status).toBe("failed");
    expect(s.project.failure).toMatchObject({ stage: "storyboard", resumeStatus: "scripting" });
    expect(h.eventsOf("error").at(-1)).toMatchObject({ stage: "storyboard", retryable: true });
    const last = h.eventsOf("message").at(-1);
    expect(last?.text).toContain("Модель перевантажена.");
    expect(last?.buttons).toEqual(["retry"]);

    await h.command({ ...h.base(), type: "retry" });
    expect(h.pendingJobs()[0]).toMatchObject({
      stage: "storyboard",
      jobId: "p1.storyboard.r1.a2",
      attempt: 2,
    });
    await h.runUntilIdle();
    s = await h.project();
    expect(s.project.status).toBe("awaiting_script");
    expect(s.project.failure).toBeNull();
  });

  it("double approve (sequential and concurrent) schedules one job", async () => {
    const h = new Harness();
    await toBrand(h);
    await Promise.all([h.approve(), h.approve()]);
    await h.approve();
    expect(h.jobsOf("storyboard")).toHaveLength(1);
  });

  it("duplicate stage_done delivery is ignored", async () => {
    const h = new Harness();
    await h.create();
    await h.start();
    const crawl = await h.runNext();
    if (!crawl) throw new Error("немає crawl");
    const before = h.queue.stages.length;
    await h.redeliver(crawl);
    expect(h.queue.stages.length).toBe(before);
  });

  it("message while busy: busy reply, processed at the next checkpoint, never as approval", async () => {
    const h = new Harness();
    await toBrand(h);
    await h.approve();
    await h.say("додайте сцену про сніданки");
    expect(h.anthropic.calls).toHaveLength(0);
    expect(h.messages().at(-1)).toBe(t("busy"));
    expect((await h.project()).project.pendingMessages).toHaveLength(1);

    h.llmReplies.push({ json: intent({ kind: "edit", edits: "додати сцену про сніданки" }) });
    await h.runNext("storyboard");
    const s = await h.project();
    expect(userText(h, 0)).toContain("deferred: так");
    expect(h.messages()).toContain(t("pendingApplied"));
    expect(s.project.pendingMessages).toEqual([]);
    expect(s.project.status).toBe("revising");
    expect(h.pendingJobs()[0]).toMatchObject({ stage: "revise", params: { at: "script" } });
  });

  it("deferred 'ok' does not approve", async () => {
    const h = new Harness();
    await toBrand(h);
    await h.approve();
    await h.say("ок");
    h.llmReplies.push({ json: intent({ kind: "approve" }) });
    await h.runNext("storyboard");
    expect((await h.project()).project.status).toBe("awaiting_script");
    expect(h.jobsOf("codegen")).toHaveLength(0);
  });

  it("restart only after confirmation button", async () => {
    const h = new Harness();
    await toScript(h);
    await h.command({ ...h.base(), type: "restart_confirmed" });
    expect((await h.project()).project.status).toBe("awaiting_script");

    await h.say("давайте все спочатку", intent({ kind: "restart" }));
    expect(h.eventsOf("message").at(-1)?.buttons).toEqual(["restart_confirm"]);
    expect((await h.project()).project.status).toBe("awaiting_script");

    await h.command({ ...h.base(), type: "restart_confirmed" });
    const s = await h.project();
    expect(s.project.status).toBe("crawling");
    expect(s.project.rev).toBe(2);
    expect(h.pendingJobs()).toEqual([expect.objectContaining({ stage: "crawl", rev: 2 })]);
  });

  it("question → chat-reply answer in chat", async () => {
    const h = new Harness();
    await toScript(h);
    h.llmReplies.push({ json: intent({ kind: "question", question: "Чи можна 20 секунд?" }) });
    h.llmReplies.push({ text: "Так, напишіть «зробіть 20 секунд» у правках." });
    await h.say("а можна 20 секунд?");
    expect(h.messages().at(-1)).toBe("Так, напишіть «зробіть 20 секунд» у правках.");
    expect(h.anthropic.calls.map((c) => c.params.model)).toEqual(["claude-sonnet-5-5", "claude-sonnet-5-5"]);
    expect((await h.project()).project.status).toBe("awaiting_script");
    expect(h.eventsOf("cost").some((c) => c.stage === "chat-reply")).toBe(true);
  });

  it("chat-intent failure → polite 'not understood', state unchanged", async () => {
    const h = new Harness();
    await toScript(h);
    await h.say("щось", new Error("api down"));
    expect(h.messages().at(-1)).toBe(t("intentFailed"));
    expect((await h.project()).project.status).toBe("awaiting_script");
  });
});

describe("driver — fix/QA limits → template scenes", () => {
  it("scene failing after 2 fix rounds becomes TemplateScene; one QA round; shown at checkpoint 3", async () => {
    const h = new Harness({
      behaviors: {
        check: (job) => {
          const ids = job.params.sceneIds;
          return { failedScenes: ids === null || ids.includes("s3") ? ["s3"] : [], issueScenes: [] };
        },
        qa: (_job, n) =>
          n === 1
            ? { verdict: "fix", seriousScenes: ["s1", "s3"] }
            : { verdict: "fix", seriousScenes: ["s1"] },
      },
    });
    await toStoryboard(h);
    const fixes = h.jobsOf("fix").map((j) => j.params);
    expect(fixes).toEqual([
      { sceneIds: ["s3"], reason: "check" },
      { sceneIds: ["s3"], reason: "check" },
      { sceneIds: ["s1"], reason: "qa" },
    ]);
    expect(h.jobsOf("qa").map((j) => j.params.sceneIds)).toEqual([null, ["s1"]]);
    const s = await h.project();
    expect(s.project.status).toBe("awaiting_storyboard");
    expect(s.pipe.templateScenes).toEqual(["s3"]);
    expect(s.pipe.fixRounds).toEqual({ s3: 2 });
    expect(s.pipe.qaRounds).toBe(1);
    const cp = h.checkpoints().at(-1);
    if (cp?.payload.checkpoint !== "storyboard") throw new Error("очікувався чекпоінт 3");
    expect(cp.payload.templateScenes).toEqual(["s3"]);
    expect(h.messages().at(-1)).toContain(t("templateScenesNote", { scenes: "s3" }));
    const counters = PipelineCounters.parse(await h.storage.readJson(projectPaths("p1").rev(1).pipeline));
    expect(counters.templateScenes).toEqual(["s3"]);
  });
});
