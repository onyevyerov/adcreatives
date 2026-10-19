import { aggregateCosts, type StatsReport, type StatsRow, statsToCsv } from "@adc/shared";
import { Hono } from "hono";
import type { ApiDeps } from "../deps.ts";
import type { AppEnv } from "../session.ts";

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const usd = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `$${n.toFixed(2)}`);
const num = (n: number | null | undefined, digits = 0) =>
  n === null || n === undefined ? "—" : n.toFixed(digits);

const ROW_HEADERS = [
  "Дата",
  "Сайт",
  "Статус",
  "Формати",
  "Тривалість, с",
  "До першої видачі",
  "Правки",
  "Разом",
  "Кількість правок",
  "Фіксів",
  "Сцен-шаблонів",
  "Машинний час до видачі, с",
  "Позначка",
  "Чат",
];

function rowHtml(r: StatsRow): string {
  const cells = [
    r.createdAt.slice(0, 16).replace("T", " "),
    r.site,
    r.source === "chat" ? r.status : `${r.status} (${r.source})`,
    r.formats.join(", "),
    num(r.videoSeconds, 1),
    usd(r.firstDeliveryUsd),
    usd(r.revisionUsd),
    usd(r.totalUsd),
    r.revisionsCount,
    r.fixesCount,
    r.templateScenesCount,
    num(r.machineSecondsToFirstDelivery, 1),
  ].map((v) => `<td>${escapeHtml(v)}</td>`);
  cells.push(`<td>${r.overTarget ? "<strong>понад ціль</strong>" : ""}</td>`);
  cells.push(`<td><a href="${escapeHtml(r.chatUrl)}">відкрити</a></td>`);
  return `<tr data-project="${escapeHtml(r.projectId)}"${r.overTarget ? ' data-over-target="1"' : ""}>${cells.join("")}</tr>`;
}

export function renderStatsHtml(report: StatsReport): string {
  const s = report.summary;
  const d = s.perDeliveredVideo;
  const list = (items: Array<{ key: string; usd: number }>) =>
    items.length === 0
      ? "<li>—</li>"
      : items.map((i) => `<li>${escapeHtml(i.key)}: ${usd(i.usd)}</li>`).join("");
  const fullCost =
    s.fixedMonthlyUsd !== null
      ? `<p>Фіксовані щомісячні витрати: ${usd(s.fixedMonthlyUsd)}. Повна собівартість за місяць (фіксовані + змінні): ${usd(
          s.fixedMonthlyUsd + s.totalUsd,
        )}${
          s.deliveredCount > 0
            ? `, на готове відео: ${usd((s.fixedMonthlyUsd + s.totalUsd) / s.deliveredCount)}`
            : ""
        }.</p>`
      : "";
  return `<!doctype html>
<html lang="uk">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AdCreative — статистика</title>
</head>
<body>
<h1>Статистика витрат</h1>
<p><a href="/">← до чату</a> · <a href="/api/stats.csv">CSV для Google Sheets</a> · <a href="/api/stats">JSON</a></p>
<p>Ціль: ${usd(s.targetUsd)} за відео (лише позначка). Згенеровано: ${escapeHtml(report.generatedAt)}.</p>
<h2>Проєкти</h2>
<table border="1" cellpadding="4" cellspacing="0">
<thead><tr>${ROW_HEADERS.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead>
<tbody>
${report.rows.length > 0 ? report.rows.map(rowHtml).join("\n") : `<tr><td colspan="${ROW_HEADERS.length}">Ще немає проєктів.</td></tr>`}
</tbody>
</table>
<h2>Підсумок (чат)</h2>
<ul>
<li>Усього витрачено: ${usd(s.totalUsd)}</li>
<li>Готових відео: ${s.deliveredCount}</li>
<li>На готове відео — середня: ${usd(d.mean)}, медіана: ${usd(d.median)}, 90-й перцентиль: ${usd(d.p90)}, максимум: ${usd(d.max)}</li>
<li>Усі витрати / кількість готових відео (з покинутими): ${usd(s.allInPerDelivered)}</li>
</ul>
<h3>За етапами</h3>
<ul>${list(s.byStage.map((x) => ({ key: x.stage, usd: x.usd })))}</ul>
<h3>За провайдерами</h3>
<ul>${list(s.byProvider.map((x) => ({ key: x.provider, usd: x.usd })))}</ul>
<h3>Окремо</h3>
<ul>
<li>eval: ${usd(s.bySource.eval)}</li>
<li>test: ${usd(s.bySource.test)}</li>
<li>Спільне (кеш SFX тощо): ${usd(s.sharedUsd)}</li>
</ul>
${fullCost}
</body>
</html>
`;
}

export function statsRoutes(deps: ApiDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const report = () =>
    aggregateCosts({
      storage: deps.storage,
      targetUsd: deps.config.costTargetUsd,
      now: deps.config.now,
      ...(deps.config.prices ? { prices: deps.config.prices } : {}),
    });

  app.get("/api/stats", async (c) => c.json(await report()));

  app.get("/api/stats.csv", async (c) =>
    c.body(statsToCsv((await report()).rows), 200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="adcreative-stats.csv"',
    }),
  );

  app.get("/stats", async (c) => c.html(renderStatsHtml(await report())));

  return app;
}
