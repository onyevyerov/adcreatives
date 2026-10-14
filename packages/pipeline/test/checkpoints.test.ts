import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type ClaimsReport, LocalStorage, projectPaths, type Storyboard } from "@adc/shared";
import { fixtureProject, fixtureStoryboard } from "@adc/shared/fixtures";
import { describe, expect, it } from "vitest";
import { buildScriptCheckpoint, formatSceneItems } from "../src/checkpoints.ts";

const NOW = "2026-10-06T10:00:00.000Z";

function claim(over: Partial<ClaimsReport["unverified"][number]>): ClaimsReport["unverified"][number] {
  return {
    sceneId: "s2",
    field: "headline",
    itemId: null,
    text: "-10%",
    kind: "percent",
    factId: null,
    matchedContact: false,
    matchedSite: false,
    ...over,
  };
}

async function scriptMessage(
  unverified: ClaimsReport["unverified"],
  storyboard: Storyboard = fixtureStoryboard,
) {
  const storage = new LocalStorage(mkdtempSync(path.join(tmpdir(), "adc-checkpoints-")));
  const project = fixtureProject({ status: "awaiting_script", brandkitVersion: 1 });
  const rp = projectPaths(project.id).rev(1);
  await storage.writeJson(rp.storyboard, storyboard);
  const claims: ClaimsReport = { checkedAt: NOW, brandkitVersion: 1, verified: [], unverified };
  await storage.writeJson(rp.claims, claims);
  const events = await buildScriptCheckpoint(storage, project, 1, NOW);
  const message = events[0];
  if (message?.type !== "message") throw new Error("немає повідомлення чекпоінта 2");
  return { text: message.text, events };
}

describe("чекпоінт 2: тексти items", () => {
  it("під рядком сцени — тексти items; непідтверджене в пункті позначене ⚠ біля пункту", async () => {
    const { text, events } = await scriptMessage([claim({ field: "item", itemId: "t3" })]);
    const lines = text.split("\n");
    const s2 = lines.findIndex((l) => l.startsWith("2. "));
    expect(lines[s2]).toContain("Капучино — 75 грн / -10% на каву з собою до 10:00");
    expect(lines[s2]).not.toContain("⚠");
    expect(lines[s2 + 1]).toBe("   · Спешелті еспресо з молоком · 75 грн · -10% ⚠");
    // Сцени без items — без додаткового рядка.
    const s1 = lines.findIndex((l) => l.startsWith("1. "));
    expect(lines[s1 + 1]?.startsWith("2. ")).toBe(true);
    expect(text).toContain("- ⚠ «-10%»");
    const checkpoint = events[1];
    expect(checkpoint?.type === "checkpoint" && checkpoint.payload.checkpoint === "script").toBe(true);
  });

  it("непідтверджене в headline/sub — ⚠ у рядку сцени, пункти без позначок", async () => {
    const { text } = await scriptMessage([claim({ field: "sub" })]);
    const lines = text.split("\n");
    const s2 = lines.findIndex((l) => l.startsWith("2. "));
    expect(lines[s2]?.endsWith(" ⚠")).toBe(true);
    expect(lines[s2 + 1]).toBe("   · Спешелті еспресо з молоком · 75 грн · -10%");
  });

  it("formatSceneItems: null без items; старі claims без itemId не позначають пункти", () => {
    expect(formatSceneItems({ id: "s1", items: [] }, [])).toBeNull();
    const scene = fixtureStoryboard.scenes[1] as (typeof fixtureStoryboard.scenes)[number];
    expect(formatSceneItems(scene, [claim({})])).toBe("· Спешелті еспресо з молоком · 75 грн · -10%");
  });
});

describe("чекпоінт 2: наскрізний об'єкт", () => {
  it("рядок «Наскрізний об'єкт: …» одразу під концептом, коли throughline є", async () => {
    const storyboard: Storyboard = {
      ...fixtureStoryboard,
      throughline: {
        object: "the teal dot",
        states: fixtureStoryboard.scenes.map((s) => ({ sceneId: s.id, state: "The dot carries over." })),
      },
    };
    const { text } = await scriptMessage([], storyboard);
    const lines = text.split("\n");
    const concept = lines.indexOf(`**${fixtureStoryboard.concept}**`);
    expect(concept).toBeGreaterThan(0);
    expect(lines[concept + 1]).toBe("Наскрізний об'єкт: the teal dot");
    expect(lines[concept + 2]).toBe("");
  });

  it("без throughline (старі розкадровки) — рядка немає", async () => {
    const { text } = await scriptMessage([], { ...fixtureStoryboard, throughline: null });
    const lines = text.split("\n");
    const concept = lines.indexOf(`**${fixtureStoryboard.concept}**`);
    expect(lines[concept + 1]).toBe("");
    expect(text).not.toContain("Наскрізний об'єкт");
  });
});
