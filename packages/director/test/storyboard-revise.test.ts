import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type BrandKitFile,
  ClaimsReport,
  computeTimeline,
  type ProductSubstance,
  projectPaths,
  revPaths,
  type Storyboard,
} from "@adc/shared";
import {
  fixtureBrandKit,
  fixtureBrandKitFile,
  fixtureSiteData,
  fixtureStoryboard,
} from "@adc/shared/fixtures";
import { describe, expect, it } from "vitest";
import { directorPaths } from "../src/io.ts";
import { momentsInstruction, reviseStage } from "../src/stages/revise.ts";
import {
  EMPTY_SUBSTANCE_NOTE,
  semanticForScript,
  storyboardStage,
  substanceForScript,
} from "../src/stages/storyboard.ts";
import { makeCtx, PROJECT_ID, seedProject, systemText, tmpStorage, userText } from "./helpers.ts";

/** Речовина продукту (аудит сайту), текст сайту, з якого її процитовано, і сцена «приклад результату». */
const SUBSTANCE_FIXTURE = JSON.parse(
  readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "storyboard-substance.json"),
    "utf8",
  ),
) as { siteText: string; substance: ProductSubstance; scene: Storyboard["scenes"][number] };

/** Розкадровка нового формату: темп із сітки, сцени — цілі долі (як після normalize). */
function gridStoryboard(): Storyboard {
  const sb = structuredClone(fixtureStoryboard);
  sb.musicBrief.bpm = 90;
  sb.scenes = sb.scenes.map((s) => ({ ...s, durationFrames: 160 }));
  return sb;
}

/** Блок `<tag>…</tag>` з user-тексту виклику. */
function block(params: unknown, tag: string): string {
  const m = new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`).exec(userText(params));
  if (!m) throw new Error(`немає <${tag}> у запиті`);
  return m[1] as string;
}

function draft(): Storyboard {
  const sb = structuredClone(fixtureStoryboard);
  // закоротко, неіснуючий асет, непідтверджене твердження
  sb.scenes = sb.scenes.map((s) => ({ ...s, durationFrames: 60, assetIds: [...s.assetIds, "zz1"] }));
  (sb.scenes[0] as Storyboard["scenes"][number]).text.headline = "Найкраща кава";
  return sb;
}

describe("storyboardStage", () => {
  it("structured → normalizeStoryboard → verifyClaims → storyboard.json, claims.json", async () => {
    const storage = tmpStorage();
    await seedProject(storage, { storyboard: null });
    const ctx = makeCtx(storage, "storyboard", { durationSeconds: null }, [{ json: draft() }]);
    const res = await storyboardStage(ctx);
    const rp = revPaths(PROJECT_ID, 1);
    const sb = await storage.readJson<Storyboard>(rp.storyboard);
    expect(computeTimeline(sb).totalFrames).toBe(450);
    expect(sb.scenes[0]?.assetIds).toEqual(["a01"]);
    const claims = await storage.readJson(rp.claims, (v) => ClaimsReport.parse(v));
    expect(claims.unverified.map((c) => c.text)).toEqual(["Найкраща"]);
    expect(res.outputs).toEqual({ unverifiedClaims: 1, totalFrames: 450 });
    expect(res.inputsHash).toMatch(/^[0-9a-f]{16}$/);
    const user = userText(ctx.anthropic.calls[0]?.params);
    expect(user).toContain("<facts>");
    expect(user).toContain("Капучино — 75 грн");
    expect(block(ctx.anthropic.calls[0]?.params, "substance")).toBe(EMPTY_SUBSTANCE_NOTE);
    expect(ctx.anthropic.calls[0]?.method).toBe("stream"); // effort high → стрім
  });

  it("бажана тривалість клієнта і повтор при задовгих текстах", async () => {
    const storage = tmpStorage();
    await seedProject(storage, { storyboard: null });
    const long = draft();
    (long.scenes[1] as Storyboard["scenes"][number]).text.sub =
      "Неймовірно довгий підзаголовок, який ніяк не вміщується у два рядки вертикального формату";
    const fix = { scenes: [{ ...structuredClone(fixtureStoryboard.scenes[1]?.text), id: "s2" }] };
    const ctx = makeCtx(storage, "storyboard", { durationSeconds: 20 }, [{ json: long }, { json: fix }]);
    const res = await storyboardStage(ctx);
    expect(ctx.anthropic.calls).toHaveLength(2);
    expect(userText(ctx.anthropic.calls[1]?.params)).toContain("<scenes_to_fix>");
    expect(res.outputs.totalFrames).toBe(600);
  });

  it("<site>: brandkit/site-text.txt; число з items, знайдене на сайті, підтверджене", async () => {
    const storage = tmpStorage();
    await seedProject(storage, { storyboard: null });
    const site =
      '<page url="https://zerno.example.com/" title="Зерно">\nОбсмажуємо 12 сортів щомісяця\n</page>';
    await storage.write(projectPaths(PROJECT_ID).siteText, site);
    const sb = draft();
    (sb.scenes[1] as Storyboard["scenes"][number]).items.push({
      id: "t4",
      role: "number",
      text: "12 сортів",
      group: null,
      factIds: [],
    });
    const ctx = makeCtx(storage, "storyboard", { durationSeconds: null }, [{ json: sb }]);
    await storyboardStage(ctx);
    expect(block(ctx.anthropic.calls[0]?.params, "site")).toBe(site);
    const claims = await storage.readJson(revPaths(PROJECT_ID, 1).claims, (v) => ClaimsReport.parse(v));
    expect(claims.verified).toContainEqual(
      expect.objectContaining({ field: "item", itemId: "t4", text: "12", matchedSite: true }),
    );
    expect(claims.unverified.map((c) => c.text)).toEqual(["Найкраща"]);
  });

  it("<site>: без site-text.txt — стиснений crawl/site.json; без обох — заглушка", async () => {
    const storage = tmpStorage();
    await seedProject(storage, { storyboard: null });
    await storage.writeJson(projectPaths(PROJECT_ID).site, fixtureSiteData);
    const ctx = makeCtx(storage, "storyboard", { durationSeconds: null }, [{ json: draft() }]);
    await storyboardStage(ctx);
    const site = block(ctx.anthropic.calls[0]?.params, "site");
    expect(site).toContain('<page url="https://zerno.example.com/uk/"');
    expect(site).toContain("Капучино — 75 грн.");

    const empty = tmpStorage();
    await seedProject(empty, { storyboard: null });
    const ctx2 = makeCtx(empty, "storyboard", { durationSeconds: null }, [{ json: draft() }]);
    await storyboardStage(ctx2);
    expect(block(ctx2.anthropic.calls[0]?.params, "site")).toContain("текст сайту недоступний");
  });

  it("та сама розкадровка в ревізії-основі → копія без виклику моделі", async () => {
    const storage = tmpStorage();
    await seedProject(storage, { storyboard: null });
    await storyboardStage(makeCtx(storage, "storyboard", { durationSeconds: null }, [{ json: draft() }]));
    await seedProject(storage, { rev: 2, storyboard: null });
    const ctx = makeCtx(storage, "storyboard", { durationSeconds: null }, [], { rev: 2 });
    const res = await storyboardStage(ctx);
    expect(res.reused).toBe(true);
    expect(ctx.anthropic.calls).toHaveLength(0);
    expect(await storage.exists(revPaths(PROJECT_ID, 2).claims)).toBe(true);
  });
});

describe("storyboardStage: речовина продукту, семантичні кольори, нові ролі", () => {
  it("<substance> і <semantic_colors> у запиті; сцена з eyebrow/status і рядками з сайту проходить як є", async () => {
    const storage = tmpStorage();
    await seedProject(storage, { storyboard: null });
    // Бренд-кіт «Зерно» з речовиною продукту з фікстури: перевіряється проводка даних, не зміст.
    const kit: BrandKitFile = {
      ...structuredClone(fixtureBrandKitFile),
      substance: structuredClone(SUBSTANCE_FIXTURE.substance),
      palette: { ...fixtureBrandKitFile.palette, danger: "#E5484D" },
    };
    await storage.writeJson(projectPaths(PROJECT_ID).brandkit(1), kit);
    await storage.write(projectPaths(PROJECT_ID).siteText, SUBSTANCE_FIXTURE.siteText);

    // Відповідь моделі: сцена «приклад результату» перед фінальною і breakdown-частина на ній.
    const sb = structuredClone(fixtureStoryboard);
    sb.scenes.splice(2, 0, structuredClone(SUBSTANCE_FIXTURE.scene));
    sb.musicBrief.structure = [
      { label: "intro", sceneIds: ["s1"], energy: 0.5, mix: "full" },
      { label: "drop", sceneIds: ["s2"], energy: 0.7, mix: "full" },
      { label: "breakdown", sceneIds: ["s4"], energy: 0.3, mix: "breakdown" },
      { label: "finale", sceneIds: ["s3"], energy: 0.7, mix: "full" },
    ];
    const ctx = makeCtx(storage, "storyboard", { durationSeconds: null }, [{ json: sb }]);
    const res = await storyboardStage(ctx);

    const params = ctx.anthropic.calls[0]?.params;
    expect(JSON.parse(block(params, "substance"))).toEqual(SUBSTANCE_FIXTURE.substance);
    const semantic = JSON.parse(block(params, "semantic_colors")) as Record<string, string>;
    expect(semantic.danger).toBe("#E5484D");
    expect(semantic.warning).toContain("виведе код");
    expect(semantic.success).toContain("виведе код");
    // <brand> той самий, що й для правок: речовина — окремим блоком.
    expect(block(params, "brand")).not.toContain("exampleIssues");

    // Правила промпта: обов'язкові сцени, ролі, повні моки, звукова дисципліна, такти, колір.
    const system = systemText(params);
    for (const rule of [
      "Two scenes are in every film, whatever the owner answered",
      "`eyebrow` (a small overline",
      "`status` (the state, severity or estimate",
      "A scene that shows the product at work usually carries 8–12 items",
      "Use them 2–3 times in the whole video",
      "`1 + floor(seconds / 6)`",
      "Every film has one `breakdown` part right before the final scene",
      "a whole number of bars (4 beats)",
      "tint towards `danger`",
    ]) {
      expect(system).toContain(rule);
    }

    const out = await storage.readJson<Storyboard>(revPaths(PROJECT_ID, 1).storyboard);
    const s4 = out.scenes.find((s) => s.id === "s4") as Storyboard["scenes"][number];
    expect(s4.items.map((i) => i.role)).toEqual([
      "eyebrow",
      "heading",
      "number",
      "item",
      "status",
      "item",
      "status",
      "item",
      "status",
      "caption",
      "status",
    ]);
    expect(s4.items.map((i) => i.text)).toEqual(SUBSTANCE_FIXTURE.scene.items.map((i) => i.text));
    expect(s4.motionIntent).toContain("tints towards danger");

    // Числа з речовини продукту підтверджує текст сайту, з якого її процитовано.
    const claims = await storage.readJson(revPaths(PROJECT_ID, 1).claims, (v) => ClaimsReport.parse(v));
    expect(claims.unverified).toEqual([]);
    expect(claims.verified).toContainEqual(
      expect.objectContaining({ sceneId: "s4", itemId: "t3", text: "47", matchedSite: true }),
    );
    expect(claims.verified).toContainEqual(
      expect.objectContaining({ sceneId: "s4", itemId: "t11", text: "3", matchedSite: true }),
    );
    expect(res.outputs.unverifiedClaims).toBe(0);
    const meta = await storage.readJson<{ textIssues: unknown[] }>(
      directorPaths(PROJECT_ID, 1).storyboardMeta,
    );
    expect(meta.textIssues).toEqual([]);
  });

  it("старий бренд-кіт: речовина порожня → заглушка; семантичні кольори null → їх виведе код", () => {
    expect(substanceForScript(fixtureBrandKit)).toBe(EMPTY_SUBSTANCE_NOTE);
    const semantic = semanticForScript(fixtureBrandKit.palette);
    expect(Object.keys(semantic)).toEqual(["danger", "warning", "success"]);
    for (const note of Object.values(semantic)) expect(note).toMatch(/^null — колір виведе код/);
    const one = { ...fixtureBrandKit, substance: { ...fixtureBrandKit.substance, checks: ["UX/UI"] } };
    expect(substanceForScript(one)).toEqual(one.substance);
  });
});

describe("reviseStage", () => {
  it("RevisionPlan → JSON Patch до розкадровки основи → нормалізація, claims, revision.json", async () => {
    const storage = tmpStorage();
    await seedProject(storage, { storyboard: gridStoryboard() });
    await seedProject(storage, { rev: 2, storyboard: null });
    const newScene = {
      ...structuredClone(fixtureStoryboard.scenes[1]),
      id: "s4",
      text: { headline: "Сніданки щодня", sub: null, emphasis: [] },
    };
    const plan = {
      summary: "Змінюю заголовок другої сцени і додаю сцену про сніданки.",
      storyboardPatch: [
        {
          op: "replace",
          path: "/scenes/1/text/headline",
          valueJson: JSON.stringify("Капучино за 75 грн"),
          from: null,
        },
        { op: "add", path: "/scenes/2", valueJson: JSON.stringify(newScene), from: null },
        { op: "replace", path: "/scenes/9/text/headline", valueJson: '"x"', from: null },
      ],
      scenesToRegenerate: [
        { sceneId: "s2", instruction: "Ціну зробити крупніше" },
        { sceneId: "s7", instruction: "?" },
      ],
      musicChanged: false,
      durationChanged: false,
    };
    const ctx = makeCtx(
      storage,
      "revise",
      { text: "У другій сцені — «Капучино за 75 грн», і додайте сніданки", at: "storyboard" },
      [{ json: plan }],
      { rev: 2 },
    );
    const res = await reviseStage(ctx);
    expect(userText(ctx.anthropic.calls[0]?.params)).toContain("<client_message>");
    expect(res.outputs).toEqual({
      scenesToRegenerate: ["s2", "s4"],
      musicChanged: false,
      durationChanged: true,
    });

    const rp2 = revPaths(PROJECT_ID, 2);
    const sb = await storage.readJson<Storyboard>(rp2.storyboard);
    expect(sb.scenes.map((s) => s.id)).toEqual(["s1", "s2", "s4", "s3"]);
    expect(sb.scenes[1]?.text.headline).toBe("Капучино за 75 грн");
    expect(computeTimeline(sb).totalFrames).toBeLessThanOrEqual(900);
    const record = await storage.readJson<{ skipped: unknown[]; scenesToRegenerate: unknown[] }>(
      directorPaths(PROJECT_ID, 2).revision,
    );
    expect(record.skipped).toHaveLength(1);
    expect(record.scenesToRegenerate).toContainEqual({
      sceneId: "s4",
      instruction: "Нова сцена — згенеруй її за розкадровкою.",
    });
    // розкадровка основи не змінена
    const base = await storage.readJson<Storyboard>(revPaths(PROJECT_ID, 1).storyboard);
    expect(base.scenes[1]?.text.headline).toBe("Капучино — 75 грн");
    expect(await storage.exists(rp2.claims)).toBe(true);
  });
});

describe("reviseStage: items і events", () => {
  it("JSON Pointer до items/events → сцена в scenesToRegenerate з інструкцією; кадр події — без неї", async () => {
    const storage = tmpStorage();
    await seedProject(storage, { storyboard: gridStoryboard() });
    await seedProject(storage, { rev: 2, storyboard: null });
    const plan = {
      summary: "Додаю пункт у третю сцену і зсуваю удар ціни.",
      storyboardPatch: [
        {
          op: "add",
          path: "/scenes/2/items/-",
          valueJson: JSON.stringify({
            id: "t1",
            role: "label",
            text: "Щодня з 8:00",
            group: null,
            factIds: [],
          }),
          from: null,
        },
        {
          op: "add",
          path: "/scenes/2/events/-",
          valueJson: JSON.stringify({
            id: "hours-in",
            at: 40,
            what: "Opening hours pop in under the address.",
            sound: { cue: "pop", accent: "soft" },
            textIds: ["t1"],
          }),
          from: null,
        },
        { op: "replace", path: "/scenes/1/events/0/at", valueJson: "40", from: null },
      ],
      scenesToRegenerate: [],
      musicChanged: false,
      durationChanged: false,
    };
    const ctx = makeCtx(
      storage,
      "revise",
      { text: "Додайте години роботи", at: "script" },
      [{ json: plan }],
      {
        rev: 2,
      },
    );
    const res = await reviseStage(ctx);
    expect(block(ctx.anthropic.calls[0]?.params, "site")).toContain("недоступний");
    // Перелік ролей пункту в промпті правок — з новими eyebrow/status.
    expect(systemText(ctx.anthropic.calls[0]?.params)).toContain("`button`, `eyebrow`");
    expect(systemText(ctx.anthropic.calls[0]?.params)).toContain("або `status`");
    expect(res.outputs).toEqual({ scenesToRegenerate: ["s3"], musicChanged: false, durationChanged: false });
    const sb = await storage.readJson<Storyboard>(revPaths(PROJECT_ID, 2).storyboard);
    const s3 = sb.scenes[2] as Storyboard["scenes"][number];
    expect(s3.items.map((i) => i.text)).toEqual(["Щодня з 8:00"]);
    expect(s3.events.map((e) => [e.id, e.at])).toEqual([
      ["arrive", 0],
      ["hours-in", 40], // восьма при 90 BPM — 10 кадрів
    ]);
    // s2 починається з 145-го кадру (перехід 15): удар 145 + 40 = 185 → найближча восьма — 190.
    expect(sb.scenes[1]?.events.find((e) => e.id === "price-hit")?.at).toBe(45);
    const record = await storage.readJson<{
      scenesToRegenerate: Array<{ sceneId: string; instruction: string }>;
    }>(directorPaths(PROJECT_ID, 2).revision);
    expect(record.scenesToRegenerate[0]?.instruction).toContain("items");
  });

  it("momentsInstruction: зміна тексту пункту чи складу подій — так; лише кадр події — ні", () => {
    const scene = fixtureStoryboard.scenes[1] as Storyboard["scenes"][number];
    const moved = structuredClone(scene);
    (moved.events[0] as Storyboard["scenes"][number]["events"][number]).at = 45;
    expect(momentsInstruction(scene, moved)).toBeNull();
    const retext = structuredClone(scene);
    (retext.items[0] as Storyboard["scenes"][number]["items"][number]).text = "Інший текст";
    expect(momentsInstruction(scene, retext)).toContain("items");
    const fewer = structuredClone(scene);
    fewer.events.pop();
    expect(momentsInstruction(scene, fewer)).toContain("events");
  });
});
