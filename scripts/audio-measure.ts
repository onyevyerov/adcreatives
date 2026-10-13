/**
 * Замір звуку — інструмент приймання ТЗ якості звуку (`docs/superpowers/specs/2026-10-13-audio-quality-tz.md`):
 *   pnpm audio-measure -- <файл.wav|mp3|mp4> [ще файли]
 *   pnpm audio-measure -- --project <id> [--rev n]     сирий трек, music.wav, soundtrack.wav, рендери ревізії
 *   pnpm audio-measure -- --sfx-cache                  таблиця по всіх семплах кешу SFX
 * `--data-dir <шлях>` — інше сховище (наприклад, `.data` основного checkout; лише читання), інакше DATA_DIR.
 * Друкує LUFS (BS.1770-4), dBTP, RMS, crest, кореляцію L/R (усю і нижче 150 Гц), енергію смуг
 * відносно загальної і RMS по секундах. Декодує через `decodeAudio` (ffmpeg зі збірки Remotion).
 * Відносний імпорт: кореневий package.json не залежить від workspace-пакетів.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  analyzeSample,
  correlation,
  decodeAudio,
  gainToDb,
  LOW_CORRELATION_HZ,
  measureLoudness,
  pcmLength,
  peakOf,
  rmsOf,
  rmsPerSecondDb,
  type StereoPcm,
  truePeakDb,
} from "../packages/audio/src/index.ts";
import {
  AudioManifest,
  dataDir,
  loadRootEnv,
  ProjectState,
  projectPaths,
  SoundCue,
  sharedPaths,
} from "../packages/shared/src/index.ts";

const USAGE = `Використання:
  pnpm audio-measure -- <файл.wav|mp3|mp4> [ще файли]
  pnpm audio-measure -- --project <id> [--rev n]
  pnpm audio-measure -- --sfx-cache
Опції: --data-dir <шлях> — сховище замість DATA_DIR (лише читання).`;

/** Смуги енергії спектра, Гц. */
const BANDS: ReadonlyArray<readonly [number, number]> = [
  [20, 60],
  [60, 150],
  [150, 500],
  [500, 2_000],
  [2_000, 6_000],
  [6_000, 12_000],
  [12_000, 16_000],
  [16_000, 20_000],
];
const FFT_SIZE = 8192;

const fmt = (x: number | null | undefined, digits = 1) =>
  x === null || x === undefined || !Number.isFinite(x) ? "—" : x.toFixed(digits);
const hz = (x: number) => (x >= 1000 ? `${x / 1000}k` : String(x));

/** FFT на місці (radix-2), довжина — степінь двійки. */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j] as number, re[i] as number];
      [im[i], im[j]] = [im[j] as number, im[i] as number];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const xr = (re[b] as number) * cr - (im[b] as number) * ci;
        const xi = (re[b] as number) * ci + (im[b] as number) * cr;
        re[b] = (re[a] as number) - xr;
        im[b] = (im[a] as number) - xi;
        re[a] = (re[a] as number) + xr;
        im[a] = (im[a] as number) + xi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}

/** Енергія смуг відносно всієї енергії спектра (обидва канали, вікно Ганна, крок пів вікна), дБ. */
function bandEnergyDb(pcm: StereoPcm): number[] {
  const sr = pcm.sampleRate;
  const n = pcmLength(pcm);
  const power = new Float64Array(FFT_SIZE / 2 + 1);
  const hann = Float64Array.from(
    { length: FFT_SIZE },
    (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFT_SIZE),
  );
  for (const ch of [pcm.left, pcm.right]) {
    for (let start = 0; start + FFT_SIZE <= n; start += FFT_SIZE / 2) {
      const re = new Float64Array(FFT_SIZE);
      const im = new Float64Array(FFT_SIZE);
      for (let i = 0; i < FFT_SIZE; i++) re[i] = (ch[start + i] as number) * (hann[i] as number);
      fft(re, im);
      for (let k = 0; k <= FFT_SIZE / 2; k++)
        power[k] = (power[k] as number) + (re[k] as number) ** 2 + (im[k] as number) ** 2;
    }
  }
  let total = 0;
  for (const p of power) total += p;
  return BANDS.map(([lo, hi]) => {
    let sum = 0;
    for (let k = 0; k <= FFT_SIZE / 2; k++) {
      const f = (k * sr) / FFT_SIZE;
      if (f >= lo && f < hi) sum += power[k] as number;
    }
    return total > 0 && sum > 0 ? 10 * Math.log10(sum / total) : Number.NEGATIVE_INFINITY;
  });
}

interface Measured {
  label: string;
  file: string;
  durationSec: number;
  sampleRate: number;
  integratedLufs: number;
  shortTermMaxLufs: number;
  momentaryMaxLufs: number;
  truePeakDbtp: number;
  peakDbfs: number;
  rmsDbfs: number;
  crestDb: number;
  correlation: number;
  lowCorrelation: number;
  bandsDb: number[];
  rmsPerSecondDb: number[];
}

async function measureFile(file: string, label: string): Promise<Measured> {
  const pcm = await decodeAudio(readFileSync(file));
  const loud = measureLoudness(pcm);
  const peakDbfs = gainToDb(peakOf(pcm));
  const rmsDbfs = gainToDb(rmsOf(pcm));
  return {
    label,
    file,
    durationSec: pcmLength(pcm) / pcm.sampleRate,
    sampleRate: pcm.sampleRate,
    ...loud,
    truePeakDbtp: truePeakDb(pcm),
    peakDbfs,
    rmsDbfs,
    crestDb: peakDbfs - rmsDbfs,
    correlation: correlation(pcm),
    lowCorrelation: correlation(pcm, LOW_CORRELATION_HZ),
    bandsDb: bandEnergyDb(pcm),
    rmsPerSecondDb: rmsPerSecondDb(pcm),
  };
}

function printMeasured(m: Measured): void {
  console.log(`\n== ${m.label} — ${m.file}`);
  console.log(`  тривалість ${fmt(m.durationSec, 2)} с (декодовано в ${m.sampleRate} Гц)`);
  console.log(
    `  LUFS інтегр. ${fmt(m.integratedLufs)} | short-term max ${fmt(m.shortTermMaxLufs)} | momentary max ${fmt(m.momentaryMaxLufs)}`,
  );
  console.log(
    `  true peak ${fmt(m.truePeakDbtp)} dBTP | пік ${fmt(m.peakDbfs)} dBFS | RMS ${fmt(m.rmsDbfs)} dBFS | crest ${fmt(m.crestDb)} дБ`,
  );
  console.log(
    `  кореляція L/R ${fmt(m.correlation, 2)} | нижче ${LOW_CORRELATION_HZ} Гц ${fmt(m.lowCorrelation, 2)}`,
  );
  console.log(
    `  смуги, дБ від загальної енергії: ${BANDS.map(([lo, hi], i) => `${hz(lo)}–${hz(hi)} ${fmt(m.bandsDb[i])}`).join(" | ")}`,
  );
  console.log(`  RMS по секундах, dBFS: ${m.rmsPerSecondDb.map((x) => fmt(x)).join(" ")}`);
}

function printSummary(rows: readonly Measured[]): void {
  if (rows.length < 2) return;
  const head = [
    "файл",
    "LUFS",
    "dBTP",
    "RMS",
    "crest",
    "corr",
    `corr<${LOW_CORRELATION_HZ}`,
    "12–16k",
    "16–20k",
  ];
  const body = rows.map((m) => [
    m.label,
    fmt(m.integratedLufs),
    fmt(m.truePeakDbtp),
    fmt(m.rmsDbfs),
    fmt(m.crestDb),
    fmt(m.correlation, 2),
    fmt(m.lowCorrelation, 2),
    fmt(m.bandsDb[6]),
    fmt(m.bandsDb[7]),
  ]);
  printTable(head, body);
}

function printTable(head: readonly string[], body: ReadonlyArray<readonly string[]>): void {
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((r) => (r[i] ?? "").length)));
  const line = (cells: readonly string[]) =>
    `| ${cells.map((c, i) => (i === 0 ? c.padEnd(widths[i] ?? 0) : c.padStart(widths[i] ?? 0))).join(" | ")} |`;
  console.log(`\n${line(head)}`);
  console.log(`|${widths.map((w) => "-".repeat(w + 2)).join("|")}|`);
  for (const r of body) console.log(line(r));
}

const readJson = (file: string): unknown => JSON.parse(readFileSync(file, "utf8"));

/** Файли ревізії проєкту: сирий трек, обрізаний `music.wav`, `soundtrack.wav`, рендери. */
function projectFiles(
  root: string,
  projectId: string,
  revArg: number | null,
): Array<{ label: string; file: string }> {
  const paths = projectPaths(projectId);
  const abs = (key: string) => path.join(root, ...key.split("/"));
  if (!existsSync(abs(paths.project))) throw new Error(`немає проєкту ${projectId} у ${root}`);
  const project = ProjectState.parse(readJson(abs(paths.project)));
  const rev = revArg ?? project.rev;
  const revPaths = paths.rev(rev);
  const out: Array<{ label: string; file: string }> = [];
  const add = (label: string, key: string) => {
    if (existsSync(abs(key))) out.push({ label, file: abs(key) });
  };
  if (existsSync(abs(revPaths.audio))) {
    const manifest = AudioManifest.parse(readJson(abs(revPaths.audio)));
    const planHash = manifest.music?.planHash;
    if (planHash) {
      add("music.mp3 (сирий)", paths.music(planHash));
      add("music-raw.wav (сирий, PCM)", `${paths.audioDir}/${planHash}/music-raw.wav`);
      add("music.wav", `${paths.audioDir}/${planHash}/music.wav`);
    }
  }
  add(`soundtrack.wav (rev ${rev})`, revPaths.publicFile("soundtrack.wav"));
  for (const format of ["vertical", "square", "landscape"] as const)
    add(`${format}.mp4`, revPaths.render(format));
  if (out.length === 0) throw new Error(`у ревізії ${rev} проєкту ${projectId} немає аудіофайлів`);
  return out;
}

/** Таблиця по семплах кешу SFX: тривалість, onset, якір, пік, висота, кореляція, QC. */
async function sfxCacheTable(root: string): Promise<void> {
  const dir = path.join(root, ...sharedPaths.sfxCacheDir.split("/"));
  if (!existsSync(dir)) throw new Error(`немає кешу SFX: ${dir}`);
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".mp3") || f.endsWith(".wav"))
    .sort();
  const rows: Array<{ label: string; cells: string[] }> = [];
  for (const f of files) {
    const hash = f.replace(/\.(mp3|wav)$/, "");
    const metaFile = path.join(dir, `${hash}.json`);
    const meta = existsSync(metaFile)
      ? (readJson(metaFile) as { cue?: string; qc?: { ok?: boolean; reasons?: string[] } | null })
      : {};
    const label = meta.cue ?? "?";
    const cue = SoundCue.safeParse(label.split(".")[0]);
    try {
      const pcm = await decodeAudio(readFileSync(path.join(dir, f)));
      const sr = pcm.sampleRate;
      const analysis = cue.success ? analyzeSample(cue.data, pcm) : null;
      const ms = (samples: number | undefined) => (samples === undefined ? null : (samples / sr) * 1000);
      rows.push({
        label,
        cells: [
          label,
          hash,
          fmt(pcmLength(pcm) / sr, 2),
          fmt(ms(analysis?.onset), 0),
          fmt(ms(analysis?.anchor), 0),
          fmt(gainToDb(peakOf(pcm))),
          fmt(analysis?.pitchHz ?? null, 0),
          fmt(correlation(pcm), 2),
          meta.qc ? (meta.qc.ok ? "ok" : `✗ ${(meta.qc.reasons ?? []).join("; ")}`) : "—",
        ],
      });
    } catch (err) {
      rows.push({ label, cells: [label, hash, "помилка декодування", String(err).slice(0, 60)] });
    }
  }
  rows.sort((a, b) => a.label.localeCompare(b.label, "en", { numeric: true }));
  printTable(
    ["cue", "hash", "с", "onset мс", "якір мс", "пік dBFS", "pitch Гц", "corr", "QC"],
    rows.map((r) => r.cells),
  );
  console.log(`\n${rows.length} семплів у ${dir}`);
}

async function main(argv: readonly string[]): Promise<number> {
  loadRootEnv();
  const args = argv.filter((a) => a !== "--");
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(USAGE);
    return args.length === 0 ? 1 : 0;
  }
  const take = (flag: string): string | null => {
    const i = args.indexOf(flag);
    if (i < 0) return null;
    const v = args[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${flag}: потрібне значення`);
    args.splice(i, 2);
    return v;
  };
  const root = path.resolve(take("--data-dir") ?? dataDir());
  const projectId = take("--project");
  const revRaw = take("--rev");
  const rev = revRaw === null ? null : Number(revRaw);
  if (rev !== null && !(Number.isInteger(rev) && rev >= 1))
    throw new Error(`--rev: ціле ≥ 1, а не ${revRaw}`);
  const sfxCache = args.includes("--sfx-cache");
  const unknown = args.filter((a) => a.startsWith("--") && a !== "--sfx-cache");
  if (unknown.length > 0) throw new Error(`невідомі опції: ${unknown.join(" ")}\n${USAGE}`);
  const positional = args.filter((a) => !a.startsWith("--"));

  if (sfxCache) await sfxCacheTable(root);
  const targets = [
    ...(projectId ? projectFiles(root, projectId, rev) : []),
    ...positional.map((f) => ({ label: path.basename(f), file: path.resolve(f) })),
  ];
  const measured: Measured[] = [];
  for (const t of targets) {
    const m = await measureFile(t.file, t.label);
    printMeasured(m);
    measured.push(m);
  }
  printSummary(measured);
  return 0;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
