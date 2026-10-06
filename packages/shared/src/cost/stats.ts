import { costTargetUsd } from "../env.ts";
import type { CostEvent, Distribution, Prices, StatsReport, StatsRow } from "../schemas/cost.ts";
import { PipelineCounters, ProjectState } from "../schemas/project.ts";
import { Storyboard } from "../schemas/storyboard.ts";
import { PROJECTS_DIR, projectPaths } from "../storage/paths.ts";
import type { Storage } from "../storage/Storage.ts";
import { computeTimeline } from "../timeline.ts";
import { readTrace } from "../trace.ts";
import { groupUsd, readCosts, sumUsd } from "./ledger.ts";

export interface AggregateOptions {
  storage: Storage;
  prices?: Prices;
  targetUsd?: number;
  /** Посилання на чат проєкту. */
  chatUrl?: (projectId: string) => string;
  now?: () => Date;
}

const round2 = (n: number) => Math.round(n * 1e4) / 1e4;

export function distribution(values: readonly number[]): Distribution {
  if (values.length === 0) return { count: 0, mean: null, median: null, p90: null, max: null };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] as number;
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0
      ? ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
      : (sorted[mid] as number);
  return {
    count: sorted.length,
    mean: round2(sorted.reduce((a, b) => a + b, 0) / sorted.length),
    median: round2(median),
    p90: round2(at(0.9)),
    max: round2(sorted[sorted.length - 1] as number),
  };
}

async function readOptional<T>(storage: Storage, key: string, parse: (v: unknown) => T): Promise<T | null> {
  try {
    if (!(await storage.exists(key))) return null;
    return await storage.readJson(key, parse);
  } catch {
    return null;
  }
}

/** Рядок статистики одного проєкту. */
export async function projectStatsRow(
  storage: Storage,
  projectId: string,
  opts: { targetUsd: number; chatUrl: (id: string) => string },
): Promise<{ row: StatsRow; events: CostEvent[] } | null> {
  const paths = projectPaths(projectId);
  const project = await readOptional(storage, paths.project, (v) => ProjectState.parse(v));
  if (!project) return null;
  const events = await readCosts(storage, projectId);
  const rev = paths.rev(project.rev);
  const storyboard = await readOptional(storage, rev.storyboard, (v) => Storyboard.parse(v));
  const counters = await readOptional(storage, rev.pipeline, (v) => PipelineCounters.parse(v));
  const delivered = project.firstDeliveredAt !== null;

  let machineSeconds: number | null = null;
  if (delivered) {
    const trace = await readTrace(storage, projectId);
    const ms = trace.filter((t) => t.phase === "first_delivery").reduce((a, t) => a + t.durationMs, 0);
    machineSeconds = Math.round(ms / 100) / 10;
  }

  let videoSeconds: number | null = null;
  if (storyboard) {
    try {
      videoSeconds = computeTimeline(storyboard).durationSeconds;
    } catch {
      videoSeconds = null;
    }
  }

  const totalUsd = sumUsd(events);
  const row: StatsRow = {
    projectId,
    createdAt: project.createdAt,
    site: project.input.url ?? "(текст вручну)",
    status: project.status,
    source: project.origin,
    formats: project.formats,
    videoSeconds,
    firstDeliveryUsd: sumUsd(events, (e) => e.phase === "first_delivery"),
    revisionUsd: sumUsd(events, (e) => e.phase === "revision"),
    totalUsd,
    revisionsCount: project.revisions.filter((r) => r.reason === "edit").length,
    fixesCount: events.filter((e) => e.stage === "fix" && e.provider === "anthropic").length,
    templateScenesCount: counters?.templateScenes.length ?? 0,
    machineSecondsToFirstDelivery: machineSeconds,
    delivered,
    overTarget: totalUsd > opts.targetUsd,
    chatUrl: opts.chatUrl(projectId),
  };
  return { row, events };
}

/** Агрегація витрат скануванням тек проєктів, без бази. */
export async function aggregateCosts(options: AggregateOptions): Promise<StatsReport> {
  const { storage } = options;
  const targetUsd = options.targetUsd ?? costTargetUsd();
  const chatUrl = options.chatUrl ?? ((id: string) => `/?project=${encodeURIComponent(id)}`);
  const now = options.now ?? (() => new Date());

  const rows: StatsRow[] = [];
  const allEvents: CostEvent[] = [];
  for (const id of await storage.listDirs(PROJECTS_DIR)) {
    const r = await projectStatsRow(storage, id, { targetUsd, chatUrl });
    if (!r) continue;
    rows.push(r.row);
    allEvents.push(...r.events);
  }
  rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const shared = await readCosts(storage, null);
  const chatRows = rows.filter((r) => r.source === "chat");
  const chatIds = new Set(chatRows.map((r) => r.projectId));
  const chatEvents = allEvents.filter((e) => e.projectId !== null && chatIds.has(e.projectId));
  const delivered = chatRows.filter((r) => r.delivered);
  const totalUsd = sumUsd(chatEvents);

  const fixed = options.prices?.fixedMonthly;
  const fixedValues = fixed ? [fixed.remotion, fixed.elevenlabs, fixed.server].filter((v) => v !== null) : [];

  return {
    generatedAt: now().toISOString(),
    rows,
    summary: {
      totalUsd,
      deliveredCount: delivered.length,
      perDeliveredVideo: distribution(delivered.map((r) => r.totalUsd)),
      allInPerDelivered: delivered.length > 0 ? round2(totalUsd / delivered.length) : null,
      byStage: groupUsd(chatEvents, (e) => e.stage).map(({ key, usd }) => ({ stage: key, usd })),
      byProvider: groupUsd(chatEvents, (e) => e.provider).map(({ key, usd }) => ({ provider: key, usd })),
      bySource: {
        chat: totalUsd,
        eval: sumUsd(allEvents, (e) => e.source === "eval"),
        test: sumUsd(allEvents, (e) => e.source === "test") + sumUsd(shared, (e) => e.source === "test"),
      },
      sharedUsd: sumUsd(shared),
      targetUsd,
      fixedMonthlyUsd: fixedValues.length > 0 ? fixedValues.reduce((a, b) => a + b, 0) : null,
    },
  };
}

const CSV_COLUMNS: Array<[keyof StatsRow, string]> = [
  ["createdAt", "date"],
  ["projectId", "project"],
  ["site", "site"],
  ["status", "status"],
  ["source", "source"],
  ["formats", "formats"],
  ["videoSeconds", "video_seconds"],
  ["firstDeliveryUsd", "first_delivery_usd"],
  ["revisionUsd", "revisions_usd"],
  ["totalUsd", "total_usd"],
  ["revisionsCount", "revisions"],
  ["fixesCount", "fixes"],
  ["templateScenesCount", "template_scenes"],
  ["machineSecondsToFirstDelivery", "machine_seconds_to_first_delivery"],
  ["overTarget", "over_target"],
  ["chatUrl", "chat_url"],
];

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = Array.isArray(value) ? value.join(" ") : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

/** Таблиця проєктів у CSV для вставки в Google Sheets. */
export function statsToCsv(rows: readonly StatsRow[]): string {
  const header = CSV_COLUMNS.map(([, h]) => h).join(",");
  const lines = rows.map((r) => CSV_COLUMNS.map(([k]) => csvCell(r[k])).join(","));
  return `${[header, ...lines].join("\n")}\n`;
}
