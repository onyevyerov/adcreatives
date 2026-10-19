/**
 * Живий smoke Epidemic Sound (вручну, лише власник, з одного checkout — ТЗ §5):
 *   LIVE=1 pnpm --filter @adc/audio live:epidemic                 — пошук без завантажень
 *   LIVE=1 pnpm --filter @adc/audio live:epidemic -- --download-one — + одне завантаження SFX (−1 з квоти)
 *
 * Пошук треків (`term` + BPM 90±6, `vocalType=NONE`) і SFX (`whoosh`), друк перших 5 результатів і
 * значення лічильника завантажень (`ADC_EPIDEMIC_DIR`/downloads.json). Пошук квоту не витрачає;
 * `--download-one` — єдиний платний крок: download-URL семпла через квоту і байти у теку Epidemic.
 * Без `LIVE=1` — пояснення і вихід 0.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createConsoleLogger, isLive, loadRootEnv } from "@adc/shared";
import { createEpidemicClient } from "../src/epidemic/client.ts";
import { classifyEpidemicError } from "../src/epidemic/errors.ts";
import { EpidemicGate } from "../src/epidemic/gate.ts";
import { createEpidemicQuota, epidemicDir } from "../src/epidemic/quota.ts";
import { EPIDEMIC_DOWNLOAD_LIMIT, EPIDEMIC_DOWNLOAD_SOFT_LIMIT } from "../src/provider.ts";

const TARGET_BPM = 90;
const BPM_SPREAD = 6;
const TRACK_TERM = "warm upbeat acoustic pop for a product ad";
const SFX_TERM = "whoosh";

function fail(stage: string, err: unknown): void {
  const info = classifyEpidemicError(err);
  console.error(`✗ ${stage}: kind=${info.kind}, status=${info.status} — ${(err as Error)?.message ?? err}`);
}

async function main(): Promise<number> {
  loadRootEnv();
  const downloadOne = process.argv.includes("--download-one");
  if (!isLive()) {
    console.log(
      "Живий smoke Epidemic вимкнено. Запуск: LIVE=1 pnpm --filter @adc/audio live:epidemic " +
        "(пошук без завантажень); `-- --download-one` — ще одне завантаження SFX (витрачає квоту).",
    );
    return 0;
  }
  if (!process.env.EPIDEMIC_API_KEY?.trim()) {
    console.error("Немає EPIDEMIC_API_KEY (кореневий .env або змінна середовища).");
    return 1;
  }

  const logger = createConsoleLogger({ run: "live-epidemic" });
  const client = createEpidemicClient();
  const gate = new EpidemicGate({ maxConcurrent: 1, logger });
  const dir = epidemicDir();
  const quota = createEpidemicQuota(dir);
  let failed = 0;

  console.log(
    `Лічильник: ${await quota.used()} з ${EPIDEMIC_DOWNLOAD_LIMIT} (поріг ${EPIDEMIC_DOWNLOAD_SOFT_LIMIT}) → ${dir}`,
  );

  try {
    const { tracks } = await gate.run("live:searchTracks", (signal) =>
      client.searchTracks(
        {
          term: TRACK_TERM,
          bpmMin: TARGET_BPM - BPM_SPREAD,
          bpmMax: TARGET_BPM + BPM_SPREAD,
          vocalType: ["NONE"],
          limit: 5,
        },
        { ...(signal ? { signal } : {}) },
      ),
    );
    console.log(`✓ треки (${tracks.length}):`);
    for (const t of tracks.slice(0, 5)) {
      console.log(
        `  ${t.id} · ${t.title} — ${t.mainArtists.join(", ")} · ${t.bpm ?? "?"} BPM · ${t.length.toFixed(1)} с · ` +
          `вокал: ${t.hasVocals ? "так" : "ні"} · ${t.moods.map((m) => m.name).join("/")}`,
      );
    }
  } catch (err) {
    failed++;
    fail("пошук треків", err);
  }

  let firstSfx: { id: string; title: string } | null = null;
  try {
    const { soundEffects } = await gate.run("live:searchSoundEffects", (signal) =>
      client.searchSoundEffects({ term: SFX_TERM, limit: 5 }, { ...(signal ? { signal } : {}) }),
    );
    console.log(`✓ SFX «${SFX_TERM}» (${soundEffects.length}):`);
    for (const s of soundEffects.slice(0, 5))
      console.log(`  ${s.id} · ${s.title} · ${s.length.toFixed(2)} с`);
    firstSfx = soundEffects[0] ?? null;
  } catch (err) {
    failed++;
    fail("пошук SFX", err);
  }

  if (downloadOne) {
    if (!firstSfx) {
      console.error("✗ завантаження: немає семпла з пошуку");
      failed++;
    } else {
      try {
        const sfx = firstSfx;
        // Спершу квота (кидає на порозі 45, не інкрементуючи), потім платний виклик.
        const used = await quota.consume("sfx", sfx.id, `live:${SFX_TERM}`);
        const { url } = await gate.run("live:sfxDownload", (signal) =>
          client.soundEffectDownloadUrl(sfx.id, { quality: "normal" }, { ...(signal ? { signal } : {}) }),
        );
        const bytes = await gate.run("live:fetchBytes", (signal) =>
          client.fetchBytes(url, { ...(signal ? { signal } : {}) }),
        );
        const file = path.join(dir, "live", `sfx-${sfx.id}.mp3`);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, bytes);
        console.log(`✓ завантажено «${sfx.title}»: ${bytes.length} байт → ${file}; лічильник ${used}`);
      } catch (err) {
        failed++;
        fail("завантаження SFX", err);
      }
    }
  } else {
    console.log("Завантажень не було (додайте `-- --download-one`, щоб перевірити одне).");
  }

  console.log(`Лічильник після: ${await quota.used()} з ${EPIDEMIC_DOWNLOAD_LIMIT}`);
  return failed === 0 ? 0 : 1;
}

process.exitCode = await main();
