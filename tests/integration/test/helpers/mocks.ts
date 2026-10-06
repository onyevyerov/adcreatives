import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ElevenLabsLike } from "@adc/audio";
import { type AnthropicLike, createMockAnthropic, type MockReply, type StageName } from "@adc/shared";
import { currentStage } from "../../src/harness.ts";

export const LLM_DIR = fileURLToPath(new URL("../../fixtures/llm", import.meta.url));

/** Записана відповідь LLM: `fixtures/llm/<стадія>.json` (`json` або `text`) + usage реального виклику. */
interface Recorded {
  json?: unknown;
  text?: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

function loadRecorded(stage: string): Recorded {
  const rec = JSON.parse(readFileSync(`${LLM_DIR}/${stage}.json`, "utf8")) as Recorded & {
    textFile?: string;
  };
  if (rec.textFile) rec.text = readFileSync(`${LLM_DIR}/${rec.textFile}`, "utf8");
  return rec;
}

/** Стадії, на які є записані відповіді (audio-план кличеться зі стадії `audio`). */
export const RECORDED_STAGES = ["brandkit", "storyboard", "codegen", "qa", "audio"] as const;

export interface RoutedAnthropic extends AnthropicLike {
  /** Скільки викликів LLM зробила кожна стадія. */
  callsByStage: Map<string, number>;
  /** Виклики поза стадіями (chat-intent/chat-reply) — у цьому тесті їх не має бути. */
  unexpected: string[];
}

/**
 * Мок Anthropic, що відповідає записаною відповіддю тієї стадії, у межах якої зроблено виклик
 * (стадію знає harness через AsyncLocalStorage). Порядок викликів не важливий — codegen і audio
 * йдуть паралельно.
 */
export function recordedAnthropic(): RoutedAnthropic {
  const recorded = new Map<string, Recorded>(RECORDED_STAGES.map((s) => [s, loadRecorded(s)]));
  const callsByStage = new Map<string, number>();
  const unexpected: string[] = [];
  const reply = (): MockReply => {
    const stage: StageName | undefined = currentStage()?.stage;
    const rec = stage ? recorded.get(stage) : undefined;
    if (!stage || !rec) {
      unexpected.push(stage ?? "(оркестратор)");
      return { error: new Error(`немає записаної відповіді LLM для «${stage ?? "оркестратор"}»`) };
    }
    callsByStage.set(stage, (callsByStage.get(stage) ?? 0) + 1);
    return { ...(rec.text !== undefined ? { text: rec.text } : { json: rec.json }), usage: rec.usage };
  };
  // Черга з «безкінечних» функцій: кожен виклик бере відповідь за поточною стадією.
  const mock = createMockAnthropic(Array.from({ length: 200 }, () => () => reply()));
  return { messages: mock.messages, callsByStage, unexpected };
}

/** Синусоїда у WAV (PCM 16 біт, моно) — справжній звук, який Chromium декодує при рендері. */
export function toneWav(seconds: number, frequency = 220, sampleRate = 22_050): Buffer {
  const samples = Math.max(1, Math.round(seconds * sampleRate));
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const v = Math.sin((2 * Math.PI * frequency * i) / sampleRate) * 0.3;
    data.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

export interface MockElevenLabs extends ElevenLabsLike {
  calls: Array<{ method: string; request: Record<string, unknown> }>;
}

/** Мок ElevenLabs: музика й SFX — тональні WAV потрібної довжини. */
export function mockElevenLabs(): MockElevenLabs {
  const calls: MockElevenLabs["calls"] = [];
  const planMs = (req: Record<string, unknown>) => {
    const plan = req.compositionPlan as { chunks?: Array<{ durationMs?: number }> } | undefined;
    return (plan?.chunks ?? []).reduce((a, s) => a + (s.durationMs ?? 0), 0) || 6000;
  };
  return {
    calls,
    music: {
      async composeDetailed(request) {
        const req = request as unknown as Record<string, unknown>;
        calls.push({ method: "composeDetailed", request: req });
        return { json: {}, audio: toneWav(planMs(req) / 1000, 196), filename: "music.mp3" };
      },
      async compose(request) {
        const req = request as unknown as Record<string, unknown>;
        calls.push({ method: "compose", request: req });
        return toneWav(Number(req.musicLengthMs ?? 6000) / 1000, 196);
      },
    },
    textToSoundEffects: {
      async convert(request) {
        const req = request as unknown as Record<string, unknown>;
        calls.push({ method: "convert", request: req });
        return toneWav(Number(req.durationSeconds ?? 0.5), 880);
      },
    },
  };
}
