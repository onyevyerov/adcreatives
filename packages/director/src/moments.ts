import {
  FORMAT_SIZE,
  type Format,
  HIT_SOUND_CUES,
  joinFrames,
  momentFrames,
  type Scene,
  type SoundCue,
} from "@adc/shared";
import sharp, { type OverlayOptions } from "sharp";
import { QA_IMAGE_MAX_SIDE } from "./sheets.ts";

/**
 * Аркуш моментів сцени (`revPaths.momentSheet`, один — у головному форматі): кадри ±`MOMENT_RADIUS`
 * навколо кожної події розкадровки і склейка з наступною сценою (останні 2 кадри цієї, перші 3
 * наступної). Рядок — подія (`id · at · cue`), останній рядок — склейка (`out → in`), клітинка —
 * `кадр · с`. Його бачать звукорежисер (`sfx`) і рецензент (`review`) разом із `momentLegend`.
 *
 * Тут лише план кадрів і композиція JPEG; рендер кадрів — у стадії `check`.
 */

/** Верхня межа кадрів на аркуш однієї сцени (разом із кадрами наступної сцени у склейці). */
export const MOMENT_MAX_FRAMES = 30;

export type MomentRow =
  | { kind: "event"; eventId: string; at: number; cue: SoundCue | null; frames: number[] }
  | { kind: "join"; nextId: string; out: number[]; in: number[] };

export interface MomentPlan {
  sceneId: string;
  /** Рядки аркуша: події в порядку розкадровки, склейка — останнім рядком. */
  rows: MomentRow[];
  /** Події понад ліміт кадрів (на аркуш не потрапили). */
  skipped: string[];
  /** Унікальні локальні кадри сцени, які треба мати (за зростанням). */
  own: number[];
  /** Локальні кадри наступної сцени (склейка). */
  next: number[];
}

/** Пріоритет події під ліміт: удари (`HIT_SOUND_CUES`), далі інші озвучені, далі тихі. */
function eventRank(e: Scene["events"][number]): number {
  if (e.sound && HIT_SOUND_CUES.has(e.sound.cue)) return 0;
  return e.sound ? 1 : 2;
}

/**
 * План аркуша моментів: кадри подій і склейки, не більше `maxFrames` унікальних кадрів (кадри
 * сусідніх подій спільні). Склейка береться завжди; події — за пріоритетом `eventRank`, при рівному —
 * раніші; подія, що не вміщається, пропускається. Остання сцена склейки не має.
 */
export function planMoments(
  scene: Pick<Scene, "id" | "durationFrames" | "events">,
  next: Pick<Scene, "id" | "durationFrames"> | null,
  maxFrames = MOMENT_MAX_FRAMES,
): MomentPlan {
  const join = next ? joinFrames(scene.durationFrames, next.durationFrames) : null;
  const own = new Set<number>(join?.out ?? []);
  const nextFrames = join?.in ?? [];
  const byRank = scene.events
    .map((e, i) => ({ e, i }))
    .sort((a, b) => eventRank(a.e) - eventRank(b.e) || a.e.at - b.e.at || a.i - b.i);
  const kept = new Set<string>();
  const skipped: string[] = [];
  for (const { e } of byRank) {
    const frames = momentFrames(e.at, scene.durationFrames);
    const added = frames.filter((f) => !own.has(f)).length;
    if (own.size + added + nextFrames.length > maxFrames) {
      skipped.push(e.id);
      continue;
    }
    for (const f of frames) own.add(f);
    kept.add(e.id);
  }
  const rows: MomentRow[] = scene.events
    .filter((e) => kept.has(e.id))
    .map((e) => ({
      kind: "event",
      eventId: e.id,
      at: e.at,
      cue: e.sound?.cue ?? null,
      frames: momentFrames(e.at, scene.durationFrames),
    }));
  if (join && next) rows.push({ kind: "join", nextId: next.id, out: join.out, in: join.in });
  return {
    sceneId: scene.id,
    rows,
    skipped: scene.events.filter((e) => skipped.includes(e.id)).map((e) => e.id),
    own: [...own].sort((a, b) => a - b),
    next: nextFrames,
  };
}

/** Клітинка аркуша моментів: кадр і підпис `кадр · с`. */
export interface MomentCell {
  /** PNG кадру; null — кадр не відрендерився (сіра заглушка з `note`). */
  png: Buffer | null;
  label: string;
  note?: string;
}

export interface MomentSheetRow {
  title: string;
  cells: MomentCell[];
  /** Індекс першої клітинки наступної сцени (склейка): перед нею — роздільник. */
  splitAt?: number;
}

/** Підпис клітинки — як у `momentLegend`: `кадр · с` (локальний кадр сцени). */
export function momentCellLabel(frame: number, fps: number): string {
  return `${frame} · ${(frame / fps).toFixed(2)}s`;
}

/**
 * Рядки аркуша з плану і відрендерених кадрів (`own` — кадри сцени, `next` — наступної).
 * Кадр, якого немає в мапі, — заглушка з `note`.
 */
export function momentSheetRows(
  plan: MomentPlan,
  fps: number,
  own: ReadonlyMap<number, Buffer>,
  next: ReadonlyMap<number, Buffer>,
  note = "render error",
): MomentSheetRow[] {
  const cell = (frames: ReadonlyMap<number, Buffer>, f: number, prefix = ""): MomentCell => ({
    png: frames.get(f) ?? null,
    label: `${prefix}${momentCellLabel(f, fps)}`,
    note,
  });
  return plan.rows.map((row) =>
    row.kind === "event"
      ? {
          title: `${row.eventId} · ${row.at} · ${row.cue ?? "no sound"}`,
          cells: row.frames.map((f) => cell(own, f)),
        }
      : {
          title: `join ${plan.sceneId} → ${row.nextId}`,
          cells: [...row.out.map((f) => cell(own, f)), ...row.in.map((f) => cell(next, f, "→ "))],
          splitAt: row.out.length,
        },
  );
}

const GAP = 8;
const TITLE_H = 26;
const LABEL_H = 24;
const SEP = 16;
const BG = { r: 255, g: 255, b: 255 };

/** Розкладка аркуша моментів: рядок на рядок плану, найбільші кадри, що вміщаються в maxSide. */
export function momentSheetLayout(
  format: Format,
  rows: readonly Pick<MomentSheetRow, "cells" | "splitAt">[],
  maxSide = QA_IMAGE_MAX_SIDE,
): { columns: number; frame: { width: number; height: number }; width: number; height: number } {
  const full = FORMAT_SIZE[format];
  const aspect = full.width / full.height;
  const n = Math.max(1, rows.length);
  const columns = Math.max(1, ...rows.map((r) => r.cells.length));
  const sep = rows.some((r) => r.splitAt !== undefined) ? SEP : 0;
  const maxW = (maxSide - GAP * (columns + 1) - sep) / columns;
  const maxH = (maxSide - GAP - n * (TITLE_H + LABEL_H + GAP)) / n;
  const w = Math.max(1, Math.floor(Math.min(full.width, maxW, maxH * aspect)));
  const frame = { width: w, height: Math.max(1, Math.floor(w / aspect)) };
  return {
    columns,
    frame,
    width: GAP + columns * (frame.width + GAP) + sep,
    height: GAP + n * (TITLE_H + frame.height + LABEL_H + GAP),
  };
}

function escapeXml(s: string): string {
  return s.replace(
    /[<>&"']/g,
    (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c] as string,
  );
}

function textBar(width: number, height: number, text: string, fill: string, size: number): Buffer {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
      `<rect width="100%" height="100%" fill="${fill}"/>` +
      `<text x="6" y="${height - Math.round((height - size) / 2) - 3}" font-family="DejaVu Sans, Arial, sans-serif" ` +
      `font-size="${size}" font-weight="bold" fill="#FFFFFF">${escapeXml(text)}</text></svg>`,
  );
}

function placeholderSvg(width: number, height: number, note: string): Buffer {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
      `<rect width="100%" height="100%" fill="#d9d9d9"/>` +
      `<line x1="0" y1="0" x2="${width}" y2="${height}" stroke="#b0b0b0" stroke-width="3"/>` +
      `<line x1="${width}" y1="0" x2="0" y2="${height}" stroke="#b0b0b0" stroke-width="3"/>` +
      `<text x="50%" y="50%" text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif" ` +
      `font-size="14" fill="#B00020">${escapeXml(note)}</text></svg>`,
  );
}

async function frameImage(cell: MomentCell, size: { width: number; height: number }): Promise<Buffer> {
  const placeholder = (note: string) =>
    sharp(placeholderSvg(size.width, size.height, note))
      .png()
      .toBuffer();
  if (!cell.png) return placeholder(cell.note ?? "немає кадру");
  try {
    return await sharp(cell.png).resize(size.width, size.height, { fit: "fill" }).png().toBuffer();
  } catch {
    return placeholder("кадр пошкоджено");
  }
}

/** Аркуш моментів однієї сцени в одному форматі: рядок на подію/склейку, JPEG у межах maxSide. */
export async function buildMomentSheet(
  format: Format,
  rows: readonly MomentSheetRow[],
  maxSide = QA_IMAGE_MAX_SIDE,
): Promise<Buffer> {
  const layout = momentSheetLayout(format, rows, maxSide);
  const { frame } = layout;
  const rowH = TITLE_H + frame.height + LABEL_H + GAP;
  const layers: OverlayOptions[] = [];
  for (const [r, row] of rows.entries()) {
    const top = GAP + r * rowH;
    layers.push({
      input: textBar(layout.width - 2 * GAP, TITLE_H, row.title, "#1f3a5f", 15),
      left: GAP,
      top,
    });
    for (const [i, cell] of row.cells.entries()) {
      const shift = row.splitAt !== undefined && i >= row.splitAt ? SEP : 0;
      const left = GAP + i * (frame.width + GAP) + shift;
      layers.push({ input: await frameImage(cell, frame), left, top: top + TITLE_H });
      layers.push({
        input: textBar(frame.width, LABEL_H, cell.label, "#111111", 13),
        left,
        top: top + TITLE_H + frame.height,
      });
    }
    if (row.splitAt !== undefined) {
      // Червона риска посередині проміжку між останнім кадром сцени і першим кадром наступної.
      layers.push({
        input: {
          create: {
            width: 4,
            height: frame.height + LABEL_H,
            channels: 3,
            background: { r: 230, g: 40, b: 40 },
          },
        },
        left: row.splitAt * (frame.width + GAP) + Math.floor((GAP + SEP) / 2) - 2,
        top: top + TITLE_H,
      });
    }
  }
  return sharp({ create: { width: layout.width, height: layout.height, channels: 3, background: BG } })
    .composite(layers)
    .jpeg({ quality: 85 })
    .toBuffer();
}
