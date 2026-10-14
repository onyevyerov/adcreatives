import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants } from "node:zlib";

/**
 * Генератор крихітних справжніх шрифтів для фікстур (без чужих ліцензій): один гліф-прямокутник,
 * на який `cmap` веде всі символи заданих діапазонів. Пише TrueType і загортає у WOFF2 з
 * нульовим перетворенням `glyf`/`loca` (стиснення — brotli з Node).
 *
 * Перегенерувати фікстури: `npx tsx packages/crawler/test/helpers/make-fonts.ts`
 * (потім скопіювати `*.woff2` у `packages/brandkit/test/fixtures/fonts/`).
 */

export interface TinyFontSpec {
  family: string;
  weight: number;
  /** Діапазони кодових точок [від, до] включно. */
  ranges: Array<[number, number]>;
}

const LATIN: [number, number] = [0x20, 0x7e];
const CYRILLIC: [number, number] = [0x400, 0x4ff];

export const FIXTURE_FONTS: Record<string, TinyFontSpec> = {
  "zerno-display-700.woff2": { family: "Zerno Display", weight: 700, ranges: [LATIN, CYRILLIC] },
  "plain-latin-400.woff2": { family: "Plain Latin", weight: 400, ranges: [LATIN] },
};

const u16 = (n: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n & 0xffff);
  return b;
};
const i16 = (n: number) => {
  const b = Buffer.alloc(2);
  b.writeInt16BE(n);
  return b;
};
const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
};
const tag = (t: string) => Buffer.from(t, "latin1");
const pad4 = (b: Buffer) => (b.length % 4 ? Buffer.concat([b, Buffer.alloc(4 - (b.length % 4))]) : b);

function checksum(b: Buffer): number {
  const p = pad4(b);
  let sum = 0;
  for (let i = 0; i < p.length; i += 4) sum = (sum + p.readUInt32BE(i)) >>> 0;
  return sum;
}

function cmapTable(ranges: Array<[number, number]>): Buffer {
  const segs = [...ranges, [0xffff, 0xffff] as [number, number]];
  const segCount = segs.length;
  const searchRange = 2 * 2 ** Math.floor(Math.log2(segCount));
  const glyphIds: number[] = [];
  const rangeOffsets: number[] = [];
  segs.forEach(([start, end], i) => {
    if (start === 0xffff) {
      rangeOffsets.push(0);
      return;
    }
    // Відстань від idRangeOffset[i] до першого елемента glyphIdArray цього сегмента.
    rangeOffsets.push(2 * (segCount - i) + 2 * glyphIds.length);
    for (let c = start; c <= end; c++) glyphIds.push(1);
  });
  const body = Buffer.concat([
    ...segs.map(([, end]) => u16(end)),
    u16(0),
    ...segs.map(([start]) => u16(start)),
    ...segs.map(([start]) => u16(start === 0xffff ? 1 : 0)),
    ...rangeOffsets.map(u16),
    ...glyphIds.map(u16),
  ]);
  const sub = Buffer.concat([
    u16(4),
    u16(14 + body.length),
    u16(0),
    u16(segCount * 2),
    u16(searchRange),
    u16(Math.log2(searchRange / 2)),
    u16(segCount * 2 - searchRange),
    body,
  ]);
  return Buffer.concat([u16(0), u16(1), u16(3), u16(1), u32(12), sub]);
}

function nameTable(family: string, weight: number): Buffer {
  const sub = weight >= 700 ? "Bold" : "Regular";
  const ps = `${family.replace(/\s+/g, "")}-${sub}`;
  const names: Array<[number, string]> = [
    [1, family],
    [2, sub],
    [3, `${ps};fixture`],
    [4, `${family} ${sub}`],
    [6, ps],
  ];
  const strings = names.map(([, s]) => Buffer.from(s, "utf16le").swap16());
  const header = 6 + 12 * names.length;
  let offset = 0;
  const records = names.map(([id], i) => {
    const len = (strings[i] as Buffer).length;
    const rec = Buffer.concat([u16(3), u16(1), u16(0x409), u16(id), u16(len), u16(offset)]);
    offset += len;
    return rec;
  });
  return Buffer.concat([u16(0), u16(names.length), u16(header), ...records, ...strings]);
}

function os2Table(spec: TinyFontSpec): Buffer {
  const cyr = spec.ranges.some(([s]) => s >= 0x400);
  const last = Math.max(...spec.ranges.map(([, e]) => e));
  return Buffer.concat([
    u16(4),
    i16(600),
    u16(spec.weight),
    u16(5),
    u16(0),
    ...[650, 600, 0, 75, 650, 600, 0, 350].map(i16),
    i16(50),
    i16(300),
    i16(0),
    Buffer.alloc(10),
    u32(cyr ? 0x201 : 0x1),
    u32(0),
    u32(0),
    u32(0),
    tag("NONE"),
    u16(spec.weight >= 700 ? 0x20 : 0x40),
    u16(0x20),
    u16(last),
    i16(800),
    i16(-200),
    i16(0),
    u16(800),
    u16(200),
    u32(cyr ? 0x5 : 0x1),
    u32(0),
    i16(500),
    i16(700),
    u16(0),
    u16(0x20),
    u16(0),
  ]);
}

/** Таблиці TrueType у порядку тегів. */
function tables(spec: TinyFontSpec): Array<[string, Buffer]> {
  // Гліф 1 — прямокутник (50,0)–(550,700) за годинниковою стрілкою; гліф 0 (.notdef) порожній.
  const box = pad4(
    Buffer.concat([
      i16(1),
      i16(50),
      i16(0),
      i16(550),
      i16(700),
      u16(3),
      u16(0),
      Buffer.from([1, 1, 1, 1]),
      ...[50, 0, 500, 0].map(i16),
      ...[0, 700, 0, -700].map(i16),
    ]),
  );
  const head = Buffer.concat([
    u32(0x00010000),
    u32(0x00010000),
    u32(0),
    u32(0x5f0f3cf5),
    u16(0x000b),
    u16(1000),
    Buffer.alloc(16),
    i16(0),
    i16(0),
    i16(550),
    i16(700),
    u16(spec.weight >= 700 ? 1 : 0),
    u16(8),
    i16(2),
    i16(0),
    i16(0),
  ]);
  const hhea = Buffer.concat([
    u32(0x00010000),
    i16(800),
    i16(-200),
    i16(0),
    u16(600),
    i16(0),
    i16(0),
    i16(550),
    i16(1),
    i16(0),
    i16(0),
    Buffer.alloc(8),
    i16(0),
    u16(2),
  ]);
  const maxp = Buffer.concat([
    u32(0x00010000),
    u16(2),
    u16(4),
    u16(1),
    u16(0),
    u16(0),
    u16(2),
    Buffer.alloc(18),
  ]);
  const hmtx = Buffer.concat([u16(500), i16(0), u16(600), i16(50)]);
  const loca = Buffer.concat([u16(0), u16(0), u16(box.length / 2)]);
  const post = Buffer.concat([u32(0x00030000), u32(0), i16(-100), i16(50), Buffer.alloc(20)]);
  const list: Array<[string, Buffer]> = [
    ["OS/2", os2Table(spec)],
    ["cmap", cmapTable(spec.ranges)],
    ["glyf", box],
    ["head", head],
    ["hhea", hhea],
    ["hmtx", hmtx],
    ["loca", loca],
    ["maxp", maxp],
    ["name", nameTable(spec.family, spec.weight)],
    ["post", post],
  ];
  return list;
}

export function buildTtf(spec: TinyFontSpec): Buffer {
  const list = tables(spec);
  const n = list.length;
  const searchRange = 16 * 2 ** Math.floor(Math.log2(n));
  let offset = 12 + 16 * n;
  const records: Buffer[] = [];
  const datas: Buffer[] = [];
  for (const [t, data] of list) {
    records.push(Buffer.concat([tag(t), u32(checksum(data)), u32(offset), u32(data.length)]));
    datas.push(pad4(data));
    offset += pad4(data).length;
  }
  const font = Buffer.concat([
    u32(0x00010000),
    u16(n),
    u16(searchRange),
    u16(Math.log2(searchRange / 16)),
    u16(n * 16 - searchRange),
    ...records,
    ...datas,
  ]);
  // checkSumAdjustment у head.
  const headOffset = (records[list.findIndex(([t]) => t === "head")] as Buffer).readUInt32BE(8);
  font.writeUInt32BE((0xb1b0afba - checksum(font)) >>> 0, headOffset + 8);
  return font;
}

const KNOWN_TAGS = [
  "cmap",
  "head",
  "hhea",
  "hmtx",
  "maxp",
  "name",
  "OS/2",
  "post",
  "cvt ",
  "fpgm",
  "glyf",
  "loca",
];

function base128(n: number): Buffer {
  const out: number[] = [];
  let v = n;
  do {
    out.unshift(v & 0x7f);
    v >>>= 7;
  } while (v > 0);
  return Buffer.from(out.map((b, i) => (i < out.length - 1 ? b | 0x80 : b)));
}

/** WOFF2 з нульовим перетворенням усіх таблиць (`glyf`/`loca` — версія 3), `loca` одразу після `glyf`. */
export function buildWoff2(spec: TinyFontSpec): Buffer {
  const all = tables(spec);
  const glyf = all.find(([t]) => t === "glyf") as [string, Buffer];
  const loca = all.find(([t]) => t === "loca") as [string, Buffer];
  const list = [...all.filter(([t]) => t !== "glyf" && t !== "loca"), glyf, loca];
  const sfnt = buildTtf(spec);
  const dir = Buffer.concat(
    list.map(([t, data]) => {
      const transform = t === "glyf" || t === "loca" ? 3 << 6 : 0;
      return Buffer.concat([Buffer.from([transform | KNOWN_TAGS.indexOf(t)]), base128(data.length)]);
    }),
  );
  const compressed = brotliCompressSync(Buffer.concat(list.map(([, d]) => d)), {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
  });
  const bodyLength = 48 + dir.length + compressed.length;
  const total = bodyLength + ((4 - (bodyLength % 4)) % 4);
  const header = Buffer.concat([
    tag("wOF2"),
    u32(0x00010000),
    u32(total),
    u16(list.length),
    u16(0),
    u32(sfnt.length),
    u32(compressed.length),
    u16(1),
    u16(0),
    Buffer.alloc(20),
  ]);
  return Buffer.concat([header, dir, compressed, Buffer.alloc(total - bodyLength)]);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const out = fileURLToPath(new URL("../fixtures/fontsite/fonts", import.meta.url));
  mkdirSync(out, { recursive: true });
  for (const [file, spec] of Object.entries(FIXTURE_FONTS)) {
    const buf = buildWoff2(spec);
    writeFileSync(path.join(out, file), buf);
    console.log(file, buf.length);
  }
}
