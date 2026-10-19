import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { fixtureBrandKit } from "@adc/shared/fixtures";
import type { Format } from "@adc/shared/schemas/common";
import type { Scene, Storyboard } from "@adc/shared/schemas/storyboard";
import type { AssetRef, AudioManifest, MainProps } from "@adc/shared/types/video";

/**
 * Хелпери для тестів і smoke (рендер, режисер): генерують теку задачі `rev/<n>/video`
 * з власними медіа (PNG-градієнт, WAV-тон) — без мережі й бінарних фікстур у git.
 */

// ---------- PNG ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) c = (CRC_TABLE[(c ^ b) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** RGB-PNG з діагональним градієнтом двох кольорів і світлим колом у фокусі. */
export function makeGradientPng(width: number, height: number, from: string, to: string): Buffer {
  const parse = (hex: string) =>
    [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
  const a = parse(from);
  const b = parse(to);
  const raw = Buffer.alloc((width * 3 + 1) * height);
  const cx = width * 0.5;
  const cy = height * 0.4;
  const r = Math.min(width, height) * 0.22;
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const t = (x / width + y / height) / 2;
      const inCircle = (x - cx) ** 2 + (y - cy) ** 2 < r * r;
      for (let ch = 0; ch < 3; ch++) {
        const v = (a[ch] as number) + ((b[ch] as number) - (a[ch] as number)) * t;
        raw[row + 1 + x * 3 + ch] = inCircle ? Math.min(255, v + 90) : v;
      }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------- WAV ----------

/** 16-bit PCM mono: тон із м'якою атакою (для перевірки музичної доріжки). */
export function makeToneWav(seconds: number, frequency = 220, sampleRate = 44_100): Buffer {
  const samples = Math.round(seconds * sampleRate);
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const t = i / sampleRate;
    const env = Math.min(1, t * 8) * 0.3;
    data.writeInt16LE(Math.round(Math.sin(2 * Math.PI * frequency * t) * env * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

// ---------- тека задачі ----------

export interface FixtureJobOptions {
  /** Тека `rev/<n>/video` (створюється). */
  jobDir: string;
  /** Код сцен: sceneId → TSX. Без сцен — порожній реєстр (усе малює TemplateScene). */
  scenes?: Record<string, string>;
  /** Покласти в public/ фото hero.png (a01) і лого (a02). Дефолт true. */
  images?: boolean;
  /** Покласти в public/ music.wav і sfx/pop.wav. Дефолт true. */
  audio?: boolean;
}

export interface FixtureJob {
  jobDir: string;
  assets: Record<string, AssetRef>;
  audio: AudioManifest;
}

/** Створює теку задачі з `scenes/index.ts` і `public/`. */
export async function createFixtureJob(opts: FixtureJobOptions): Promise<FixtureJob> {
  const scenesDir = path.join(opts.jobDir, "scenes");
  const publicDir = path.join(opts.jobDir, "public");
  await mkdir(scenesDir, { recursive: true });
  await mkdir(path.join(publicDir, "sfx"), { recursive: true });

  const scenes = opts.scenes ?? {};
  const ids = Object.keys(scenes);
  for (const id of ids) await writeFile(path.join(scenesDir, `${id}.tsx`), scenes[id] as string, "utf8");
  const index = [
    ...ids.map((id) => `import ${id.toUpperCase()} from "./${id}.tsx";`),
    "",
    `export default { ${ids.map((id) => `${id}: ${id.toUpperCase()}`).join(", ")} };`,
    "",
  ].join("\n");
  await writeFile(path.join(scenesDir, "index.ts"), index, "utf8");

  const assets: Record<string, AssetRef> = {};
  if (opts.images !== false) {
    await writeFile(path.join(publicDir, "hero.png"), makeGradientPng(1600, 1200, "#6B3E26", "#E85D2A"));
    assets.a01 = { src: "hero.png", width: 1600, height: 1200, focal: { x: 0.5, y: 0.4 } };
    await writeFile(path.join(publicDir, "logo.png"), makeGradientPng(320, 120, "#6B3E26", "#C89F7A"));
    assets.a02 = { src: "logo.png", width: 320, height: 120, focal: { x: 0.5, y: 0.5 } };
  }

  let audio: AudioManifest = {
    music: null,
    mix: null,
    sfx: [],
    totalFrames: 0,
    providers: { music: "elevenlabs", sfx: "elevenlabs" },
    epidemic: null,
  };
  if (opts.audio !== false) {
    await writeFile(path.join(publicDir, "music.wav"), makeToneWav(4));
    await writeFile(path.join(publicDir, "sfx", "pop.wav"), makeToneWav(0.3, 880));
    audio = {
      music: { src: "music.wav", durationMs: 4000, fadeOutMs: 500, volume: 0.8, planHash: "fixture" },
      mix: null,
      sfx: [{ cue: "pop", src: "sfx/pop.wav", durationMs: 300, volume: 0.6 }],
      totalFrames: 0,
      providers: { music: "elevenlabs", sfx: "elevenlabs" },
      epidemic: null,
    };
  }
  return { jobDir: opts.jobDir, assets, audio };
}

/** Коротка розкадровка (кадри × сцени) для тестів і smoke. */
export function shortStoryboard(scenes: Array<Pick<Scene, "id" | "purpose"> & Partial<Scene>>): Storyboard {
  return {
    concept: "тест",
    hook: "тест",
    fps: 30,
    scenes: scenes.map((s, i) => ({
      durationFrames: 35,
      transitionFrames: i === 0 ? 0 : 10,
      text: { headline: "Кава, яку обсмажуємо самі", sub: "Львів, вул. Руська, 1", emphasis: ["самі"] },
      items: [],
      events: [],
      factIds: [],
      assetIds: ["a01"],
      layoutIntent: "hero_image",
      motionIntent: "",
      transitionIn: i === 0 ? "cut" : "fade",
      sfxCue: i === 0 ? null : "pop",
      musicEnergy: 0.5,
      ...s,
    })),
    musicBrief: { genre: "lo-fi", mood: [], bpm: 85, instrumentation: [], structure: [] },
    copyRules: {
      maxCharsPerLine: { vertical: 18, square: 22, landscape: 32 },
      maxLines: { headline: 3, sub: 2 },
    },
    throughline: null,
  };
}

/** MainProps для фікстурної задачі. */
export function fixtureMainProps(
  job: FixtureJob,
  storyboard: Storyboard,
  format: Format,
  extra: Partial<MainProps> = {},
): MainProps {
  return {
    brand: fixtureBrandKit,
    storyboard,
    format,
    assets: job.assets,
    audio: job.audio,
    templateScenes: storyboard.scenes.map((s) => s.id),
    ...extra,
  };
}
