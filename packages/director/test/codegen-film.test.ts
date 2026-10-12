import { readCosts, readTuning, revPaths, type Scene, type Storyboard } from "@adc/shared";
import { fixtureAssets, fixtureBrandKitFile, fixtureStoryboard } from "@adc/shared/fixtures";
import { describe, expect, it } from "vitest";
import { parseFileBlocks } from "../src/files.ts";
import { directorPaths } from "../src/io.ts";
import { readLedger } from "../src/ledger.ts";
import { brandForCode, CodegenReport, createCodegenStage, sceneCodegenHash } from "../src/stages/codegen.ts";
import {
  exampleSources,
  fileBlocks,
  makeCtx,
  PROJECT_ID,
  seedProject,
  systemText,
  tmpStorage,
  userText,
} from "./helpers.ts";

const ex = exampleSources();
const POOL = [ex["hook-photo"], ex["offer-price"], ex["cta-logo"], ex.typographic, ex.proof, ex["ui-demo"]];
const codeFor = (id: string) => POOL[(Number(id.slice(1)) - 1) % POOL.length] as string;
const files = (ids: readonly string[]) => fileBlocks(Object.fromEntries(ids.map((id) => [id, codeFor(id)])));
const INVENTED = `import type { SceneProps } from "@adc/motion-kit";
export default function Scene(props: SceneProps) {
  return <div>{props.scene.text.headline}<span>•</span><div>Найкращий сервіс</div></div>;
}
`;

/** Дефолтний `Tuning` (режим film); env — перекриття. */
const stageWith = (env: Record<string, string> = {}) => createCodegenStage({ tuning: () => readTuning(env) });
const filmStage = stageWith();

type Params = {
  model: string;
  max_tokens: number;
  output_config?: { effort?: string; task_budget?: { type: string; total: number } };
  messages: Array<{ content: Array<{ type: string; text?: string; cache_control?: unknown }> }>;
};
const paramsOf = (p: unknown) => p as Params;
const readonlyIds = (params: unknown) =>
  [...userText(params).matchAll(/<file name="(s\d+)\.tsx">/g)].map((m) => m[1]);

/** Розкадровка з `n` сцен на основі фікстури (s1 — hook, остання — cta). */
function storyboardOf(n: number): Storyboard {
  const base = fixtureStoryboard.scenes;
  const scenes: Scene[] = Array.from({ length: n }, (_, i) => {
    const src = structuredClone(i === 0 ? base[0] : i === n - 1 ? base[2] : base[1]) as Scene;
    return { ...src, id: `s${i + 1}` };
  });
  const ids = scenes.map((s) => s.id);
  return {
    ...structuredClone(fixtureStoryboard),
    scenes,
    musicBrief: {
      ...fixtureStoryboard.musicBrief,
      structure: [{ label: "main", sceneIds: ids, energy: 0.6, mix: "full" }],
    },
  };
}

async function seeded(storyboard?: Storyboard) {
  const storage = tmpStorage();
  await seedProject(storage, storyboard ? { storyboard } : {});
  return storage;
}

describe("codegenStage (film)", () => {
  it("дефолт — film: один stream-виклик на всі сцени, task budget 100 000, усі сцени записано", async () => {
    const storage = await seeded();
    const ctx = makeCtx(storage, "codegen", { sceneIds: null, instructions: [] }, [
      { text: files(["s1", "s2", "s3"]) },
    ]);
    const res = await filmStage(ctx);
    expect(res.outputs).toEqual({ sceneIds: ["s1", "s2", "s3"], guardRejected: [] });
    expect(ctx.anthropic.calls).toHaveLength(1);
    const call = ctx.anthropic.calls[0];
    expect(call?.method).toBe("stream");
    const p = paramsOf(call?.params);
    expect(p).toMatchObject({ model: "claude-opus-5-5", max_tokens: 128000 });
    expect(p.output_config).toMatchObject({ effort: "high", task_budget: { type: "tokens", total: 100000 } });
    expect(call?.options?.headers).toMatchObject({
      "anthropic-beta": expect.stringContaining("task-budgets"),
    });
    expect(p.messages[0]?.content[0]?.cache_control).toBeUndefined();
    expect(p.messages[0]?.content.at(-1)?.text).toBe("Mode: film.\nGenerate the scenes: s1, s2, s3.");
    expect(userText(p)).toContain("<readonly_scenes>\n(немає)\n</readonly_scenes>");
    expect(systemText(p)).toContain("## `film`: the whole film in one pass");

    const rp = revPaths(PROJECT_ID, 1);
    for (const id of ["s1", "s2", "s3"]) {
      expect(await storage.readText(rp.scene(id))).toBe(`${codeFor(id).trim()}\n`);
    }
    expect(await storage.readText(rp.scenesIndex)).toContain("export default { s1: S1, s2: S2, s3: S3 };");
    expect(await storage.exists(directorPaths(PROJECT_ID, 1).raw("codegen-r1-film-a1"))).toBe(true);
    const ledger = await readLedger(storage, PROJECT_ID, 1);
    expect(Object.values(ledger.scenes).map((s) => s?.versions[0]?.origin)).toEqual([
      "codegen",
      "codegen",
      "codegen",
    ]);
    const costs = (await readCosts(storage, PROJECT_ID)).filter((e) => e.promptName === "codegen");
    expect(costs.map((e) => e.detail)).toEqual(["film"]);
    const progress = ctx.emitted.events.filter((e) => e.type === "progress" && e.stage === "codegen");
    expect(progress.map((e) => (e as { done: number }).done)).toEqual([0, 1, 2, 3]);
  });

  it("обрізана відповідь (max_tokens) з 4 із 6 файлів: 4 збережено, 2 догенеровано continue по одній", async () => {
    const storage = await seeded(storyboardOf(6));
    const truncated = `${files(["s1", "s2", "s3", "s4"])}\n\n<file name="s5.tsx">\nimport type { SceneProps } from "@adc/mo`;
    const ctx = makeCtx(storage, "codegen", { sceneIds: null, instructions: [] }, [
      { text: truncated, stopReason: "max_tokens" },
      { text: files(["s5"]) },
      { text: files(["s6"]) },
    ]);
    // Різні effort, щоб перевірити: догенерація — тим самим effort, що й film (anchor).
    const res = await stageWith({ ADC_CODEGEN_ANCHOR_EFFORT: "xhigh", ADC_CODEGEN_REST_EFFORT: "medium" })(
      ctx,
    );
    expect(res.outputs).toEqual({ sceneIds: ["s1", "s2", "s3", "s4", "s5", "s6"], guardRejected: [] });
    expect(ctx.anthropic.calls).toHaveLength(3);
    const [film, c5, c6] = ctx.anthropic.calls.map((c) => paramsOf(c.params)) as [Params, Params, Params];
    expect(userText(film)).toContain("Mode: film.");
    // Лого фікстури — SVG з асетом: конкретна підказка, а не загальне правило.
    expect(userText(film)).toContain("<logo_hint>\nThe logo is vector (SVG)");
    for (const p of [film, c5, c6]) {
      expect(p.output_config).toMatchObject({ effort: "xhigh", task_budget: { total: 100000 } });
      expect(p.model).toBe("claude-opus-5-5");
    }
    expect(c5.messages[0]?.content.at(-1)?.text).toBe("Mode: continue.\nGenerate the scenes: s5.");
    expect(readonlyIds(c5)).toEqual(["s1", "s2", "s3", "s4"]);
    expect(c6.messages[0]?.content.at(-1)?.text).toBe("Mode: continue.\nGenerate the scenes: s6.");
    expect(readonlyIds(c6)).toEqual(["s1", "s2", "s3", "s4", "s5"]);

    const rp = revPaths(PROJECT_ID, 1);
    for (const id of ["s1", "s2", "s3", "s4", "s5", "s6"])
      expect(await storage.exists(rp.scene(id))).toBe(true);
    const ledger = await readLedger(storage, PROJECT_ID, 1);
    expect(ledger.scenes.s4?.versions).toHaveLength(1);
    expect(ledger.scenes.s5?.versions).toHaveLength(1);
    const report = await storage.readJson(directorPaths(PROJECT_ID, 1).codegen, (v) =>
      CodegenReport.parse(v),
    );
    expect(report).toMatchObject({ mode: "all", missing: [], guardRejected: [] });
    const costs = (await readCosts(storage, PROJECT_ID)).filter((e) => e.promptName === "codegen");
    expect(costs.map((e) => e.detail)).toEqual(["film", "scene:s5", "scene:s6"]);
  });

  it("повна відповідь без частини сцен → відсутні догенеровано; збій догенерації — сцена в missing", async () => {
    const storage = await seeded();
    const ctx = makeCtx(storage, "codegen", { sceneIds: null, instructions: [] }, [
      { text: files(["s1", "s3"]) },
      { error: new Error("boom") },
    ]);
    const res = await filmStage(ctx);
    expect(res.outputs).toEqual({ sceneIds: ["s1", "s2", "s3"], guardRejected: ["s2"] });
    expect(ctx.anthropic.calls).toHaveLength(2);
    const c2 = ctx.anthropic.calls[1]?.params;
    expect(userText(c2)).toContain("Generate the scenes: s2.");
    expect(readonlyIds(c2)).toEqual(["s1", "s3"]);
    const report = await storage.readJson(directorPaths(PROJECT_ID, 1).codegen, (v) =>
      CodegenReport.parse(v),
    );
    expect(report.missing).toEqual(["s2"]);
    expect(report.violations.s2?.[0]).toMatch(/boom/);
  });

  it("виклик film упав → сцени по одній: перша anchor, далі continue", async () => {
    const storage = await seeded();
    const ctx = makeCtx(storage, "codegen", { sceneIds: null, instructions: [] }, [
      { error: new Error("boom") },
      { text: files(["s1"]) },
      { text: files(["s2"]) },
      { text: files(["s3"]) },
    ]);
    const res = await filmStage(ctx);
    expect(res.outputs).toEqual({ sceneIds: ["s1", "s2", "s3"], guardRejected: [] });
    const tails = ctx.anthropic.calls.map((c) => paramsOf(c.params).messages[0]?.content.at(-1)?.text);
    expect(tails).toEqual([
      "Mode: film.\nGenerate the scenes: s1, s2, s3.",
      "Mode: anchor.\nGenerate the scenes: s1.",
      "Mode: continue.\nGenerate the scenes: s2.",
      "Mode: continue.\nGenerate the scenes: s3.",
    ]);
  });

  it("усі виклики впали — помилка стадії з кодом LLM", async () => {
    const storage = await seeded();
    const ctx = makeCtx(
      storage,
      "codegen",
      { sceneIds: null, instructions: [] },
      Array.from({ length: 4 }, () => ({ error: new Error("boom") })),
    );
    await expect(filmStage(ctx)).rejects.toMatchObject({ code: "llm_api" });
  });

  it("guard з текстами сцени: вигаданий текст → guardRejected, сцену не догенеровують (далі fix)", async () => {
    const storage = await seeded();
    const ctx = makeCtx(storage, "codegen", { sceneIds: null, instructions: [] }, [
      { text: fileBlocks({ s1: codeFor("s1"), s2: INVENTED, s3: codeFor("s3") }) },
    ]);
    const res = await filmStage(ctx);
    expect(ctx.anthropic.calls).toHaveLength(1);
    expect(res.outputs).toEqual({ sceneIds: ["s1", "s2", "s3"], guardRejected: ["s2"] });
    const ledger = await readLedger(storage, PROJECT_ID, 1);
    expect(ledger.scenes.s2?.versions[0]).toMatchObject({ guardOk: false });
    const v = ledger.scenes.s2?.versions[0]?.violations.join("\n") ?? "";
    expect(v).toMatch(/\[screen_text\].*Найкращий сервіс/);
    expect(v).not.toMatch(/•/);
    expect(await storage.exists(revPaths(PROJECT_ID, 1).scene("s2"))).toBe(false);
  });

  it("повтор після збою: уже згенеровані сцени не пишуться вдруге, решта — continue", async () => {
    const storage = await seeded();
    const abort = new AbortController();
    const failing = makeCtx(storage, "codegen", { sceneIds: null, instructions: [] }, [
      { text: files(["s1"]) },
      () => {
        abort.abort();
        return { error: new Error("aborted") };
      },
    ]);
    failing.signal = abort.signal;
    await expect(filmStage(failing)).rejects.toThrow(/aborted/);
    expect(await storage.exists(revPaths(PROJECT_ID, 1).scene("s1"))).toBe(true);

    const ctx = makeCtx(
      storage,
      "codegen",
      { sceneIds: null, instructions: [] },
      [{ text: files(["s2"]) }, { text: files(["s3"]) }],
      { attempt: 2 },
    );
    const res = await filmStage(ctx);
    expect(res.outputs.guardRejected).toEqual([]);
    expect(ctx.anthropic.calls).toHaveLength(2);
    expect(userText(ctx.anthropic.calls[0]?.params)).toContain("Mode: continue.\nGenerate the scenes: s2.");
  });

  it("правка (subset) у режимі film — як у fanout: лише цільові, поруч код решти", async () => {
    const storage = await seeded();
    await filmStage(
      makeCtx(storage, "codegen", { sceneIds: null, instructions: [] }, [
        { text: files(["s1", "s2", "s3"]) },
      ]),
    );
    const ctx = makeCtx(
      storage,
      "codegen",
      { sceneIds: ["s2"], instructions: [{ sceneId: "s2", instruction: "Ціна більша" }] },
      [{ text: files(["s2"]) }],
    );
    const res = await filmStage(ctx);
    expect(res.outputs).toEqual({ sceneIds: ["s2"], guardRejected: [] });
    expect(ctx.anthropic.calls).toHaveLength(1);
    const p = ctx.anthropic.calls[0]?.params;
    expect(userText(p)).toContain("Mode: subset.\nGenerate the scenes: s2.");
    expect(readonlyIds(p)).toEqual(["s1", "s3"]);
  });

  it("хеш входів codegen змінюється при зміні items / events сцени; нова ревізія генерує лише змінену", async () => {
    const scene = fixtureStoryboard.scenes[1] as Scene;
    const hashOf = (s: Scene) =>
      sceneCodegenHash({
        scene: s,
        storyboard: fixtureStoryboard,
        brand: fixtureBrandKitFile,
        manifest: fixtureAssets.assets,
        formats: ["vertical"],
        promptHash: "p",
        contextHash: "c",
        instruction: null,
      });
    const base = hashOf(scene);
    const itemText = structuredClone(scene);
    (itemText.items[0] as { text: string }).text = "Флет уайт";
    const eventAt = structuredClone(scene);
    (eventAt.events[0] as { at: number }).at = 45;
    const eventSound = structuredClone(scene);
    (eventSound.events[1] as { sound: unknown }).sound = { cue: "pop", accent: "soft" };
    const noItems = { ...structuredClone(scene), items: [] };
    for (const changed of [itemText, eventAt, eventSound, noItems]) expect(hashOf(changed)).not.toBe(base);
    expect(hashOf(structuredClone(scene))).toBe(base);

    // Стадія: s2 з іншими items у ревізії 2 → генерується лише s2, решта переноситься.
    const storage = await seeded();
    await filmStage(
      makeCtx(storage, "codegen", { sceneIds: null, instructions: [] }, [
        { text: files(["s1", "s2", "s3"]) },
      ]),
    );
    const sb = structuredClone(fixtureStoryboard);
    sb.scenes[1] = itemText;
    await seedProject(storage, { rev: 2, storyboard: sb });
    const ctx = makeCtx(storage, "codegen", { sceneIds: null, instructions: [] }, [{ text: files(["s2"]) }], {
      rev: 2,
    });
    const res = await filmStage(ctx);
    expect(res.outputs.sceneIds).toEqual(["s2"]);
    expect(ctx.anthropic.calls).toHaveLength(1);
    const ledger = await readLedger(storage, PROJECT_ID, 2);
    expect(ledger.scenes.s1?.versions[0]?.origin).toBe("carry");
    expect(ledger.scenes.s3?.versions[0]?.origin).toBe("carry");
  });

  it("промпт film: живий фон stage, семантичні кольори, mono, правило макету, eyebrow/status, геометрія лого", async () => {
    const storage = await seeded();
    const ctx = makeCtx(storage, "codegen", { sceneIds: null, instructions: [] }, [
      { text: files(["s1", "s2", "s3"]) },
    ]);
    await filmStage(ctx);
    const p = paramsOf(ctx.anthropic.calls[0]?.params);
    const system = systemText(p);
    // правило 7: семантичні кольори й відтінки через mix
    expect(system).toMatch(/semantic colours `danger`, `warning`, `success`/);
    expect(system).toContain("mix(palette.surface, palette.danger, 0.18)");
    // фон фільму за замовчуванням — stage, tint для проблемної сцени
    expect(system).toContain('`variant="stage"` is the film\'s default background');
    expect(system).toContain("tint={theme.palette.danger}");
    expect(system).toContain('by default `Backdrop variant="stage"`');
    // моношрифт для чисел / eyebrow / status
    expect(system).toContain("`theme.fonts.mono`");
    // нові ролі — обов'язково в кадрі
    expect(system).toContain(
      "Every item with the role `eyebrow` or `status` that a scene has is in the frame",
    );
    // правило «макет»: сусідні сцени без однакового контейнера на тій самій позиції
    expect(system).toContain("**Layout rule: no two neighbouring scenes share a layout.**");
    // фінал: геометрія лого з фолбеком
    expect(system).toContain("`useLogoGeometry()` returns `{ viewBox, paths }`");
    expect(system).toContain("fall back to `<Logo>` when it is `null`");
    // модель бачить тип лого в <brand> (фікстура — svg)
    expect(userText(p)).toMatch(/"logo": \{\s*"assetId": "a02",\s*"type": "svg"/);
  });

  it("brandForCode: є identity.tagline", () => {
    const brand = structuredClone(fixtureBrandKitFile);
    brand.identity.tagline = "Кава, що будить";
    expect(brandForCode(brand).tagline).toBe("Кава, що будить");
  });

  it("parseFileBlocks: обірваний блок (повтор стріму після обриву) не ковтає наступний повний", () => {
    const text = `<file name="s1.tsx">\nconst a = 1;\n</file>\n<file name="s2.tsx">\nconst broken =\n<file name="s1.tsx">\nconst a = 2;\n</file>\n<file name="s2.tsx">\nconst b = 2;\n</file>`;
    const parsed = Object.fromEntries(parseFileBlocks(text).map((f) => [f.sceneId, f.code]));
    expect(parsed).toEqual({ s1: "const a = 2;\n", s2: "const b = 2;\n" });
  });
});
