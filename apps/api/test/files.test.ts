import { writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { decodeFileKey, parseRange } from "../src/routes/files.ts";
import { setup } from "./helpers.ts";

async function seedFiles() {
  const env = await setup();
  await env.storage.write("projects/p1/rev/1/renders/vertical.mp4", "0123456789");
  await env.storage.write("projects/p1/uploads/фото 1.jpg", "jpeg");
  await env.storage.write("projects/p1/crawl/assets/logo.svg", "<svg><script>alert(1)</script></svg>");
  // Секрет поза DATA_DIR — ніколи не має віддаватись.
  writeFileSync(path.join(env.root, "secret.txt"), "TOP SECRET");
  return env;
}

describe("GET /files/*", () => {
  it("віддає файл зі сховища з типом і заголовками безпеки", async () => {
    const env = await seedFiles();
    const res = await env.app.request("/files/projects/p1/rev/1/renders/vertical.mp4");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("video/mp4");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toBe("0123456789");

    const svg = await env.app.request("/files/projects/p1/crawl/assets/logo.svg");
    expect(svg.headers.get("content-type")).toBe("image/svg+xml");
    expect(svg.headers.get("content-security-policy")).toContain("sandbox");
  });

  it("працює з publicUrl (закодовані сегменти, кирилиця, пробіли)", async () => {
    const env = await seedFiles();
    const url = env.storage.publicUrl("projects/p1/uploads/фото 1.jpg");
    const res = await env.app.request(url);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("jpeg");
  });

  it("Range-запити для відео/аудіо", async () => {
    const env = await seedFiles();
    const res = await env.app.request("/files/projects/p1/rev/1/renders/vertical.mp4", {
      headers: { Range: "bytes=2-5" },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(await res.text()).toBe("2345");
    const bad = await env.app.request("/files/projects/p1/rev/1/renders/vertical.mp4", {
      headers: { Range: "bytes=50-60" },
    });
    expect(bad.status).toBe(416);
  });

  it.each([
    "/files/..%2Fsecret.txt",
    "/files/..%2f..%2fsecret.txt",
    "/files/projects/..%5C..%5Csecret.txt",
    "/files/projects/%2E%2E%5Csecret.txt",
    "/files/C:%5Cwindows%5Cwin.ini",
    "/files/projects//p1",
    "/files/.env",
    "/files/projects/p1/%00.mp4",
    "/files/%E0%A4%A",
  ])("обхід шляху %s відхиляється", async (url) => {
    const env = await seedFiles();
    const res = await env.app.request(url);
    expect([400, 404]).toContain(res.status);
    expect(await res.text()).not.toContain("TOP SECRET");
  });

  it("неканонічні .. (нормалізуються URL-парсером) не виходять за DATA_DIR", async () => {
    const env = await seedFiles();
    for (const url of [
      "/files/../secret.txt",
      "/files/projects/%2e%2e/%2e%2e/secret.txt",
      "/files/./../secret.txt",
    ]) {
      const res = await env.app.request(url);
      expect(res.status).not.toBe(200);
      expect(await res.text()).not.toContain("TOP SECRET");
    }
  });

  it("неіснуючий файл або тека → 404", async () => {
    const env = await seedFiles();
    expect((await env.app.request("/files/projects/p1/nope.png")).status).toBe(404);
    expect((await env.app.request("/files/projects/p1")).status).toBe(404);
  });

  it("decodeFileKey і parseRange", () => {
    expect(decodeFileKey("projects/p1/a%20b.png")).toBe("projects/p1/a b.png");
    expect(decodeFileKey("projects/../x")).toBeNull();
    expect(decodeFileKey("a%2Fb")).toBeNull();
    expect(decodeFileKey("")).toBeNull();
    expect(parseRange("bytes=0-", 10)).toEqual({ start: 0, end: 9 });
    expect(parseRange("bytes=-3", 10)).toEqual({ start: 7, end: 9 });
    expect(parseRange("bytes=5-100", 10)).toEqual({ start: 5, end: 9 });
    expect(parseRange("bytes=9-2", 10)).toBeNull();
    expect(parseRange("items=0-1", 10)).toBeNull();
  });
});
