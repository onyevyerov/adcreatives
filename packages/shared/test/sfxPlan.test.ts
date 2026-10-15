import { describe, expect, it } from "vitest";
import { applySfxPlan, type SfxDecision, SfxPlan, type Storyboard } from "../src/index.ts";

const scene = (id: string, events: Array<{ id: string; at: number; sound: unknown }>) => ({
  id,
  purpose: "hook",
  durationFrames: 90,
  transitionFrames: 0,
  text: { headline: "h", sub: null },
  items: [],
  events: events.map((e) => ({ what: "x", textIds: [], ...e })),
  factIds: [],
  assetIds: [],
  layoutIntent: "center",
  motionIntent: "m",
  transitionIn: "cut",
  sfxCue: null,
  musicEnergy: 0.5,
});

const sb = {
  concept: "c",
  hook: "h",
  fps: 30,
  scenes: [
    scene("s1", [
      { id: "hit", at: 10, sound: { cue: "impact", accent: "hard" } },
      { id: "type", at: 40, sound: null },
    ]),
    scene("s2", [{ id: "pop", at: 20, sound: { cue: "pop", accent: "normal" } }]),
  ],
} as unknown as Storyboard;

const d = (sceneId: string, eventId: string, sound: SfxDecision["sound"]): SfxDecision => ({
  sceneId,
  eventId,
  sound,
  reason: "",
});

describe("applySfxPlan", () => {
  it("підміняє лише sound, at не рухається, вхід не мутується", () => {
    const before = JSON.stringify(sb);
    const { storyboard, applied, dropped } = applySfxPlan(sb, {
      decisions: [
        d("s1", "hit", { cue: "slam", accent: "normal" }),
        d("s1", "type", { cue: "typing", accent: "soft" }),
      ],
    });
    expect(applied).toBe(2);
    expect(dropped).toEqual([]);
    expect(storyboard.scenes[0]?.events.map((e) => [e.at, e.sound?.cue])).toEqual([
      [10, "slam"],
      [40, "typing"],
    ]);
    expect(storyboard.scenes[1]).toEqual(sb.scenes[1]);
    expect(JSON.stringify(sb)).toBe(before);
  });

  it("null у рішенні — подія мовчить; події без рішення лишаються", () => {
    const { storyboard } = applySfxPlan(sb, { decisions: [d("s1", "hit", null)] });
    expect(storyboard.scenes[0]?.events[0]?.sound).toBeNull();
    expect(storyboard.scenes[1]?.events[0]?.sound?.cue).toBe("pop");
  });

  it("невідомі sceneId/eventId повертаються в dropped", () => {
    const ghost = d("nope", "x", null);
    const ghost2 = d("s1", "nope", null);
    const r = applySfxPlan(sb, { decisions: [ghost, ghost2] });
    expect(r.applied).toBe(0);
    expect(r.dropped).toEqual([ghost, ghost2]);
  });

  it("null-план і порожній план повертають розкадровку без змін", () => {
    expect(applySfxPlan(sb, null)).toEqual({ storyboard: sb, applied: 0, dropped: [] });
    expect(applySfxPlan(sb, { decisions: [] }).storyboard).toBe(sb);
  });

  it("SfxPlan парсить дефолти", () => {
    const p = SfxPlan.parse({
      version: 1,
      inputsHash: "h",
      sceneIds: ["s1"],
      decisions: [{ sceneId: "s1", eventId: "hit", sound: { cue: "impact" } }],
    });
    expect(p.notes).toBe("");
    expect(p.decisions[0]).toMatchObject({ reason: "", sound: { cue: "impact", accent: "normal" } });
  });
});
