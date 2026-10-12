import { createStereo, type StereoPcm } from "./pcm.ts";

/**
 * WAV без бібліотек: запис — PCM 16 біт стерео (формат `soundtrack.wav`), читання — PCM 16 біт
 * або float 32 біт, моно чи стерео (так віддає ffmpeg у pipe, де розмір `data` невідомий).
 */

const HEADER_BYTES = 44;

/** Float −1..1 → int16 (детерміновано: обрізання й округлення, без дизеру). */
function toInt16(x: number): number {
  const v = Math.max(-1, Math.min(1, x));
  return Math.round(v * 32767);
}

/** Стерео PCM → WAV (RIFF, PCM 16 біт, 2 канали, частота з `pcm.sampleRate`). */
export function encodeWav(pcm: StereoPcm): Buffer {
  const frames = pcm.left.length;
  const channels = 2;
  const bytesPerSample = 2;
  const dataBytes = frames * channels * bytesPerSample;
  const buf = Buffer.alloc(HEADER_BYTES + dataBytes);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(pcm.sampleRate, 24);
  buf.writeUInt32LE(pcm.sampleRate * channels * bytesPerSample, 28);
  buf.writeUInt16LE(channels * bytesPerSample, 32);
  buf.writeUInt16LE(bytesPerSample * 8, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataBytes, 40);
  let off = HEADER_BYTES;
  for (let i = 0; i < frames; i++) {
    buf.writeInt16LE(toInt16(pcm.left[i] ?? 0), off);
    buf.writeInt16LE(toInt16(pcm.right[i] ?? 0), off + 2);
    off += 4;
  }
  return buf;
}

export class WavError extends Error {
  override name = "WavError";
}

/** WAV → стерео PCM (моно дублюється в обидва канали). */
export function decodeWav(buf: Buffer): StereoPcm {
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new WavError("не WAV (немає RIFF/WAVE)");
  }
  let off = 12;
  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  let data: Buffer | null = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const declared = buf.readUInt32LE(off + 4);
    const body = off + 8;
    // У pipe розмір невідомий (0 або 0xFFFFFFFF) — беремо все до кінця.
    const size = declared === 0 || body + declared > buf.length ? buf.length - body : declared;
    if (id === "fmt ") {
      format = buf.readUInt16LE(body);
      channels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      bits = buf.readUInt16LE(body + 14);
      // WAVE_FORMAT_EXTENSIBLE: справжній формат — перші 2 байти SubFormat.
      if (format === 0xfffe && size >= 26) format = buf.readUInt16LE(body + 24);
    } else if (id === "data") {
      data = buf.subarray(body, body + size);
      break;
    }
    off = body + size + (size % 2);
  }
  if (!data || channels < 1 || sampleRate <= 0) throw new WavError("WAV без fmt/data");
  const isInt16 = format === 1 && bits === 16;
  const isFloat32 = format === 3 && bits === 32;
  if (!isInt16 && !isFloat32) throw new WavError(`непідтримуваний WAV: формат ${format}, ${bits} біт`);
  const bytes = bits / 8;
  const frameBytes = bytes * channels;
  const samples = data;
  const frames = Math.floor(samples.length / frameBytes);
  const out = createStereo(frames, sampleRate);
  const read = (pos: number) => (isInt16 ? samples.readInt16LE(pos) / 32768 : samples.readFloatLE(pos));
  for (let i = 0; i < frames; i++) {
    const base = i * frameBytes;
    const l = read(base);
    out.left[i] = l;
    out.right[i] = channels > 1 ? read(base + bytes) : l;
  }
  return out;
}
