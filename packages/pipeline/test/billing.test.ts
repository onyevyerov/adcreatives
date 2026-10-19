import { type PipelineCommand, projectPaths, t } from "@adc/shared";
import { describe, expect, it, vi } from "vitest";
import { Harness, intent, TEST_OWNER } from "./helpers.ts";

// Ціни — defaultCredits(): video 10, revision 3, extraFormat 2.

async function toStoryboard(h: Harness, opts: { formats?: string; ownerId?: string | null } = {}) {
  await h.create(opts.ownerId !== undefined ? { ownerId: opts.ownerId } : {});
  await h.start();
  await h.runUntilIdle();
  if (opts.formats) await h.say(opts.formats);
  await h.approve();
  await h.runUntilIdle();
  await h.approve();
  await h.runUntilIdle();
  expect((await h.project()).project.status).toBe("awaiting_storyboard");
}

async function toDelivered(h: Harness, opts: { formats?: string; ownerId?: string | null } = {}) {
  await toStoryboard(h, opts);
  await h.approve();
  await h.runUntilIdle();
  expect((await h.project()).project.status).toBe("delivered");
}

const editIntent = () => intent({ kind: "edit", edits: "s2: інший заголовок" });

/** Наступний запис project.json падає (після списання — драйвер списує до запису стану). */
function failProjectWriteOnce(h: Harness): void {
  const writeJson = h.storage.writeJson.bind(h.storage);
  let failed = false;
  vi.spyOn(h.storage, "writeJson").mockImplementation(async (key, value) => {
    if (!failed && key === projectPaths("p1").project) {
      failed = true;
      throw new Error("диск недоступний");
    }
    return writeJson(key, value);
  });
}

function ids(entries: Array<{ id: string }>): string[] {
  return entries.map((e) => e.id);
}

describe("billing — правка після видачі", () => {
  it("списує revision:p1:r2 рівно раз, навіть коли команду доставлено вдруге після збою запису", async () => {
    const h = new Harness({ billing: { credits: 10 } });
    await toDelivered(h);
    expect(await h.balance()).toBe(10);

    const cmd: PipelineCommand = {
      ...h.base(),
      type: "user_message",
      text: "у другій сцені інший заголовок",
      messageId: "m-edit",
    };
    // Перша доставка: списання пройшло, а запис project.json упав — команда повториться.
    failProjectWriteOnce(h);
    h.llmReplies.push({ json: editIntent() });
    await expect(h.command(cmd)).rejects.toThrow("диск недоступний");
    let s = await h.project();
    expect(s.project.status).toBe("delivered");
    expect(s.project.rev).toBe(1);
    expect(await h.balance()).toBe(7);

    // Повторна доставка тієї ж команди — та сама ревізія, той самий ключ, без другого списання.
    h.llmReplies.push({ json: editIntent() });
    await h.command(cmd);
    s = await h.project();
    expect(s.project.status).toBe("revising");
    expect(s.project.rev).toBe(2);
    const ledger = await h.ledger();
    expect(ids(ledger)).toEqual(["bonus:seed", "revision:p1:r2"]);
    expect(ledger[1]).toMatchObject({
      kind: "charge",
      credits: -3,
      balanceAfter: 7,
      ref: { projectId: "p1", rev: 2 },
    });
    expect(await h.balance()).toBe(7);
    expect(h.messages()).toContain(t("chargedRevision", { credits: 3, balance: 7 }));
  });

  it("баланс менший за ціну правки — ревізії немає, статус delivered, у стрімі відмова", async () => {
    const h = new Harness({ billing: { credits: 2 } });
    await toDelivered(h);
    const jobsBefore = h.queue.stages.length;
    await h.say("у другій сцені інший заголовок", editIntent());
    const s = await h.project();
    expect(s.project.status).toBe("delivered");
    expect(s.project.rev).toBe(1);
    expect(h.queue.stages).toHaveLength(jobsBefore);
    expect(h.messages()).toContain(t("insufficientCredits", { need: 3, have: 2 }));
    expect(h.messages()).not.toContain(t("revisionStarted"));
    expect(ids(await h.ledger())).toEqual(["bonus:seed"]);
  });

  it("відмова через кредити не зберігає нові формати: після поповнення та сама репліка — правка", async () => {
    const h = new Harness({ billing: { credits: 2 } });
    await toDelivered(h);
    await h.say("Формати: 9:16, 1:1");
    let s = await h.project();
    expect(s.project.status).toBe("delivered");
    expect(s.project.formats).toEqual(["vertical"]);
    await h.accounts?.apply(TEST_OWNER, { id: "topup:t1", kind: "topup", credits: 10 });
    await h.say("Формати: 9:16, 1:1");
    s = await h.project();
    expect(s.project.status).toBe("revising");
    expect(s.project.formats).toEqual(["vertical", "square"]);
  });

  it("баланс рівно на правку — списано до 0", async () => {
    const h = new Harness({ billing: { credits: 3 } });
    await toDelivered(h);
    await h.say("у другій сцені інший заголовок", editIntent());
    expect((await h.project()).project.status).toBe("revising");
    expect(await h.balance()).toBe(0);
    expect(h.messages()).toContain(t("chargedRevision", { credits: 3, balance: 0 }));
  });

  it("баланс рівно на правку і redelivery після збою запису — вже оплачена правка не відмовляє", async () => {
    const h = new Harness({ billing: { credits: 3 } });
    await toDelivered(h);
    const cmd: PipelineCommand = {
      ...h.base(),
      type: "user_message",
      text: "інший заголовок",
      messageId: "m-x",
    };
    failProjectWriteOnce(h);
    h.llmReplies.push({ json: editIntent() });
    await expect(h.command(cmd)).rejects.toThrow("диск недоступний");
    expect(await h.balance()).toBe(0);
    h.llmReplies.push({ json: editIntent() });
    await h.command(cmd);
    expect((await h.project()).project.status).toBe("revising");
    expect(h.messages()).not.toContain(t("insufficientCredits", { need: 3, have: 0 }));
    expect(h.messages()).toContain(t("chargedRevision", { credits: 3, balance: 0 }));
    expect(ids(await h.ledger())).toEqual(["bonus:seed", "revision:p1:r2"]);
  });

  it("правки на чекпоінтах до першої видачі — безкоштовні", async () => {
    const h = new Harness({ billing: { credits: 0 } });
    await toStoryboard(h);
    await h.say("у другій сцені інший заголовок", editIntent());
    const s = await h.project();
    expect(s.project.status).toBe("revising");
    expect(s.project.rev).toBe(2);
    expect(await h.ledger()).toEqual([]);
  });

  it("гонка: баланс змінився між buildContext і apply — крок відкинуто, project.json не записано", async () => {
    const h = new Harness({ billing: { credits: 2 } });
    await toDelivered(h);
    const accounts = h.accounts;
    if (!accounts) throw new Error("немає billing");
    // Машина бачить оптимістичний баланс 100, леджер — 2.
    vi.spyOn(accounts, "balance").mockResolvedValue(100);
    const writes = vi.spyOn(h.storage, "writeJson");
    const jobsBefore = h.queue.stages.length;
    await h.say("у другій сцені інший заголовок", editIntent());
    expect(writes).not.toHaveBeenCalled();
    expect(h.queue.stages).toHaveLength(jobsBefore);
    const s = await h.project();
    expect(s.project.status).toBe("delivered");
    expect(s.project.rev).toBe(1);
    expect(h.messages().at(-1)).toBe(t("insufficientCredits", { need: 3, have: 2 }));
    // Повідомлення машини («списано», «правка почалась») відкинуто разом зі станом.
    expect(h.messages()).not.toContain(t("chargedRevision", { credits: 3, balance: 97 }));
    expect(ids(await h.ledger())).toEqual(["bonus:seed"]);
  });
});

describe("billing — додаткові формати на чекпоінті 3", () => {
  it("vertical + square до першої видачі — format:p1:square один раз; затвердження в ревізії 2 не списує", async () => {
    const h = new Harness({ billing: { credits: 20 } });
    await toStoryboard(h, { formats: "Формати: 9:16, 1:1" });
    expect((await h.project()).project.formats).toEqual(["vertical", "square"]);
    await h.approve();
    expect((await h.project()).project.status).toBe("rendering");
    let ledger = await h.ledger();
    expect(ids(ledger)).toEqual(["bonus:seed", "format:p1:square"]);
    expect(ledger[1]).toMatchObject({
      kind: "charge",
      credits: -2,
      ref: { projectId: "p1", format: "square" },
    });
    expect(h.messages()).toContain(t("chargedFormats", { credits: 2, count: 1, balance: 18 }));
    await h.runUntilIdle();
    expect((await h.project()).project.status).toBe("delivered");

    // Правка після видачі (3 кредити) → чекпоінт 3 ревізії 2 → затвердження без списання форматів.
    await h.say("у другій сцені інший заголовок", editIntent());
    await h.runUntilIdle();
    expect((await h.project()).project.status).toBe("awaiting_storyboard");
    await h.approve();
    await h.runUntilIdle();
    expect((await h.project()).project.status).toBe("delivered");
    ledger = await h.ledger();
    expect(ids(ledger)).toEqual(["bonus:seed", "format:p1:square", "revision:p1:r2"]);
    expect(await h.balance()).toBe(15);
  });

  it("повторне затвердження тієї ж ревізії (redelivery після збою запису) не списує формат удруге", async () => {
    const h = new Harness({ billing: { credits: 20 } });
    await toStoryboard(h, { formats: "Формати: 9:16, 1:1" });
    const cmd: PipelineCommand = { ...h.base(), type: "approve", rev: null };
    failProjectWriteOnce(h);
    await expect(h.command(cmd)).rejects.toThrow("диск недоступний");
    expect((await h.project()).project.status).toBe("awaiting_storyboard");
    expect(await h.balance()).toBe(18);
    await h.command(cmd);
    expect((await h.project()).project.status).toBe("rendering");
    expect(ids(await h.ledger())).toEqual(["bonus:seed", "format:p1:square"]);
    expect(await h.balance()).toBe(18);
  });

  it("один формат — нічого не списується", async () => {
    const h = new Harness({ billing: { credits: 0 } });
    await toStoryboard(h);
    await h.approve();
    expect((await h.project()).project.status).toBe("rendering");
    await h.runUntilIdle();
    expect((await h.project()).project.status).toBe("delivered");
    expect(await h.ledger()).toEqual([]);
  });

  it("не вистачає на додаткові формати — лишаємось на чекпоінті 3 з відмовою", async () => {
    const h = new Harness({ billing: { credits: 1 } });
    await toStoryboard(h, { formats: "Формати: 9:16, 1:1, 16:9" });
    const jobsBefore = h.queue.stages.length;
    await h.approve();
    expect((await h.project()).project.status).toBe("awaiting_storyboard");
    expect(h.queue.stages).toHaveLength(jobsBefore);
    expect(h.messages().at(-1)).toBe(t("insufficientCreditsFormats", { need: 4, have: 1 }));
    expect(ids(await h.ledger())).toEqual(["bonus:seed"]);
  });
});

describe("billing — повернення за збій до першої видачі", () => {
  it("non-retryable codegen — refund:p1 один раз (навіть коли впала й друга гілка) і повідомлення", async () => {
    const h = new Harness({
      billing: { credits: 0 },
      behaviors: {
        codegen: () => ({ fail: { retryable: false } }),
        audio: () => ({ fail: { retryable: false } }),
      },
    });
    await h.create();
    await h.start();
    await h.runUntilIdle();
    await h.approve();
    await h.runUntilIdle();
    await h.approve();
    await h.runUntilIdle();
    const s = await h.project();
    expect(s.project.status).toBe("failed");
    const ledger = await h.ledger();
    expect(ids(ledger)).toEqual(["refund:p1"]);
    expect(ledger[0]).toMatchObject({ kind: "refund", credits: 10, ref: { projectId: "p1" } });
    expect(h.messages()).toContain(t("refundedFailure", { credits: 10 }));
  });

  it("retryable збій — без повернення", async () => {
    const h = new Harness({
      billing: { credits: 0 },
      behaviors: { codegen: () => ({ fail: { retryable: true } }) },
    });
    await h.create();
    await h.start();
    await h.runUntilIdle();
    await h.approve();
    await h.runUntilIdle();
    await h.approve();
    await h.runUntilIdle();
    expect((await h.project()).project.status).toBe("failed");
    expect(await h.ledger()).toEqual([]);
    expect(h.messages()).not.toContain(t("refundedFailure", { credits: 10 }));
  });

  it("non-retryable crawl — без повернення (є ручний режим)", async () => {
    const h = new Harness({
      billing: { credits: 0 },
      behaviors: { crawl: () => ({ fail: { retryable: false } }) },
    });
    await h.create();
    await h.start();
    await h.runUntilIdle();
    const s = await h.project();
    expect(s.project.status).toBe("failed");
    expect(s.project.failure?.stage).toBe("crawl");
    expect(await h.ledger()).toEqual([]);
  });

  it("збій після першої видачі — без повернення", async () => {
    const h = new Harness({
      billing: { credits: 10 },
      behaviors: { codegen: (_job, n) => (n >= 2 ? { fail: { retryable: false } } : undefined) },
    });
    await toDelivered(h);
    await h.say("у другій сцені інший заголовок", editIntent());
    await h.runUntilIdle();
    const s = await h.project();
    expect(s.project.status).toBe("failed");
    expect(s.project.firstDeliveredAt).not.toBeNull();
    expect(ids(await h.ledger())).toEqual(["bonus:seed", "revision:p1:r2"]);
  });
});

describe("billing — проєкти без власника", () => {
  it("без ownerId — жодного виклику store.apply: правки, формати і збої безкоштовні", async () => {
    const h = new Harness({
      billing: { credits: 0 },
      behaviors: { codegen: (_job, n) => (n >= 2 ? { fail: { retryable: false } } : undefined) },
    });
    const accounts = h.accounts;
    if (!accounts) throw new Error("немає billing");
    const apply = vi.spyOn(accounts, "apply");
    const balance = vi.spyOn(accounts, "balance");
    await toDelivered(h, { formats: "Формати: 9:16, 1:1", ownerId: null });
    expect((await h.project()).project.ownerId).toBeUndefined();
    await h.say("у другій сцені інший заголовок", editIntent());
    await h.runUntilIdle();
    expect((await h.project()).project.status).toBe("failed");
    expect(apply).not.toHaveBeenCalled();
    expect(balance).not.toHaveBeenCalled();
  });

  it("ownerId з intake.json потрапляє в project.json", async () => {
    const h = new Harness({ billing: { credits: 0 } });
    await h.create();
    await h.start();
    expect((await h.project()).project.ownerId).toBe(TEST_OWNER);
  });
});
