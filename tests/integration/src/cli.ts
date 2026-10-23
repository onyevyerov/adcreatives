import { readFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import {
  aggregateCosts,
  type ChatEvent,
  createAnthropicClient,
  dataDir as defaultDataDir,
  type Format,
  LocalStorage,
  loadPrices,
  loadRootEnv,
  noopLogger,
  type ProjectStatus,
  type RunSource,
  statsToCsv,
} from "@adc/shared";
import { autoApprove, createHarness, FORMAT_LABEL, type Harness } from "./harness.ts";

/**
 * `pnpm tsx scripts/cli.ts` — пайплайн з термінала, без API, Redis і браузера:
 *   run <url> | --text "…"   діалог у терміналі (Enter — затвердити, текст — правка)
 *   stats [--csv]             зведена статистика витрат із DATA_DIR
 * Проєкти пишуться в той самий DATA_DIR, що й у API, — їх видно на /stats.
 */

export const CLI_USAGE = `Використання: pnpm tsx scripts/cli.ts <команда>
  run <url> [опції]          прогнати сайт через пайплайн у терміналі
    --text "<опис бізнесу>"  без сайту (ручний режим) або на додачу до нього
    --photo <файл>           фото клієнта (можна кілька разів)
    --formats 9:16,1:1       формати (дефолт — запитає бренд-кіт, 9:16)
    --auto                   затверджувати всі чекпоінти автоматично
    --source chat|test       джерело в обліку витрат (дефолт test)
  stats [--csv]              зведена статистика витрат (DATA_DIR)
Платні виклики Anthropic/ElevenLabs — ключі з кореневого .env.`;

/**
 * Рядок текстів `items` сцени для чекпоінта 2: `· текст · текст ⚠`; ⚠ — у пункті є непідтверджене
 * твердження. null — сцена без items. (Чат більше не показує items — це лише для термінала.)
 */
function formatSceneItems(
  scene: { id: string; items: ReadonlyArray<{ id: string; text: string }> },
  unverified: ReadonlyArray<{ sceneId: string; field: string; itemId?: string | null }>,
): string | null {
  if (scene.items.length === 0) return null;
  const flagged = new Set(
    unverified.filter((c) => c.sceneId === scene.id && c.field === "item").map((c) => c.itemId),
  );
  return scene.items.map((i) => `· ${i.text}${flagged.has(i.id) ? " ⚠" : ""}`).join(" ");
}

const FORMAT_INPUT: Record<string, Format> = {
  "9:16": "vertical",
  vertical: "vertical",
  "1:1": "square",
  square: "square",
  "16:9": "landscape",
  landscape: "landscape",
};

export interface RunArgs {
  url: string | null;
  text: string | null;
  photos: string[];
  formats: Format[] | null;
  auto: boolean;
  source: RunSource;
}

export function parseRunArgs(argv: readonly string[]): RunArgs {
  const out: RunArgs = { url: null, text: null, photos: [], formats: null, auto: false, source: "test" };
  const rest = [...argv];
  const value = (flag: string) => {
    const v = rest.shift();
    if (v === undefined) throw new Error(`${flag}: потрібне значення`);
    return v;
  };
  while (rest.length > 0) {
    const a = rest.shift() as string;
    if (a === "--text") out.text = value(a);
    else if (a === "--photo") out.photos.push(path.resolve(value(a)));
    else if (a === "--auto") out.auto = true;
    else if (a === "--source") {
      const s = value(a);
      if (s !== "chat" && s !== "test") throw new Error(`--source: chat або test, а не "${s}"`);
      out.source = s;
    } else if (a === "--formats") {
      const formats = value(a)
        .split(",")
        .map((f) => f.trim().toLowerCase())
        .filter(Boolean)
        .map((f) => {
          const found = FORMAT_INPUT[f];
          if (!found) throw new Error(`--formats: невідомий формат "${f}" (9:16, 1:1, 16:9)`);
          return found;
        });
      out.formats = formats;
    } else if (a.startsWith("--")) throw new Error(`невідомий аргумент "${a}"`);
    else if (!out.url) out.url = a;
    else throw new Error(`зайвий аргумент "${a}"`);
  }
  if (!out.url && !out.text) throw new Error("потрібен URL сайту або --text");
  return out;
}

/** `/files/<ключ>` → шлях у DATA_DIR (у терміналі зручніше відкрити файл). */
function localPath(root: string, url: string): string {
  const key = url.replace(/^\/files\//, "").split("?")[0] ?? "";
  return path.join(root, ...decodeURIComponent(key).split("/"));
}

/** Людський рядок для події чату. */
export function formatEvent(event: ChatEvent, root: string): string | null {
  switch (event.type) {
    case "message":
      if (event.role === "user") return null;
      return `💬 ${event.text}${event.buttons?.length ? `  [${event.buttons.join(", ")}]` : ""}`;
    case "progress":
      return `… ${event.label}${event.total ? ` ${event.done ?? 0}/${event.total}` : ""}`;
    case "state":
      return `── ${event.prev ?? "—"} → ${event.status} (rev ${event.rev})`;
    case "cost":
      return `$ Витрачено: $${event.totalUsd.toFixed(2)}${event.stage ? ` (${event.stage}: $${event.stageUsd.toFixed(3)})` : ""}`;
    case "error":
      return `! ${event.message}${event.retryable ? " (можна повторити: /retry)" : ""}`;
    case "preview":
      return event.url
        ? `▶ Превʼю ${FORMAT_LABEL[event.format]}: ${localPath(root, event.url)}`
        : `▶ Превʼю ${FORMAT_LABEL[event.format]} не вдалося`;
    case "artifact":
      return `📎 ${event.kind}${event.format ? ` ${FORMAT_LABEL[event.format]}` : ""}: ${localPath(root, event.url)}`;
    case "checkpoint": {
      const p = event.payload;
      if (p.checkpoint === "brand") {
        const k = p.brandkit;
        const lines = [
          `══ Чекпоінт 1 — бренд: ${k.identity.name} (${k.identity.category}, ${k.identity.language})`,
          `   палітра: ${Object.values(k.palette).join(" ")}`,
          `   шрифти: ${k.typography.heading.family} / ${k.typography.body.family}; тон: ${k.voice.tone.join(", ")}`,
          `   факти: ${k.facts.map((f) => `${f.id} ${f.text}`).join("; ") || "—"}`,
          `   лого: ${p.logoCandidates.map((l) => `${l.assetId} ${localPath(root, l.url)}`).join(", ") || "текстове"}`,
          ...k.questions.map((q) => `   ? ${q.text} (дефолт: ${q.default})`),
          `   формати: ${p.formats.map((f) => FORMAT_LABEL[f]).join(", ")}${p.languageOptions.length > 1 ? `; мовні версії: ${p.languageOptions.map((l) => l.lang).join(", ")}` : ""}`,
          ...(p.needMorePhotos ? ["   ! Придатних фото мало — додайте свої (--photo)"] : []),
        ];
        return lines.join("\n");
      }
      if (p.checkpoint === "script") {
        const flagged = new Set(p.claims.unverified.filter((c) => c.field !== "item").map((c) => c.sceneId));
        return [
          `══ Чекпоінт 2 — тексти (${p.durationSeconds} с): ${p.storyboard.concept}`,
          ...p.storyboard.scenes.flatMap((s) => {
            const items = formatSceneItems(s, p.claims.unverified);
            return [
              `   ${s.id} [${s.purpose}] ${s.text.headline}${s.text.sub ? ` / ${s.text.sub}` : ""}${flagged.has(s.id) ? "  ⚠ непідтверджене" : ""}`,
              ...(items ? [`      ${items}`] : []),
            ];
          }),
          ...p.claims.unverified.map(
            (c) =>
              `   ⚠ ${c.sceneId}${c.itemId ? `/${c.itemId}` : ""}: «${c.text}» — немає на сайті; «Затвердити» = факт від клієнта`,
          ),
          `   музика: ${p.musicBrief.genre}, ${p.musicBrief.bpm} bpm`,
        ].join("\n");
      }
      return [
        `══ Чекпоінт 3 — розкадровка (${FORMAT_LABEL[p.primaryFormat]})`,
        ...p.stills.filter((s) => s.variant === "a").map((s) => `   ${s.sceneId}: ${localPath(root, s.url)}`),
        ...p.sheets.map((s) => `   аркуш ${FORMAT_LABEL[s.format]}: ${localPath(root, s.url)}`),
        ...(p.music ? [`   музика: ${localPath(root, p.music.url)}`] : []),
        ...p.warnings.map(
          (w) => `   ⚠ ${w.sceneId} ${FORMAT_LABEL[w.format]} ${w.severity}: ${w.description}`,
        ),
        ...(p.templateScenes.length ? [`   шаблонні сцени: ${p.templateScenes.join(", ")}`] : []),
      ].join("\n");
    }
  }
}

/** Діалог у терміналі: черга в пам'яті спорожніє саме тоді, коли пайплайн чекає людину. */
async function interactive(harness: Harness, projectId: string): Promise<ProjectStatus | null> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      await harness.queue.idle();
      const status = await harness.status(projectId);
      if (status === "failed") {
        const answer = (await rl.question("Етап не вдався. /retry — повторити, Enter — вийти: ")).trim();
        if (answer !== "/retry") return status;
        await harness.command(projectId, { type: "retry" });
        continue;
      }
      if (status === "delivered") {
        const answer = (await rl.question("Готово. Правка (текст) або Enter — завершити: ")).trim();
        if (!answer) return status;
        await harness.say(projectId, answer);
        continue;
      }
      if (!status || !["awaiting_brand", "awaiting_script", "awaiting_storyboard"].includes(status)) {
        return status; // пайплайн зупинився поза чекпоінтом — не чекаємо вічно
      }
      const answer = (
        await rl.question("Enter — затвердити, текст — відповідь/правка, /logo <assetId>, /quit: ")
      ).trim();
      if (answer === "/quit") return status;
      const rev = (await harness.driver.load(projectId))?.project.rev ?? null;
      if (!answer) await harness.command(projectId, { type: "approve", rev });
      else if (answer.startsWith("/logo ")) {
        await harness.command(projectId, { type: "set_logo", assetId: answer.slice(6).trim() });
      } else await harness.say(projectId, answer);
    }
  } finally {
    rl.close();
  }
}

async function runCommand(argv: readonly string[], print: (l: string) => void): Promise<number> {
  const args = parseRunArgs(argv);
  loadRootEnv();
  if (!process.env.ANTHROPIC_API_KEY || !process.env.ELEVENLABS_API_KEY) {
    print("cli: потрібні ANTHROPIC_API_KEY і ELEVENLABS_API_KEY у кореневому .env.");
    return 2;
  }
  const root = defaultDataDir();
  const harness = createHarness({
    dataDir: root,
    anthropic: () => createAnthropicClient(),
    logger: noopLogger,
  });
  harness.events.on((_pid, ev) => {
    const line = formatEvent(ev, root);
    if (line) print(line);
  });
  const formats = args.formats;
  if (args.auto) autoApprove(harness, { formats });
  else if (formats) {
    // Формати — службовою реплікою на першому чекпоінті (розбирається без LLM).
    const off = harness.events.on((pid, ev) => {
      if (ev.type === "checkpoint" && ev.checkpoint === "brand") {
        off();
        void harness.say(pid, `Формати: ${formats.map((f) => FORMAT_LABEL[f]).join(", ")}`);
      }
    });
  }
  const photos = await Promise.all(
    args.photos.map(async (p) => ({ name: path.basename(p), data: await readFile(p) })),
  );
  const projectId = await harness.createProject({
    url: args.url,
    manualText: args.text,
    photos,
    origin: args.source,
  });
  print(`Проєкт ${projectId}, дані: ${path.join(root, "projects", projectId)}`);
  const status = args.auto
    ? await harness.waitForStatus(projectId, ["delivered", "failed"], 4 * 60 * 60_000)
    : await interactive(harness, projectId);
  await harness.queue.idle();
  print(`Стан: ${status ?? "?"}`);
  return status === "delivered" ? 0 : 1;
}

async function statsCommand(argv: readonly string[], print: (l: string) => void): Promise<number> {
  loadRootEnv();
  const storage = new LocalStorage(defaultDataDir());
  let prices: ReturnType<typeof loadPrices> | undefined;
  try {
    prices = loadPrices();
  } catch {
    prices = undefined;
  }
  const report = await aggregateCosts({ storage, ...(prices ? { prices } : {}) });
  if (argv.includes("--csv")) {
    print(statsToCsv(report.rows));
    return 0;
  }
  const s = report.summary;
  const usd = (v: number | null) => (v === null ? "—" : `$${v.toFixed(2)}`);
  print(`Проєктів: ${report.rows.length}, готових відео: ${s.deliveredCount}`);
  print(
    `Усього (chat): ${usd(s.totalUsd)}; на відео: середня ${usd(s.perDeliveredVideo.mean)}, медіана ${usd(s.perDeliveredVideo.median)}, p90 ${usd(s.perDeliveredVideo.p90)}, макс ${usd(s.perDeliveredVideo.max)}`,
  );
  print(
    `Усі витрати / готові відео: ${usd(s.allInPerDelivered)}; eval ${usd(s.bySource.eval)}, test ${usd(s.bySource.test)}, спільне ${usd(s.sharedUsd)}`,
  );
  for (const r of report.rows.slice(0, 20)) {
    print(
      `  ${r.createdAt.slice(0, 16)} ${r.status.padEnd(19)} ${usd(r.totalUsd).padStart(7)}${r.overTarget ? "!" : " "} ${r.source.padEnd(4)} ${r.site}`,
    );
  }
  return 0;
}

export async function runCli(
  argv: readonly string[],
  print: (l: string) => void = (l) => console.log(l),
): Promise<number> {
  const [cmd, ...rest] = argv;
  try {
    if (cmd === "run") return await runCommand(rest, print);
    if (cmd === "stats") return await statsCommand(rest, print);
    print(CLI_USAGE);
    return cmd === undefined || cmd === "help" || cmd === "--help" ? 0 : 2;
  } catch (err) {
    print(`cli: ${(err as Error).message}\n\n${CLI_USAGE}`);
    return 2;
  }
}
