import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { findRepoRoot } from "@adc/shared";
import { createStereo, SAMPLE_RATE, type StereoPcm } from "./pcm.ts";
import { decodeWav, encodeWav, WavError } from "./wav.ts";

/**
 * Декодування аудіо у PCM: WAV 44.1 кГц (у т. ч. PCM ElevenLabs, загорнутий у WAV) — у Node без
 * ffmpeg; mp3 та інше — через ffmpeg зі збірки Remotion (`@remotion/compositor-*`, та сама, що
 * рендерить відео). Фільтри в цій збірці урізані, тому ffmpeg лише декодує в WAV 16 біт 44.1 кГц
 * стерео; уся обробка — у Node (`mixer.ts`).
 */

/** Явний шлях до ffmpeg (перекриває пошук у збірці Remotion). */
export const FFMPEG_ENV = "ADC_FFMPEG";

export type DecodeAudio = (bytes: Buffer, opts?: { signal?: AbortSignal }) => Promise<StereoPcm>;

function isMusl(): boolean {
  const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined;
  return !report?.header?.glibcVersionRuntime;
}

/** Пакет Remotion з бінарниками ffmpeg для цієї платформи (як у `@remotion/renderer`). */
export function remotionCompositorPackage(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | null {
  if (platform === "darwin" && (arch === "arm64" || arch === "x64"))
    return `@remotion/compositor-darwin-${arch}`;
  if (platform === "win32" && arch === "x64") return "@remotion/compositor-win32-x64-msvc";
  if (platform === "linux" && (arch === "arm64" || arch === "x64")) {
    return `@remotion/compositor-linux-${arch}-${isMusl() ? "musl" : "gnu"}`;
  }
  return null;
}

function tryResolve(from: string, request: string): string | null {
  try {
    return createRequire(from).resolve(request);
  } catch {
    return null;
  }
}

/**
 * Шлях до ffmpeg: `ADC_FFMPEG`, інакше бінарник з `@remotion/compositor-*`. Пакет — залежність
 * `@remotion/renderer`, тож шукаємо його біля renderer, який стоїть у `@adc/render` (або біля cwd).
 */
export function findFfmpeg(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env[FFMPEG_ENV]?.trim();
  if (explicit) return explicit;
  const pkg = remotionCompositorPackage();
  if (!pkg) return null;
  const bases = [import.meta.url, path.join(process.cwd(), "package.json")];
  try {
    bases.push(path.join(findRepoRoot(), "packages", "render", "package.json"));
  } catch {
    // поза репозиторієм — лише import.meta.url і cwd
  }
  for (const base of bases) {
    const renderer = tryResolve(base, "@remotion/renderer/package.json");
    const compositor =
      tryResolve(base, `${pkg}/package.json`) ??
      (renderer ? tryResolve(renderer, `${pkg}/package.json`) : null);
    if (!compositor) continue;
    const bin = path.join(path.dirname(compositor), process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
    if (existsSync(bin)) return bin;
  }
  return null;
}

export class DecodeError extends Error {
  override name = "DecodeError";
}

/** Будь-який аудіофайл, який розуміє ffmpeg → стерео PCM 44.1 кГц. */
export async function decodeWithFfmpeg(
  bytes: Buffer,
  opts: { ffmpeg?: string; signal?: AbortSignal } = {},
): Promise<StereoPcm> {
  const bin = opts.ffmpeg ?? findFfmpeg();
  if (!bin) throw new DecodeError(`ffmpeg не знайдено (збірка Remotion або ${FFMPEG_ENV})`);
  const cwd = path.dirname(bin);
  // Як у @remotion/renderer: бібліотеки ffmpeg лежать поруч із бінарником.
  const env = process.platform === "darwin" ? { ...process.env, DYLD_LIBRARY_PATH: cwd } : process.env;
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    "pipe:0",
    "-vn",
    "-ac",
    "2",
    "-ar",
    String(SAMPLE_RATE),
    "-acodec",
    "pcm_s16le",
    "-f",
    "wav",
    "pipe:1",
  ];
  const out = await new Promise<Buffer>((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    const chunks: Buffer[] = [];
    const errs: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    child.stderr.on("data", (c: Buffer) => errs.push(c));
    // ffmpeg може закрити stdin раніше (битий файл) — EPIPE не має валити процес.
    child.stdin.on("error", () => {});
    child.on("error", (err) =>
      reject(new DecodeError(`ffmpeg не запустився: ${err.message}`, { cause: err })),
    );
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else
        reject(
          new DecodeError(
            `ffmpeg завершився з кодом ${code}: ${Buffer.concat(errs).toString().trim().slice(0, 500)}`,
          ),
        );
    });
    child.stdin.end(bytes);
  });
  return decodeWav(out);
}

/** WAV (RIFF/WAVE) за заголовком. */
export const isWavBytes = (bytes: Buffer) =>
  bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WAVE";

/** Розширення файлу за вмістом: WAV — `wav`, решта (відповіді ElevenLabs у mp3) — `mp3`. */
export const audioExt = (bytes: Buffer): "wav" | "mp3" => (isWavBytes(bytes) ? "wav" : "mp3");

/**
 * Сирий PCM ElevenLabs (`pcm_44100`: 16 біт LE, без заголовка) → WAV через `encodeWav`.
 * Кількість каналів у відповіді не підписана: за очікуваною тривалістю (`expectedSeconds`) —
 * байтів удвічі більше, ніж на моно, — стерео; без тривалості — моно (як TTS ElevenLabs).
 * Уже WAV — повертається як є.
 */
export function wrapPcm(bytes: Buffer, opts: { sampleRate?: number; expectedSeconds?: number } = {}): Buffer {
  if (isWavBytes(bytes)) return bytes;
  const sampleRate = opts.sampleRate ?? SAMPLE_RATE;
  const expected = opts.expectedSeconds ?? 0;
  const ratio = expected > 0 ? bytes.length / (2 * sampleRate * expected) : 1;
  const channels = ratio >= 1.5 ? 2 : 1;
  const frames = Math.floor(bytes.length / (2 * channels));
  const pcm = createStereo(frames, sampleRate);
  for (let i = 0; i < frames; i++) {
    const base = i * 2 * channels;
    const l = bytes.readInt16LE(base) / 32768;
    pcm.left[i] = l;
    pcm.right[i] = channels === 2 ? bytes.readInt16LE(base + 2) / 32768 : l;
  }
  return encodeWav(pcm);
}

/**
 * Декодер за замовчуванням для стадії `audio`: WAV 44.1 кГц — `decodeWav` без ffmpeg;
 * інша частота або кодування WAV, mp3 — ffmpeg.
 */
export const decodeAudio: DecodeAudio = async (bytes, opts) => {
  if (isWavBytes(bytes)) {
    try {
      const pcm = decodeWav(bytes);
      if (pcm.sampleRate === SAMPLE_RATE) return pcm;
    } catch (err) {
      if (!(err instanceof WavError)) throw err;
    }
  }
  return decodeWithFfmpeg(bytes, opts?.signal ? { signal: opts.signal } : {});
};
