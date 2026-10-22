import type { AccountStore, CostStage, ProjectStatus, Provider, RunSource, Storage } from "@adc/shared";

/**
 * Крок 0 · Заморожені форми `GET /api/admin/usage/*` (TS-дзеркало `docs/usage-api.md`).
 * Змінює лише власник Кроку 0 окремим міні-PR.
 */

/** `cacheWrite` = `units.cacheWrite + units.cacheWrite1h`; `total` — сума чотирьох. */
export interface UsageTokens {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  total: number;
}

export interface UsageAggregate {
  /** Кількість рядків `CostEvent`. */
  calls: number;
  /** Лише з `TokenUnits` (Anthropic). */
  tokens: UsageTokens;
  /** `SecondsUnits` (ElevenLabs, Epidemic). */
  audioSeconds: number;
  /** `RendersUnits` (Remotion). */
  renders: number;
  usd: number;
}

/** Сортування: usd ↓, provider ↑, model ↑. */
export type UsageModelRow = UsageAggregate & { provider: Provider; model: string };

/** Сортування: usd ↓, stage ↑. */
export interface UsageStageRow {
  stage: CostStage;
  calls: number;
  usd: number;
}

export type UsageSource = RunSource | "all";

/** Вікно дат (дні UTC, обидві межі включно) і джерело. `null` — межі немає. */
export interface UsageWindow {
  from: string | null;
  to: string | null;
  source: UsageSource;
}

/** `UsageAggregate` по всіх подіях вікна (включно з «Системою») + лічильники й маржа. */
export type UsageSummaryTotals = UsageAggregate & {
  /** Різні власники з ≥1 подією у вікні. */
  users: number;
  /** Проєкти з ≥1 подією у вікні. */
  projects: number;
  /** Проєкти з `firstDeliveredAt` у вікні (без вікна — усі з `firstDeliveredAt ≠ null`). */
  delivered: number;
  /** Σ usd усіх подій phase=first_delivery цих проєктів (не обрізаних вікном) / delivered; null при 0. */
  avgUsdPerDelivered: number | null;
  /** Σ usd подій phase=revision у вікні / кількість різних (projectId, rev) серед них; null при 0. */
  avgUsdPerRevision: number | null;
  /** Σ(−credits) charge − Σ credits refund з леджерів, `at` у вікні; null, якщо source ∉ {chat, all}. */
  creditsCharged: number | null;
  /** creditsCharged / creditsPerUsd; null — як вище. */
  creditsUsd: number | null;
  /** creditsUsd − usd подій проєктів з власником у вікні; null — як вище. */
  marginUsd: number | null;
};

export interface UsageSummaryResponse extends UsageWindow {
  totals: UsageSummaryTotals;
  byModel: UsageModelRow[];
  byStage: UsageStageRow[];
  /** Проєкти без `ownerId` + `costs-shared.jsonl`. */
  system: UsageAggregate;
}

export type UsageUserRow = UsageAggregate & {
  id: string;
  email: string;
  name: string;
  createdAt: string;
  projects: number;
  delivered: number;
  /** null, якщо source ∉ {chat, all}. */
  creditsCharged: number | null;
  /** null, якщо source ∉ {chat, all}. */
  marginUsd: number | null;
  byModel: UsageModelRow[];
};

export interface UsageUsersResponse extends UsageWindow {
  users: UsageUserRow[];
}

export type UsageProjectRow = UsageAggregate & {
  projectId: string;
  /** null — проєкт без власника. */
  ownerId: string | null;
  ownerEmail: string | null;
  /** Хост `input.url`; manual або без мети — null. */
  host: string | null;
  url: string | null;
  /** `"intake"`, якщо є лише `intake.json`; null — мету не вдалося прочитати. */
  status: ProjectStatus | null;
  /** null — мету не вдалося прочитати. */
  createdAt: string | null;
  firstDeliveredAt: string | null;
  /** Різні rev з phase=revision у вікні. */
  revisions: number;
  firstDeliveryUsd: number;
  revisionUsd: number;
  byModel: UsageModelRow[];
  byStage: UsageStageRow[];
};

export interface UsageProjectsResponse extends UsageWindow {
  /** Ехо: null | "none" | "<userId>". */
  owner: string | null;
  page: number;
  pageSize: number;
  /** Проєктів у вибірці (усі сторінки). */
  total: number;
  items: UsageProjectRow[];
  /** По всій вибірці (усі сторінки). */
  totals: UsageAggregate;
}

/**
 * Рядок CSV (`projects.csv`), поля — у порядку колонок. Рядок спільних витрат: `projectId: null`,
 * `host: "(спільні витрати)"`, решта метаданих — null.
 */
export interface UsageCsvRow {
  ownerEmail: string | null;
  projectId: string | null;
  host: string | null;
  status: ProjectStatus | null;
  createdAt: string | null;
  firstDeliveredAt: string | null;
  calls: number;
  tokensInput: number;
  tokensOutput: number;
  tokensCacheWrite: number;
  tokensCacheRead: number;
  audioSeconds: number;
  renders: number;
  usd: number;
  firstDeliveryUsd: number;
  revisionUsd: number;
}

export type UsersSort = "usd" | "email" | "projects" | "createdAt" | "marginUsd";
export type ProjectsSort = "usd" | "createdAt" | "tokens" | "calls" | "host" | "status" | "ownerEmail";
export type Order = "asc" | "desc";

export interface UsersQuery extends UsageWindow {
  sort: UsersSort;
  order: Order;
}

export interface ProjectsQuery extends UsageWindow {
  owner: string | null;
  search: string | null;
  sort: ProjectsSort;
  order: Order;
  page: number;
  pageSize: number;
}

export type CsvQuery = Omit<ProjectsQuery, "sort" | "order" | "page" | "pageSize">;

/** Запити приходять уже розібрані й валідні: валідація — справа роуту. */
export interface UsageEngine {
  summary(q: UsageWindow): Promise<UsageSummaryResponse>;
  users(q: UsersQuery): Promise<UsageUsersResponse>;
  /** null — `owner` є id неіснуючого користувача (роут віддає 404). */
  projects(q: ProjectsQuery): Promise<UsageProjectsResponse | null>;
  /** Уся вибірка для CSV, уже в порядку рядків файлу (включно з рядком спільних витрат). */
  csv(q: CsvQuery): Promise<UsageCsvRow[] | null>;
}

export interface UsageEngineDeps {
  storage: Storage;
  accounts: AccountStore;
  creditsPerUsd: number;
  now?: () => Date;
}
