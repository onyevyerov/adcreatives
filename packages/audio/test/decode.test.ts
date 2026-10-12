import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { decodeWithFfmpeg, findFfmpeg, remotionCompositorPackage } from "../src/decode.ts";
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
