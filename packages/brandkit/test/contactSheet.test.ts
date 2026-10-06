import { projectPaths } from "@adc/shared";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { buildContactSheet, contactSheetLegend, prepareScreenshot } from "../src/contactSheet.ts";
import { PROJECT, photoAsset, seedProject, solidPng, tempStorage } from "./helpers.ts";

describe("contact sheet", () => {
  it("builds one PNG grid with expected dimensions and numbered cells", async () => {
    const storage = tempStorage();
    const assets = Array.from({ length: 10 }, (_, i) =>
      photoAsset(`a${String(i + 1).padStart(2, "0")}`, { priority: i === 9 ? 100 : 1 }),
    );
    await seedProject(storage, { assets });

    const sheet = await buildContactSheet(storage, assets, { cell: 100 });
    // 10 асетів → 4 колонки, 3 ряди; клітинка 100 + підпис 26, проміжок 8.
    expect(sheet.columns).toBe(4);
    expect(sheet.rows).toBe(3);
    expect(sheet.width).toBe(8 + 4 * 108);
    expect(sheet.height).toBe(8 + 3 * (126 + 8));
    const meta = await sharp(sheet.png).metadata();
    expect(meta.format).toBe("png");
    expect([meta.width, meta.height]).toEqual([sheet.width, sheet.height]);
    // Пріоритетний асет — першим.
    expect(sheet.cells[0]).toEqual({ n: 1, assetId: "a10", ok: true });
    expect(sheet.cells.map((c) => c.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("caps size for many assets and renders SVG logos and unreadable files", async () => {
    const storage = tempStorage();
    const assets = Array.from({ length: 60 }, (_, i) => photoAsset(`a${i + 1}`));
    await seedProject(storage, { assets });
    const broken = photoAsset("bad", { path: projectPaths(PROJECT).asset("missing.png"), priority: 50 });
    const sheet = await buildContactSheet(storage, [...assets, broken]);
    expect(sheet.cells).toHaveLength(48);
    expect(sheet.columns).toBe(7);
    expect(Math.max(sheet.width, sheet.height)).toBeLessThanOrEqual(1600);
    expect(sheet.cells[0]).toEqual({ n: 1, assetId: "bad", ok: false });
    const legend = contactSheetLegend(sheet, [...assets, broken]);
    expect(legend[0]).toMatchObject({ n: 1, assetId: "bad", unreadable: true });
    expect(legend[1]).toMatchObject({ n: 2, kind: "photo", size: "800×600" });
  });

  it("renders the fixture SVG logo", async () => {
    const storage = tempStorage();
    const { assets } = await seedProject(storage);
    const sheet = await buildContactSheet(storage, assets);
    expect(sheet.cells.every((c) => c.ok)).toBe(true);
  });

  it("prepares screenshots as JPEG within the size limit", async () => {
    const jpeg = await prepareScreenshot(await solidPng(2880, 1800, "#FFFFFF"));
    const meta = await sharp(jpeg).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.width).toBe(1440);
    expect(meta.height).toBe(900);
  });
});
