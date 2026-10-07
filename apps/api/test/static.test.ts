import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_PUBLIC_DIR } from "../src/config.ts";
import { setup } from "./helpers.ts";

/** Окрема тека public/ у тимчасовому корені, поруч — секрет, який не має віддаватись. */
async function seedStatic() {
  const root = mkdtempSync(path.join(tmpdir(), "adc-static-"));
  const publicDir = path.join(root, "public");
  const dir = path.join(publicDir, "static");
  mkdirSync(path.join(dir, "css"), { recursive: true });
  mkdirSync(path.join(dir, "js"), { recursive: true });
  mkdirSync(path.join(dir, "media"), { recursive: true });
  writeFileSync(path.join(dir, "css", "tokens.css"), ":root{--ink:#151412}");
  writeFileSync(path.join(dir, "js", "app.js"), "export {};");
  writeFileSync(path.join(dir, "media", "clip.mp4"), "0123456789");
  writeFileSync(path.join(dir, "media", "dot.svg"), "<svg/>");
  writeFileSync(path.join(dir, "notes.txt"), "не для віддачі");
  writeFileSync(path.join(dir, ".hidden.css"), "secret{}");
  writeFileSync(path.join(root, "secret.css"), "TOP SECRET");
  writeFileSync(path.join(publicDir, "secret.js"), "TOP SECRET");
  return setup({ publicDir });
}

describe("GET /static/*", () => {
  it("віддає css і js з правильним Content-Type і заголовками", async () => {
    const env = await seedStatic();
    const css = await env.app.request("/static/css/tokens.css");
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(css.headers.get("x-content-type-options")).toBe("nosniff");
    expect(css.headers.get("cache-control")).toBe("no-cache");
    expect(await css.text()).toBe(":root{--ink:#151412}");

    const js = await env.app.request("/static/js/app.js");
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(await js.text()).toBe("export {};");

    const svg = await env.app.request("/static/media/dot.svg");
    expect(svg.headers.get("content-type")).toBe("image/svg+xml");
  });

  it("відсутній файл, тека або тип поза переліком → 404", async () => {
    const env = await seedStatic();
    expect((await env.app.request("/static/css/nope.css")).status).toBe(404);
    expect((await env.app.request("/static/css")).status).toBe(404);
    expect((await env.app.request("/static/notes.txt")).status).toBe(404);
  });

  it.each([
    "/static/..%2Fsecret.js",
    "/static/css/..%2F..%2F..%2Fsecret.css",
    "/static/%2e%2e%2Fsecret.js",
    "/static/%2E%2E%2F%2E%2E%2Fsecret.css",
    "/static/css/%2e%2e%5C%2e%2e%5Csecret.css",
    "/static/.hidden.css",
    "/static/css//tokens.css",
    "/static/js/%00.js",
    "/static/",
  ])("обхід шляху %s → 400", async (url) => {
    const env = await seedStatic();
    const res = await env.app.request(url);
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain("TOP SECRET");
  });

  it("неканонічні .. (нормалізуються URL-парсером) не виходять за static/", async () => {
    const env = await seedStatic();
    for (const url of [
      "/static/../secret.js",
      "/static/css/%2e%2e/%2e%2e/secret.js",
      "/static/./../secret.js",
    ]) {
      const res = await env.app.request(url);
      expect(res.status).not.toBe(200);
      expect(await res.text()).not.toContain("TOP SECRET");
    }
  });

  it("Range для mp4 → 206", async () => {
    const env = await seedStatic();
    const res = await env.app.request("/static/media/clip.mp4", { headers: { Range: "bytes=2-5" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-type")).toBe("video/mp4");
    expect(res.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(await res.text()).toBe("2345");
    const full = await env.app.request("/static/media/clip.mp4");
    expect(full.status).toBe(200);
    expect(await full.text()).toBe("0123456789");
    const bad = await env.app.request("/static/media/clip.mp4", { headers: { Range: "bytes=50-60" } });
    expect(bad.status).toBe(416);
  });

  it("справжня тека public/: index.html підключає модуль, і він віддається", async () => {
    const env = await setup({ publicDir: DEFAULT_PUBLIC_DIR });
    const page = await env.app.request("/");
    const html = await page.text();
    expect(html).toContain('<script type="module" src="/static/js/app.js"></script>');
    for (const m of html.matchAll(/(?:href|src)="(\/static\/[^"]+)"/g)) {
      const res = await env.app.request(m[1] as string);
      expect(res.status, m[1]).toBe(200);
    }
  });
});
