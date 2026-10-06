import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  inputsHash,
  LocalStorage,
  NotFoundInStorageError,
  normalizeKey,
  projectPaths,
  StorageKeyError,
  stableStringify,
} from "../src/storage/index.ts";

const tmpStorage = () => new LocalStorage(mkdtempSync(path.join(tmpdir(), "adc-storage-")));

describe("LocalStorage", () => {
  it("write/read/json/exists/list/listDirs/copy/append", async () => {
    const s = tmpStorage();
    const p = projectPaths("p1");
    await s.writeJson(p.project, { a: 1 });
    expect(await s.readJson(p.project)).toEqual({ a: 1 });
    expect(await s.exists(p.project)).toBe(true);
    expect(await s.exists(p.site)).toBe(false);

    await s.write(p.rev(1).scene("s1"), "export default 1;");
    await s.copy(p.rev(1).scene("s1"), p.rev(2).scene("s1"));
    expect(await s.readText(p.rev(2).scene("s1"))).toBe("export default 1;");

    await s.append(p.costs, '{"x":1}');
    await s.append(p.costs, '{"x":2}\n');
    expect(await s.readText(p.costs)).toBe('{"x":1}\n{"x":2}\n');

    expect(await s.list("projects/p1/rev")).toEqual([
      "projects/p1/rev/1/video/scenes/s1.tsx",
      "projects/p1/rev/2/video/scenes/s1.tsx",
    ]);
    expect(await s.listDirs("projects")).toEqual(["p1"]);
    expect(await s.listDirs("nope")).toEqual([]);
    await expect(s.read("projects/p1/missing.json")).rejects.toBeInstanceOf(NotFoundInStorageError);
  });

  it("запис атомарний: паралельний читач ніколи не бачить напівзаписаний JSON", async () => {
    const s = tmpStorage();
    const key = projectPaths("p1").project;
    const big = { pad: "x".repeat(200_000) };
    await s.writeJson(key, { v: 0, ...big });
    let stop = false;
    const reader = (async () => {
      let reads = 0;
      while (!stop) {
        const v = await s.readJson<{ v: number }>(key); // кидає SyntaxError на порожньому/обрізаному файлі
        expect(typeof v.v).toBe("number");
        reads++;
      }
      return reads;
    })();
    for (let i = 1; i <= 40; i++) await s.writeJson(key, { v: i, ...big });
    stop = true;
    expect(await reader).toBeGreaterThan(0);
    expect(await s.readJson(key)).toMatchObject({ v: 40 });
    expect((await s.list("projects/p1")).filter((k) => k.includes(".tmp"))).toEqual([]);
  });

  it("blocks keys outside the root", async () => {
    const s = tmpStorage();
    for (const bad of ["../x", "a/../../x", "/etc/passwd", "C:/Windows", "..\\x", ""]) {
      expect(() => normalizeKey(bad)).toThrow(StorageKeyError);
    }
    await expect(s.write("../escape.txt", "x")).rejects.toBeInstanceOf(StorageKeyError);
    expect(normalizeKey("a\\b/./c")).toBe("a/b/c");
  });

  it("publicUrl encodes path segments", () => {
    const s = tmpStorage();
    expect(s.publicUrl("projects/p1/uploads/фото 1.jpg")).toBe(
      "/files/projects/p1/uploads/%D1%84%D0%BE%D1%82%D0%BE%201.jpg",
    );
  });
});

describe("paths", () => {
  it("revision layout", () => {
    const r = projectPaths("abc").rev(3);
    expect(r.still("square", "s2", "b")).toBe("projects/abc/rev/3/stills/square/s2-b.png");
    expect(r.render("landscape")).toBe("projects/abc/rev/3/renders/landscape.mp4");
    expect(r.scenesIndex).toBe("projects/abc/rev/3/video/scenes/index.ts");
    expect(projectPaths("abc").brandkit(2)).toBe("projects/abc/brandkit/v2.json");
  });
});

describe("hash", () => {
  it("inputsHash ignores key order and undefined, sensitive to values", () => {
    expect(inputsHash({ a: { x: 1, y: [1, 2] }, b: "q" })).toBe(
      inputsHash({ b: "q", a: { y: [1, 2], x: 1 }, c: undefined }),
    );
    expect(inputsHash({ a: 1 })).not.toBe(inputsHash({ a: 2 }));
    expect(inputsHash({ buf: Buffer.from("x") })).not.toBe(inputsHash({ buf: Buffer.from("y") }));
    expect(stableStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });
});
