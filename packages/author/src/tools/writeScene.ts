import { addVersion, formatViolations, guardScene, typecheckScenes, writeLedger } from "@adc/director";
import { type AgentTool, allowedScreenTexts, LEGACY_ARRIVE_EVENT_ID } from "@adc/shared";
import { z } from "zod";
import { type AuthorSession, invalidateBundle, sceneOf } from "../session.ts";

const FENCE = /^\s*```[a-zA-Z]*\s*\n([\s\S]*?)\n\s*```\s*$/;

/** Код без markdown-огорожі, з одним переводом рядка в кінці. */
export function cleanCode(code: string): string {
  const m = FENCE.exec(code);
  return `${(m ? (m[1] ?? "") : code).replace(/^\s*\n/, "").trimEnd()}\n`;
}

/** Події сцени, чий id не трапляється в коді рядковим літералом (як `event_unused` у check). */
export function unusedEventIds(events: ReadonlyArray<{ id: string; at: number }>, code: string): string[] {
  return events
    .filter((e) => !(e.id === LEGACY_ARRIVE_EVENT_ID && e.at === 0))
    .filter((e) => !['"', "'", "`"].some((q) => code.includes(`${q}${e.id}${q}`)))
    .map((e) => e.id);
}

const Input = z.object({
  sceneId: z.string().describe("Scene id from the storyboard, e.g. s1."),
  code: z
    .string()
    .min(1)
    .describe("The complete TSX file of the scene (not a diff), without markdown fences."),
});

/**
 * `write_scene` — записати повний код сцени: AST-guard (з дозволеними текстами сцени) → перевірка
 * типів → нова версія в журналі (`origin: author`; код, що пройшов guard, — і у `video/scenes/`).
 * Модель отримує помилки текстом і править сама.
 */
export function writeSceneTool(session: AuthorSession): AgentTool<z.infer<typeof Input>> {
  return {
    name: "write_scene",
    description:
      "Save the complete code of one scene (replaces its previous version). The file is checked by the static " +
      "guard and the TypeScript compiler; the result lists every problem with its line. Only the scenes listed " +
      "as yours in the task can be written.",
    input: Input,
    async run({ sceneId, code }) {
      const { ctx } = session;
      const scene = sceneOf(session, sceneId);
      if (!scene) return { text: `error: unknown scene ${sceneId}; scenes: ${session.allIds.join(", ")}` };
      if (!session.targets.includes(sceneId)) {
        return {
          text: `error: ${sceneId} is read-only in this run; you may write only: ${session.targets.join(", ")}`,
        };
      }
      if (session.templates.has(sceneId)) {
        return {
          text: `error: ${sceneId} is drawn by the template scene in this revision and takes no code`,
        };
      }
      const source = cleanCode(code);
      const guard = guardScene(source, {
        fileName: `${sceneId}.tsx`,
        allowedTexts: allowedScreenTexts(scene, session.brandFile),
      });
      const violations = guard.ok ? [] : formatViolations(guard.violations).split("\n");
      const types = guard.ok ? typecheckScenes({ [sceneId]: source }) : null;
      const typeErrors = (types?.byScene[sceneId] ?? []).map(
        (e) => `${e.line !== null ? `line ${e.line}:${e.column ?? 0} ` : ""}TS${e.code}: ${e.message}`,
      );
      const { v, written } = await addVersion(ctx.storage, ctx.projectId, ctx.rev, session.ledger, sceneId, {
        origin: "author",
        code: source,
        guardOk: guard.ok,
        violations,
        now: session.now(),
      });
      for (const k of written) session.artifacts.add(k);
      session.artifacts.add(await writeLedger(ctx.storage, ctx.projectId, ctx.rev, session.ledger));
      session.written.set(sceneId, { v, guardOk: guard.ok, typeErrors });
      invalidateBundle(session);

      const lines = [`${sceneId} saved as version v${v}.`];
      if (!guard.ok) {
        lines.push(
          "guard: REJECTED (the scene will not be rendered until fixed):",
          ...violations.map((l) => `- ${l}`),
        );
      } else {
        lines.push("guard: ok.");
        lines.push(
          typeErrors.length
            ? `types: ${typeErrors.length} error(s) (the scene will not be rendered until fixed):\n${typeErrors
                .slice(0, 20)
                .map((l) => `- ${l}`)
                .join("\n")}`
            : "types: ok.",
        );
      }
      const unused = unusedEventIds(scene.events, source);
      if (unused.length) {
        lines.push(
          `warning: events not driven by eventFrame(props.scene, "<id>"): ${unused.join(", ")} — their sounds play anyway.`,
        );
      }
      return { text: lines.join("\n") };
    },
  };
}
