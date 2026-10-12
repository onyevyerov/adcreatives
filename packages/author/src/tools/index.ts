import { directorPaths } from "@adc/director";
import { type AgentTool, sha256 } from "@adc/shared";
import type { AuthorSession } from "../session.ts";
import { audioEventsTool, finishTool } from "./meta.ts";
import { contactSheetTool, renderFramesTool, renderStripTool } from "./render.ts";
import { writeSceneTool } from "./writeScene.ts";

/** Ключ журналу викликів інструментів: `rev/<n>/director/author/log.jsonl`. */
export function authorLogKey(projectId: string, rev: number): string {
  return `${directorPaths(projectId, rev).root}/author/log.jsonl`;
}

/** Остання ітерація циклу (з `onIteration`): номер, $ і токени наростаючим підсумком. */
export interface IterationInfo {
  iteration: number;
  usd: number;
  tokens: number;
}

/** Вхід для журналу: код сцени замінюється довжиною і хешем. */
export function loggedInput(input: unknown): unknown {
  if (!input || typeof input !== "object") return input;
  const out: Record<string, unknown> = { ...(input as Record<string, unknown>) };
  if (typeof out.code === "string") {
    out.code = { chars: out.code.length, sha256: sha256(out.code).slice(0, 16) };
  }
  return out;
}

/** Обгортка інструмента: рядок у `log.jsonl` на кожен виклик (успіх чи помилка). */
function logged<I>(session: AuthorSession, iteration: () => IterationInfo, tool: AgentTool<I>): AgentTool<I> {
  const { ctx } = session;
  const key = authorLogKey(ctx.projectId, ctx.rev);
  return {
    ...tool,
    async run(input, signal) {
      const started = Date.now();
      const rendersBefore = session.renders;
      const write = async (entry: Record<string, unknown>) => {
        const it = iteration();
        const line = {
          ts: session.now().toISOString(),
          iteration: it.iteration,
          tool: tool.name,
          input: loggedInput(input),
          usd: it.usd,
          tokens: it.tokens,
          renders: session.renders - rendersBefore,
          ms: Date.now() - started,
          ...entry,
        };
        try {
          await ctx.storage.append(key, JSON.stringify(line));
          session.artifacts.add(key);
        } catch (err) {
          ctx.logger.warn("author: не вдалося записати журнал", { err: String(err) });
        }
      };
      try {
        const out = await tool.run(input, signal);
        await write({ ok: !out.text?.startsWith("error:"), images: out.images?.length ?? 0 });
        return out;
      } catch (err) {
        await write({ ok: false, error: String(err).slice(0, 500) });
        throw err;
      }
    },
  };
}

/** Інструменти агента: write_scene, render_strip, render_frames, contact_sheet, audio_events, finish. */
export function authorTools(session: AuthorSession, iteration: () => IterationInfo): AgentTool[] {
  return [
    writeSceneTool(session),
    renderStripTool(session),
    renderFramesTool(session),
    contactSheetTool(session),
    audioEventsTool(session),
    finishTool(session),
  ].map((t) => logged(session, iteration, t as AgentTool<unknown>));
}
