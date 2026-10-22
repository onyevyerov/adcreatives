import type { CostEvent, CostStage, Provider, User } from "@adc/shared";
import { createSnapshotCache, type ProjectMeta, type UsageSnapshot } from "./snapshot.ts";
import type {
  CsvQuery,
  Order,
  ProjectsQuery,
  ProjectsSort,
  UsageAggregate,
  UsageCsvRow,
  UsageEngine,
  UsageEngineDeps,
  UsageModelRow,
  UsageProjectRow,
  UsageProjectsResponse,
  UsageSource,
  UsageStageRow,
  UsageSummaryResponse,
  UsageUserRow,
  UsageUsersResponse,
  UsageWindow,
  UsersQuery,
} from "./types.ts";

/**
 * B1 · Двигун агрегації вкладки «Використання» (`docs/usage-api.md`). Усе, крім збору знімка, — чисті
 * функції над `UsageSnapshot`: вікно дат, фільтр `source`, групування, сортування, пагінація, маржа, CSV.
 */

const DAY_MS = 86_400_000;

/** Підпис рядка спільних витрат у CSV. */
export const SHARED_CSV_HOST = "(спільні витрати)";

/** Округлення грошей і секунд — як у `sumUsd()`. */
const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

/** Кредити рахуються лише для клієнтських витрат. */
const hasCredits = (source: UsageSource) => source === "chat" || source === "all";

// ── Вікно й фільтри ───────────────────────────────────────────────────────────

/** Межі вікна в мс: `[from 00:00Z, to+1д 00:00Z)`; null — межі немає. */
interface Bounds {
  from: number | null;
  to: number | null;
}

function boundsOf(w: UsageWindow): Bounds {
  return {
    from: w.from === null ? null : Date.parse(`${w.from}T00:00:00.000Z`),
    to: w.to === null ? null : Date.parse(`${w.to}T00:00:00.000Z`) + DAY_MS,
  };
}

function inBounds(ts: string, b: Bounds): boolean {
  const t = Date.parse(ts);
  return (b.from === null || t >= b.from) && (b.to === null || t < b.to);
}

const sourceOk = (e: CostEvent, source: UsageSource) => source === "all" || e.source === source;

// ── Акумулятори ───────────────────────────────────────────────────────────────

interface Acc {
  calls: number;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  audioSeconds: number;
  renders: number;
  usd: number;
}

const newAcc = (): Acc => ({
  calls: 0,
  input: 0,
  output: 0,
  cacheWrite: 0,
  cacheRead: 0,
  audioSeconds: 0,
  renders: 0,
  usd: 0,
});

/** Одиниці розрізняються формою: `TokenUnits` має `input`, `SecondsUnits` — `seconds`, `RendersUnits` — `renders`. */
function addEvent(acc: Acc, e: CostEvent): Acc {
  acc.calls += 1;
  acc.usd += e.usd;
  const u = e.units;
  if ("input" in u) {
    acc.input += u.input;
    acc.output += u.output;
    acc.cacheWrite += u.cacheWrite + u.cacheWrite1h;
    acc.cacheRead += u.cacheRead;
  } else if ("seconds" in u) acc.audioSeconds += u.seconds;
  else if ("renders" in u) acc.renders += u.renders;
  return acc;
}

const accOf = (events: readonly CostEvent[]) => events.reduce(addEvent, newAcc());

function toAggregate(acc: Acc): UsageAggregate {
  return {
    calls: acc.calls,
    tokens: {
      input: acc.input,
      output: acc.output,
      cacheWrite: acc.cacheWrite,
      cacheRead: acc.cacheRead,
      total: acc.input + acc.output + acc.cacheWrite + acc.cacheRead,
    },
    audioSeconds: round6(acc.audioSeconds),
    renders: acc.renders,
    usd: round6(acc.usd),
  };
}

const aggregateOf = (events: readonly CostEvent[]) => toAggregate(accOf(events));

const usdOf = (events: readonly CostEvent[], phase?: CostEvent["phase"]) =>
  events.reduce((s, e) => (phase && e.phase !== phase ? s : s + e.usd), 0);

/** Порівняння рядків за кодами символів (стабільно, без залежності від локалі). */
const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Розбивка по (провайдер, модель); сортування usd ↓, provider ↑, model ↑. */
export function byModel(events: readonly CostEvent[]): UsageModelRow[] {
  const map = new Map<string, { provider: Provider; model: string; acc: Acc }>();
  for (const e of events) {
    const key = `${e.provider}\u0000${e.model}`;
    let g = map.get(key);
    if (!g) {
      g = { provider: e.provider, model: e.model, acc: newAcc() };
      map.set(key, g);
    }
    addEvent(g.acc, e);
  }
  return [...map.values()]
    .map((g) => ({ ...toAggregate(g.acc), provider: g.provider, model: g.model }))
    .sort((a, b) => b.usd - a.usd || cmpStr(a.provider, b.provider) || cmpStr(a.model, b.model));
}

/** Розбивка по етапах; сортування usd ↓, stage ↑. */
export function byStage(events: readonly CostEvent[]): UsageStageRow[] {
  const map = new Map<CostStage, { calls: number; usd: number }>();
  for (const e of events) {
    const g = map.get(e.stage) ?? { calls: 0, usd: 0 };
    g.calls += 1;
    g.usd += e.usd;
    map.set(e.stage, g);
  }
  return [...map.entries()]
    .map(([stage, g]) => ({ stage, calls: g.calls, usd: round6(g.usd) }))
    .sort((a, b) => b.usd - a.usd || cmpStr(a.stage, b.stage));
}

// ── Проєкти у вікні ──────────────────────────────────────────────────────────

/** Проєкт знімка з урахуванням вікна й `source`. */
interface ProjectCalc {
  id: string;
  meta: ProjectMeta | null;
  /** Власник, лише якщо він є серед користувачів (R12); інакше — «Система». */
  owner: User | null;
  /** Події, що пройшли і `source`, і вікно. */
  selected: CostEvent[];
  /** Події з потрібним `source` без обрізання вікном (для `delivered` / `avgUsdPerDelivered`). */
  bySource: CostEvent[];
}

interface Calc {
  projects: ProjectCalc[];
  /** Вибрані події `costs-shared.jsonl`. */
  shared: CostEvent[];
  usersById: Map<string, User>;
  bounds: Bounds;
}

function calc(snap: UsageSnapshot, w: UsageWindow): Calc {
  const bounds = boundsOf(w);
  const usersById = new Map(snap.users.map((u) => [u.id, u]));
  const pick = (events: readonly CostEvent[]) => {
    const bySource = events.filter((e) => sourceOk(e, w.source));
    return { bySource, selected: bySource.filter((e) => inBounds(e.ts, bounds)) };
  };
  const projects = snap.projects.map((p): ProjectCalc => {
    const ownerId = p.meta?.ownerId ?? null;
    return { id: p.id, meta: p.meta, owner: (ownerId && usersById.get(ownerId)) || null, ...pick(p.events) };
  });
  return { projects, shared: pick(snap.shared).selected, usersById, bounds };
}

/** Проєкт у вибірці: ≥1 подія після обох фільтрів. */
const isSelected = (p: ProjectCalc) => p.selected.length > 0;

/** R11: ≥1 подія з потрібним `source` (вікно не важливе) і `firstDeliveredAt` у вікні. */
function isDelivered(p: ProjectCalc, bounds: Bounds): boolean {
  const at = p.meta?.firstDeliveredAt ?? null;
  return p.bySource.length > 0 && at !== null && inBounds(at, bounds);
}

/** `creditsCharged` по леджерах: Σ(−credits) charge − Σ credits refund, `at` у вікні (R14). */
function creditsCharged(snap: UsageSnapshot, userIds: readonly string[], bounds: Bounds): number {
  let total = 0;
  for (const id of userIds)
    for (const entry of snap.ledgers.get(id) ?? []) {
      // charge записано з мінусом (−credits додає), refund — з плюсом (віднімається).
      if ((entry.kind === "charge" || entry.kind === "refund") && inBounds(entry.at, bounds))
        total -= entry.credits;
    }
  return total;
}

const flatSelected = (projects: readonly ProjectCalc[]) => projects.flatMap((p) => p.selected);

// ── summary ──────────────────────────────────────────────────────────────────

export function summaryOf(snap: UsageSnapshot, q: UsageWindow, creditsPerUsd: number): UsageSummaryResponse {
  const c = calc(snap, q);
  const selectedProjects = c.projects.filter(isSelected);
  const projectEvents = flatSelected(selectedProjects);
  const all = [...projectEvents, ...c.shared];
  const systemEvents = [...flatSelected(selectedProjects.filter((p) => !p.owner)), ...c.shared];
  const ownedUsd = usdOf(flatSelected(selectedProjects.filter((p) => p.owner)));

  const delivered = c.projects.filter((p) => isDelivered(p, c.bounds));
  const deliveredUsd = usdOf(
    delivered.flatMap((p) => p.bySource),
    "first_delivery",
  );
  // Правки рахуються лише по подіях проєктів: спільні витрати не належать жодній (projectId, rev).
  const revisionEvents = projectEvents.filter((e) => e.phase === "revision");
  const revisionKeys = new Set(revisionEvents.map((e) => `${e.projectId}\u0000${e.rev}`));

  let credits: { charged: number; usd: number; margin: number } | null = null;
  if (hasCredits(q.source)) {
    const charged = creditsCharged(
      snap,
      snap.users.map((u) => u.id),
      c.bounds,
    );
    const usd = charged / creditsPerUsd;
    credits = { charged, usd: round6(usd), margin: round6(usd - ownedUsd) };
  }

  return {
    from: q.from,
    to: q.to,
    source: q.source,
    totals: {
      ...aggregateOf(all),
      users: new Set(selectedProjects.flatMap((p) => (p.owner ? [p.owner.id] : []))).size,
      projects: selectedProjects.length,
      delivered: delivered.length,
      avgUsdPerDelivered: delivered.length ? round6(deliveredUsd / delivered.length) : null,
      avgUsdPerRevision: revisionKeys.size ? round6(usdOf(revisionEvents) / revisionKeys.size) : null,
      creditsCharged: credits?.charged ?? null,
      creditsUsd: credits?.usd ?? null,
      marginUsd: credits?.margin ?? null,
    },
    byModel: byModel(all),
    byStage: byStage(all),
    system: aggregateOf(systemEvents),
  };
}

// ── users ────────────────────────────────────────────────────────────────────

/** Ключ сортування з null «у кінці незалежно від order»; тайбрейкер — окремо. */
function cmpNullable<T>(a: T | null, b: T | null, order: Order, cmp: (x: T, y: T) => number): number {
  if (a === null || b === null) return a === null ? (b === null ? 0 : 1) : -1;
  return order === "asc" ? cmp(a, b) : cmp(b, a);
}

const cmpNum = (a: number, b: number) => a - b;
const cmpDate = (a: string, b: string) => Date.parse(a) - Date.parse(b);

export function usersOf(snap: UsageSnapshot, q: UsersQuery, creditsPerUsd: number): UsageUsersResponse {
  const c = calc(snap, q);
  const credits = hasCredits(q.source);
  const rows = snap.users.map((u): UsageUserRow => {
    const own = c.projects.filter((p) => p.owner?.id === u.id);
    const events = flatSelected(own);
    const charged = credits ? creditsCharged(snap, [u.id], c.bounds) : null;
    return {
      ...aggregateOf(events),
      id: u.id,
      email: u.email,
      name: u.name,
      createdAt: u.createdAt,
      projects: own.filter(isSelected).length,
      delivered: own.filter((p) => isDelivered(p, c.bounds)).length,
      creditsCharged: charged,
      marginUsd: charged === null ? null : round6(charged / creditsPerUsd - usdOf(events)),
      byModel: byModel(events),
    };
  });
  const byKey = (a: UsageUserRow, b: UsageUserRow): number => {
    switch (q.sort) {
      case "usd":
        return cmpNullable(a.usd, b.usd, q.order, cmpNum);
      case "email":
        return cmpNullable(a.email, b.email, q.order, cmpStr);
      case "projects":
        return cmpNullable(a.projects, b.projects, q.order, cmpNum);
      case "createdAt":
        return cmpNullable(a.createdAt, b.createdAt, q.order, cmpDate);
      case "marginUsd":
        return cmpNullable(a.marginUsd, b.marginUsd, q.order, cmpNum);
    }
  };
  rows.sort((a, b) => byKey(a, b) || cmpStr(a.email, b.email));
  return { from: q.from, to: q.to, source: q.source, users: rows };
}

// ── projects / csv ───────────────────────────────────────────────────────────

/**
 * Вибірка проєктів за `owner` і `search`. null — `owner` є id неіснуючого користувача.
 * `costs-shared.jsonl` сюди не входить.
 */
function selectProjects(c: Calc, owner: string | null, search: string | null): ProjectCalc[] | null {
  if (owner !== null && owner !== "none" && !c.usersById.has(owner)) return null;
  const needle = search?.trim().toLowerCase() ?? "";
  return c.projects.filter((p) => {
    if (!isSelected(p)) return false;
    if (owner === "none" && p.owner) return false;
    if (owner !== null && owner !== "none" && p.owner?.id !== owner) return false;
    if (!needle) return true;
    const hay = [p.meta?.host, p.meta?.url, p.id, owner === null ? p.owner?.email : null];
    return hay.some((s) => typeof s === "string" && s.toLowerCase().includes(needle));
  });
}

function projectRow(p: ProjectCalc): UsageProjectRow {
  const ev = p.selected;
  const revisions = new Set(ev.filter((e) => e.phase === "revision").map((e) => e.rev));
  return {
    ...aggregateOf(ev),
    projectId: p.id,
    ownerId: p.owner?.id ?? null,
    ownerEmail: p.owner?.email ?? null,
    host: p.meta?.host ?? null,
    url: p.meta?.url ?? null,
    status: p.meta?.status ?? null,
    createdAt: p.meta?.createdAt ?? null,
    firstDeliveredAt: p.meta?.firstDeliveredAt ?? null,
    revisions: revisions.size,
    firstDeliveryUsd: round6(usdOf(ev, "first_delivery")),
    revisionUsd: round6(usdOf(ev, "revision")),
    byModel: byModel(ev),
    byStage: byStage(ev),
  };
}

/** Сортування рядків проєктів: ключ (null — у кінці), далі createdAt ↓ (null — у кінці), projectId ↑. */
function sortProjects(rows: UsageProjectRow[], sort: ProjectsSort, order: Order): UsageProjectRow[] {
  const byKey = (a: UsageProjectRow, b: UsageProjectRow): number => {
    switch (sort) {
      case "usd":
        return cmpNullable(a.usd, b.usd, order, cmpNum);
      case "calls":
        return cmpNullable(a.calls, b.calls, order, cmpNum);
      case "tokens":
        return cmpNullable(a.tokens.total, b.tokens.total, order, cmpNum);
      case "createdAt":
        return cmpNullable(a.createdAt, b.createdAt, order, cmpDate);
      case "host":
        return cmpNullable(a.host, b.host, order, cmpStr);
      case "status":
        return cmpNullable(a.status, b.status, order, cmpStr);
      case "ownerEmail":
        return cmpNullable(a.ownerEmail, b.ownerEmail, order, cmpStr);
    }
  };
  return rows.sort(
    (a, b) =>
      byKey(a, b) ||
      cmpNullable(a.createdAt, b.createdAt, "desc", cmpDate) ||
      cmpStr(a.projectId, b.projectId),
  );
}

export function projectsOf(snap: UsageSnapshot, q: ProjectsQuery): UsageProjectsResponse | null {
  const c = calc(snap, q);
  const selected = selectProjects(c, q.owner, q.search);
  if (!selected) return null;
  const rows = sortProjects(selected.map(projectRow), q.sort, q.order);
  const start = (q.page - 1) * q.pageSize;
  return {
    owner: q.owner,
    from: q.from,
    to: q.to,
    source: q.source,
    page: q.page,
    pageSize: q.pageSize,
    total: rows.length,
    items: rows.slice(start, start + q.pageSize),
    totals: aggregateOf(flatSelected(selected)),
  };
}

function csvRow(
  a: UsageAggregate,
  meta: Pick<
    UsageCsvRow,
    | "ownerEmail"
    | "projectId"
    | "host"
    | "status"
    | "createdAt"
    | "firstDeliveredAt"
    | "firstDeliveryUsd"
    | "revisionUsd"
  >,
): UsageCsvRow {
  return {
    ownerEmail: meta.ownerEmail,
    projectId: meta.projectId,
    host: meta.host,
    status: meta.status,
    createdAt: meta.createdAt,
    firstDeliveredAt: meta.firstDeliveredAt,
    calls: a.calls,
    tokensInput: a.tokens.input,
    tokensOutput: a.tokens.output,
    tokensCacheWrite: a.tokens.cacheWrite,
    tokensCacheRead: a.tokens.cacheRead,
    audioSeconds: a.audioSeconds,
    renders: a.renders,
    usd: a.usd,
    firstDeliveryUsd: meta.firstDeliveryUsd,
    revisionUsd: meta.revisionUsd,
  };
}

/** Рядки CSV: вибірка `projects` за `usd ↓`; без `owner` — останнім рядок спільних витрат, завжди (R15). */
export function csvOf(snap: UsageSnapshot, q: CsvQuery): UsageCsvRow[] | null {
  const c = calc(snap, q);
  const selected = selectProjects(c, q.owner, q.search);
  if (!selected) return null;
  const rows = sortProjects(selected.map(projectRow), "usd", "desc").map((r) => csvRow(r, r));
  if (q.owner === null)
    rows.push(
      csvRow(aggregateOf(c.shared), {
        ownerEmail: null,
        projectId: null,
        host: SHARED_CSV_HOST,
        status: null,
        createdAt: null,
        firstDeliveredAt: null,
        firstDeliveryUsd: round6(usdOf(c.shared, "first_delivery")),
        revisionUsd: round6(usdOf(c.shared, "revision")),
      }),
    );
  return rows;
}

// ── Двигун ───────────────────────────────────────────────────────────────────

export function createUsageEngine(deps: UsageEngineDeps): UsageEngine {
  const snapshot = createSnapshotCache(deps);
  return {
    async summary(q) {
      return summaryOf(await snapshot(), q, deps.creditsPerUsd);
    },
    async users(q) {
      return usersOf(await snapshot(), q, deps.creditsPerUsd);
    },
    async projects(q) {
      return projectsOf(await snapshot(), q);
    },
    async csv(q) {
      return csvOf(await snapshot(), q);
    },
  };
}
