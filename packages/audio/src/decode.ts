import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { findRepoRoot } from "@adc/shared";
import { SAMPLE_RATE, type StereoPcm } from "./pcm.ts";
import { decodeWav } from "./wav.ts";

/**
 * Декодування музики (mp3) у PCM через ffmpeg зі збірки Remotion (`@remotion/compositor-*`,
 * та сама, що рендерить відео). Фільтри в цій збірці урізані, тому ffmpeg лише декодує
 * в WAV 16 біт 44.1 кГц стерео; уся обробка — у Node (`mixer.ts`).
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

/** Декодер за замовчуванням для стадії `audio`. */
export const decodeAudio: DecodeAudio = (bytes, opts) =>
  decodeWithFfmpeg(bytes, opts?.signal ? { signal: opts.signal } : {});
