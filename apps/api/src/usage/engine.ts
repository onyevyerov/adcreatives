import type {
  UsageAggregate,
  UsageEngine,
  UsageEngineDeps,
  UsageSource,
  UsageSummaryTotals,
} from "./types.ts";

/** Крок 0 · заглушка: валідні порожні відповіді. Тіло — B1. */

const emptyAggregate = (): UsageAggregate => ({
  calls: 0,
  tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0 },
  audioSeconds: 0,
  renders: 0,
  usd: 0,
});

/** Кредити рахуються лише для клієнтських витрат. */
const hasCredits = (source: UsageSource) => source === "chat" || source === "all";

export function createUsageEngine(_deps: UsageEngineDeps): UsageEngine {
  return {
    async summary(q) {
      const credits = hasCredits(q.source) ? 0 : null;
      const totals: UsageSummaryTotals = {
        ...emptyAggregate(),
        users: 0,
        projects: 0,
        delivered: 0,
        avgUsdPerDelivered: null,
        avgUsdPerRevision: null,
        creditsCharged: credits,
        creditsUsd: credits,
        marginUsd: credits,
      };
      return {
        from: q.from,
        to: q.to,
        source: q.source,
        totals,
        byModel: [],
        byStage: [],
        system: emptyAggregate(),
      };
    },
    async users(q) {
      return { from: q.from, to: q.to, source: q.source, users: [] };
    },
    async projects(q) {
      return {
        owner: q.owner,
        from: q.from,
        to: q.to,
        source: q.source,
        page: q.page,
        pageSize: q.pageSize,
        total: 0,
        items: [],
        totals: emptyAggregate(),
      };
    },
    async csv() {
      return [];
    },
  };
}
