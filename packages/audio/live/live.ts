/**
 * Живий прогін B5 (один раз, вручну, після хвилі 1):
 *   LIVE=1 pnpm --filter @adc/audio live
 *
 * Перевіряє на справжньому ElevenLabs: ≈5 с музики через composeDetailed (music_v2_5), один
 * стандартний SFX (whoosh), а також як API відповідає на промпт з іменем артиста
 * (чи повертає запропоновану заміну — див. «Ключові технічні довідки» ТЗ). Пропустити пробу:
 * LIVE_SKIP_PROBE=1. Витрати пишуться у DATA_DIR/costs-shared.jsonl з source=test.
 * Файли — у DATA_DIR/live/audio/.
 */
import {
  type AudioPlan,
  createConsoleLogger,
  createCostRecorder,
  createPromptLoader,
  isLive,
  loadPrices,
  loadRootEnv,
  readCosts,
  storageFromEnv,
  sumUsd,
} from "@adc/shared";
import { audioBytes, createElevenLabsClient } from "../src/client.ts";
import { MUSIC_MODEL_ID, MUSIC_OUTPUT_FORMAT } from "../src/constants.ts";
import { classifyElevenLabsError } from "../src/errors.ts";
import { ElevenLabsGate } from "../src/gate.ts";
import { generateMusic } from "../src/music.ts";
import { generateSfx, loadStandardCues } from "../src/sfx.ts";

const LIVE_MS = 5_000;

async function main(): Promise<number> {
  loadRootEnv();
  if (!isLive()) {
    console.log(
      "Живий прогін вимкнено (платні виклики ElevenLabs). Запуск: LIVE=1 pnpm --filter @adc/audio live",
    );
    return 0;
  }
  if (!process.env.ELEVENLABS_API_KEY) {
    console.error("Немає ELEVENLABS_API_KEY (кореневий .env або змінна середовища).");
    return 1;
  }

  const storage = storageFromEnv();
  const before = (await readCosts(storage, null)).length;
  const logger = createConsoleLogger({ run: "live-audio" });
  const client = createElevenLabsClient();
  const gate = new ElevenLabsGate({ maxConcurrent: 1, logger });
  const cost = createCostRecorder(storage, loadPrices(), {
    projectId: null,
    rev: null,
    stage: "live",
    phase: "first_delivery",
    source: "test",
    attempt: 1,
  });
  let failed = 0;

  const plan: AudioPlan = {
    compositionPlan: {
      positiveGlobalStyles: ["warm lo-fi hip hop", "85 BPM", "rhodes piano", "soft drums", "instrumental"],
      negativeGlobalStyles: ["vocals", "lyrics"],
      chunks: [
        {
          label: "intro",
          sceneIds: ["s1"],
          durationMs: LIVE_MS,
          positiveStyles: ["gentle intro", "vinyl crackle"],
          negativeStyles: [],
          contextAdherence: "high",
        },
      ],
    },
    key: null,
    promptFallback: "Warm lo-fi hip hop at 85 BPM with rhodes piano and soft drums, instrumental",
    sfx: [],
  };

  try {
    const started = Date.now();
    const music = await generateMusic({ storage, client: () => client, gate, cost, logger }, plan);
    const key = `live/audio/music-${music.method}.mp3`;
    await storage.write(key, music.audio);
    console.log(
      `✓ музика: ${music.method}, ${music.audio.length} байт, ${Date.now() - started} мс → ${storage.absPath(key)}`,
    );
  } catch (err) {
    failed++;
    console.error(`✗ музика: ${(err as Error).message}`);
  }

  try {
    const library = loadStandardCues(createPromptLoader());
    const audio = await generateSfx(
      { storage, client: () => client, gate, logger },
      cost,
      "whoosh",
      library.whoosh,
    );
    const key = "live/audio/whoosh.mp3";
    await storage.write(key, audio);
    console.log(`✓ SFX whoosh: ${audio.length} байт → ${storage.absPath(key)}`);
  } catch (err) {
    failed++;
    console.error(`✗ SFX: ${(err as Error).message}`);
  }

  if (process.env.LIVE_SKIP_PROBE !== "1") {
    // Проба: промпт з іменами артистів — чи відхиляє API і чи дає заміну.
    const prompt = "Upbeat synth pop in the style of Daft Punk and Taylor Swift, instrumental";
    try {
      const res = await client.music.compose(
        {
          prompt,
          musicLengthMs: LIVE_MS,
          forceInstrumental: true,
          modelId: MUSIC_MODEL_ID,
          outputFormat: MUSIC_OUTPUT_FORMAT,
        },
        { timeoutInSeconds: 300, maxRetries: 0 },
      );
      const audio = await audioBytes(res);
      await cost.record({
        provider: "elevenlabs",
        kind: "music",
        model: MUSIC_MODEL_ID,
        seconds: LIVE_MS / 1000,
        detail: "music:probe-accepted",
      });
      console.log(
        `! проба: API ПРИЙНЯВ промпт з іменами артистів (${audio.length} байт) — санітизація лишається`,
      );
    } catch (err) {
      const info = classifyElevenLabsError(err);
      console.log(
        `✓ проба: відхилено — kind=${info.kind}, status=${info.status}, code=${info.code}, ` +
          `promptSuggestion=${JSON.stringify(info.promptSuggestion)}, planSuggestion=${info.planSuggestion ? "так" : "ні"}`,
      );
      console.log(`  повідомлення API: ${info.message.slice(0, 1500)}`);
    }
  }

  const fresh = (await readCosts(storage, null)).slice(before);
  console.log(
    `Записів витрат: ${fresh.length}, разом $${sumUsd(fresh).toFixed(4)} → ${storage.absPath("costs-shared.jsonl")}`,
  );
  if (fresh.length === 0) {
    console.error("✗ витрати не записались");
    failed++;
  }
  return failed === 0 ? 0 : 1;
}

process.exitCode = await main();
