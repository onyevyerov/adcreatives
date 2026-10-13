import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { receiveAudio } from "../src/client.ts";
import {
  audioExt,
  DecodeError,
  decodeAudio,
  decodeWithFfmpeg,
  findFfmpeg,
  isWavBytes,
  remotionCompositorPackage,
  wrapPcm,
} from "../src/decode.ts";
import { createStereo, rmsOf, SAMPLE_RATE } from "../src/pcm.ts";
import { decodeWav, encodeWav, WavError } from "../src/wav.ts";
import { metronome } from "./signals.ts";

describe("WAV", () => {
  it("запис 44.1 кГц / 16 біт / стерео і читання назад", () => {
    const pcm = createStereo(1000);
    for (let i = 0; i < 1000; i++) {
      pcm.left[i] = Math.sin(i / 10) * 0.5;
      pcm.right[i] = i % 2 === 0 ? 1.5 : -1.5; // обрізається до ±1
    }
    const wav = encodeWav(pcm);
    expect(wav.length).toBe(44 + 1000 * 4);
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.readUInt32LE(4)).toBe(36 + 4000);
    expect(wav.readUInt16LE(20)).toBe(1);
    expect(wav.readUInt16LE(22)).toBe(2);
    expect(wav.readUInt32LE(24)).toBe(44_100);
    expect(wav.readUInt32LE(28)).toBe(44_100 * 4);
    expect(wav.readUInt16LE(34)).toBe(16);
    const back = decodeWav(wav);
    expect(back.sampleRate).toBe(44_100);
    expect(back.left.length).toBe(1000);
    for (let i = 0; i < 1000; i++) expect(back.left[i]).toBeCloseTo(Math.sin(i / 10) * 0.5, 4);
    expect(back.right[0]).toBeCloseTo(32767 / 32768, 6);
    expect(back.right[1]).toBeCloseTo(-32767 / 32768, 6);
  });

  it("читання WAV з pipe: розмір data невідомий (0xFFFFFFFF) — беремо все до кінця", () => {
    const wav = encodeWav(createStereo(10));
    wav.writeUInt32LE(0xffffffff, 40);
    expect(decodeWav(wav).left.length).toBe(10);
    expect(() => decodeWav(Buffer.from("MUSIC-DETAILED"))).toThrow(WavError);
  });
});

describe("ffmpeg зі збірки Remotion", () => {
  it("пакет компоненту для платформи", () => {
    expect(remotionCompositorPackage("darwin", "arm64")).toBe("@remotion/compositor-darwin-arm64");
    expect(remotionCompositorPackage("win32", "x64")).toBe("@remotion/compositor-win32-x64-msvc");
    expect(remotionCompositorPackage("linux", "x64")).toMatch(/^@remotion\/compositor-linux-x64-(gnu|musl)$/);
    expect(remotionCompositorPackage("freebsd", "x64")).toBeNull();
    expect(findFfmpeg({ ADC_FFMPEG: "/opt/ffmpeg" })).toBe("/opt/ffmpeg");
  });

  const ffmpeg = findFfmpeg({});
  it.skipIf(!ffmpeg)("декодує mp3 у PCM 44.1 кГц стерео (без фільтрів)", async () => {
    const bin = ffmpeg as string;
    const source = metronome({ bpm: 120, offsetSec: 0.07, durationSec: 2, pad: true });
    // mp3 робимо тим самим ffmpeg (енкодер libmp3lame у збірці є).
    const env =
      process.platform === "darwin" ? { ...process.env, DYLD_LIBRARY_PATH: path.dirname(bin) } : process.env;
    const mp3 = spawnSync(
      bin,
      ["-hide_banner", "-loglevel", "error", "-f", "wav", "-i", "pipe:0", "-f", "mp3", "pipe:1"],
      { input: encodeWav(source), env, cwd: path.dirname(bin), maxBuffer: 64 * 1024 * 1024 },
    );
    expect(mp3.status, mp3.stderr?.toString()).toBe(0);
    const pcm = await decodeWithFfmpeg(mp3.stdout, { ffmpeg: bin });
    expect(pcm.sampleRate).toBe(SAMPLE_RATE);
    // mp3 додає затримку енкодера/декодера — довжина з точністю до кадру mp3.
    expect(Math.abs(pcm.left.length - source.left.length)).toBeLessThan(2 * 1152 + 600);
    expect(rmsOf(pcm)).toBeCloseTo(rmsOf(source), 1);
    await expect(decodeWithFfmpeg(Buffer.from("not audio"), { ffmpeg: bin })).rejects.toThrow(/ffmpeg/);
  });
});

/** Сирий PCM 16 біт LE (як `pcm_44100` ElevenLabs): синус, у стерео — правий канал у протифазі. */
function rawPcm(frames: number, channels: 1 | 2): Buffer {
  const buf = Buffer.alloc(frames * channels * 2);
  for (let i = 0; i < frames; i++) {
    const v = Math.round(Math.sin(i / 15) * 12_000);
    buf.writeInt16LE(v, i * channels * 2);
    if (channels === 2) buf.writeInt16LE(-v, i * channels * 2 + 2);
  }
  return buf;
}

describe("PCM/WAV без ffmpeg (A1)", () => {
  it("wrapPcm: канали за очікуваною тривалістю, без тривалості — моно; WAV лишається як є", () => {
    const stereo = decodeWav(wrapPcm(rawPcm(4410, 2), { expectedSeconds: 0.1 }));
    expect(stereo.sampleRate).toBe(44_100);
    expect(stereo.left.length).toBe(4410);
    expect(stereo.left[10]).toBeCloseTo(Math.round(Math.sin(10 / 15) * 12_000) / 32768, 3);
    expect(stereo.right[10]).toBeCloseTo(-(stereo.left[10] as number), 3);

    const mono = decodeWav(wrapPcm(rawPcm(4410, 1)));
    expect(mono.left.length).toBe(4410);
    expect(mono.right[10]).toBe(mono.left[10]);
    // Та сама тривалість, моно-байти: канал один.
    expect(decodeWav(wrapPcm(rawPcm(4410, 1), { expectedSeconds: 0.1 })).left.length).toBe(4410);

    const wav = encodeWav(createStereo(10));
    expect(wrapPcm(wav)).toBe(wav);
    expect([isWavBytes(wav), audioExt(wav), audioExt(Buffer.from("ID3 mp3"))]).toEqual([true, "wav", "mp3"]);
  });

  it("receiveAudio: pcm_44100 → WAV одразу після отримання, mp3 — байти як є", async () => {
    const pcm = await receiveAudio(rawPcm(441, 2), "pcm_44100", 0.01);
    expect(pcm.toString("ascii", 0, 4)).toBe("RIFF");
    expect(decodeWav(pcm).left.length).toBe(441);
    const mp3 = Buffer.from("MP3-BYTES");
    expect(await receiveAudio(mp3, "mp3_44100_192")).toEqual(mp3);
  });

  it("decodeAudio: WAV 44.1 кГц — через decodeWav без ffmpeg; інша частота й mp3 — через ffmpeg", async () => {
    vi.stubEnv("ADC_FFMPEG", "/nonexistent/ffmpeg");
    try {
      const source = createStereo(1000);
      source.left[5] = 0.5;
      const pcm = await decodeAudio(encodeWav(source));
      expect(pcm.left.length).toBe(1000);
      expect(pcm.left[5]).toBeCloseTo(0.5, 4);
      // 48 кГц потребує ресемплінгу — це робота ffmpeg (тут недосяжного).
      await expect(decodeAudio(encodeWav(createStereo(1000, 48_000)))).rejects.toThrow(DecodeError);
      await expect(decodeAudio(Buffer.from("not wav"))).rejects.toThrow(DecodeError);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
