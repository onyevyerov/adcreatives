import { z } from "zod";
import { IsoDate } from "./schemas/common.ts";
import { CostPhase } from "./schemas/project.ts";
import { projectPaths } from "./storage/paths.ts";
import type { Storage } from "./storage/Storage.ts";

/**
 * Трейс стадій проєкту. Зберігається як `trace.jsonl` (append-only, по рядку на виконання стадії):
 * кілька воркерів пишуть паралельно, тож один JSON-файл перезаписувати небезпечно.
 * `readTrace` віддає зведений вигляд для `GET /api/projects/:id/trace`.
 */
export const TraceEntry = z.object({
  projectId: z.string(),
  rev: z.number().int(),
  stage: z.string(),
  attempt: z.number().int(),
  phase: CostPhase,
  jobId: z.string().nullable(),
  startedAt: IsoDate,
  durationMs: z.number().int(),
  ok: z.boolean(),
  error: z.string().nullable(),
  /** Хеші промптів, використаних стадією. */
  prompts: z.array(z.object({ name: z.string(), hash: z.string() })),
});
export type TraceEntry = z.infer<typeof TraceEntry>;

export interface Tracer {
  /** LLM-обгортка повідомляє, який промпт (і якої версії) використано. */
  notePrompt(name: string, hash: string): void;
  prompts(): Array<{ name: string; hash: string }>;
  /** Дописує запис про виконання стадії; prompts за замовчуванням — зібрані notePrompt. */
  record(
    entry: Omit<TraceEntry, "projectId" | "prompts"> & { prompts?: TraceEntry["prompts"] },
  ): Promise<void>;
}

export function createTracer(storage: Storage, projectId: string): Tracer {
  const seen = new Map<string, string>();
  return {
    notePrompt(name, hash) {
      seen.set(`${name}@${hash}`, name);
    },
    prompts() {
      return [...seen.entries()].map(([key, name]) => ({ name, hash: key.slice(name.length + 1) }));
    },
    async record(entry) {
      const full = TraceEntry.parse({ ...entry, projectId, prompts: entry.prompts ?? this.prompts() });
      await storage.append(projectPaths(projectId).trace, JSON.stringify(full));
    },
  };
}

/** Трейс, який нічого не пише (тести, eval без сховища). */
export function createNoopTracer(): Tracer {
  const seen: Array<{ name: string; hash: string }> = [];
  return {
    notePrompt: (name, hash) => {
      seen.push({ name, hash });
    },
    prompts: () => [...seen],
    record: async () => {},
  };
}

export async function readTrace(storage: Storage, projectId: string): Promise<TraceEntry[]> {
  const key = projectPaths(projectId).trace;
  if (!(await storage.exists(key))) return [];
  const out: TraceEntry[] = [];
  for (const line of (await storage.readText(key)).split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = TraceEntry.safeParse(JSON.parse(line));
      if (parsed.success) out.push(parsed.data);
    } catch {
      // битий рядок пропускаємо
    }
  }
  return out;
}
