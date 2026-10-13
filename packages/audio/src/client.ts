import { type ElevenLabs, ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { isPcmFormat } from "./constants.ts";
import { wrapPcm } from "./decode.ts";

/**
 * Мінімальний інтерфейс клієнта ElevenLabs, який використовує B5. Справжній
 * `ElevenLabsClient` йому відповідає; у тестах підставляється мок.
 *
 * Результати навмисно `unknown`: `music.composeDetailed` у SDK типізований як стрім,
 * а обгортка під час виконання повертає `{json, audio: Buffer, filename}`.
 * Байти дістає `audioBytes`.
 */
export interface ElevenLabsRequestOptions {
  timeoutInSeconds?: number;
  maxRetries?: number;
  abortSignal?: AbortSignal;
}

export type ComposeDetailedRequest = ElevenLabs.BodyComposeMusicWithADetailedResponseV1MusicDetailedPost;
export type ComposeRequest = ElevenLabs.BodyComposeMusicV1MusicPost;
export type SoundEffectRequest = ElevenLabs.CreateSoundEffectRequest;
export type CompositionPlanV2 = ElevenLabs.CompositionPlan;
export type GenerationChunk = ElevenLabs.GenerationChunkInput;

export interface ElevenLabsLike {
  music: {
    composeDetailed(request: ComposeDetailedRequest, options?: ElevenLabsRequestOptions): Promise<unknown>;
    compose(request: ComposeRequest, options?: ElevenLabsRequestOptions): Promise<unknown>;
  };
  textToSoundEffects: {
    convert(request: SoundEffectRequest, options?: ElevenLabsRequestOptions): Promise<unknown>;
  };
}

/** Клієнт без вбудованих повторів: повтори й чергу робить `ElevenLabsGate`. */
export function createElevenLabsClient(
  apiKey: string | undefined = process.env.ELEVENLABS_API_KEY,
): ElevenLabsLike {
  if (!apiKey) throw new Error("немає ELEVENLABS_API_KEY");
  const client = new ElevenLabsClient({ apiKey, maxRetries: 0 });
  return client as unknown as ElevenLabsLike;
}

const isReadableStream = (v: unknown): v is ReadableStream<Uint8Array> =>
  typeof v === "object" && v !== null && typeof (v as ReadableStream).getReader === "function";

/**
 * Байти аудіо з відповіді SDK: `ReadableStream<Uint8Array>` (compose, SFX),
 * `{audio: Buffer}` (composeDetailed) або вже Buffer/Uint8Array.
 */
export async function audioBytes(result: unknown): Promise<Buffer> {
  if (Buffer.isBuffer(result)) return result;
  if (result instanceof Uint8Array) return Buffer.from(result);
  if (result instanceof ArrayBuffer) return Buffer.from(result);
  if (isReadableStream(result)) return Buffer.from(await new Response(result).arrayBuffer());
  if (typeof result === "object" && result !== null) {
    const o = result as { audio?: unknown; data?: unknown };
    if (o.audio !== undefined) return audioBytes(o.audio);
    if (o.data !== undefined) return audioBytes(o.data);
  }
  throw new Error("ElevenLabs: неочікувана форма відповіді (немає аудіо)");
}

/** Частота з назви формату (`pcm_44100` → 44100); не вдалося — null. */
const formatSampleRate = (format: string): number | null => {
  const hz = Number(/_(\d{4,6})(?:_|$)/.exec(format)?.[1]);
  return Number.isFinite(hz) && hz > 0 ? hz : null;
};

/**
 * Байти відповіді у вигляді для сховища: PCM (`pcm_*`) одразу загортається у WAV
 * (`expectedSeconds` — запитана тривалість, за нею визначаються канали), mp3 — як є.
 */
export async function receiveAudio(
  result: unknown,
  format: string,
  expectedSeconds?: number,
): Promise<Buffer> {
  const bytes = await audioBytes(result);
  if (!isPcmFormat(format)) return bytes;
  const sampleRate = formatSampleRate(format);
  return wrapPcm(bytes, {
    ...(sampleRate ? { sampleRate } : {}),
    ...(expectedSeconds ? { expectedSeconds } : {}),
  });
}
