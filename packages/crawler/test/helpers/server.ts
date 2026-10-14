import { existsSync, readFileSync, statSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Resolver } from "@adc/shared";
import sharp from "sharp";

export const FIXTURE_DIR = fileURLToPath(new URL("../fixtures/site", import.meta.url));
/** Сайт зі шрифтами: `@font-face` у CSS-файлі й у `<style>`, woff2 з кирилицею і без. */
export const FONT_FIXTURE_DIR = fileURLToPath(new URL("../fixtures/fontsite", import.meta.url));
/** Фікстура інтеграційних тестів (лише читання): той самий сайт, який бачить увесь пайплайн. */
export const INTEGRATION_FIXTURE_DIR = fileURLToPath(
  new URL("../../../../tests/integration/fixtures/site", import.meta.url),
);

export interface Hit {
  path: string;
  host: string;
  ua: string;
}

export interface FixtureServers {
  /** `http://site.test:<port>` */
  origin: string;
  port: number;
  /** `http://127.0.0.1:<port>` — «внутрішній сервіс», до якого краулер не має дійти. */
  internalOrigin: string;
  hits: Hit[];
  internalHits: string[];
  close(): Promise<void>;
}

/** DNS для тестів: `*.test` — «публічна» адреса (перевірка безпеки проходить), решта — помилка. */
export const testResolver: Resolver = async (host) => {
  if (host.endsWith(".test")) return ["93.184.216.34"];
  throw new Error(`ENOTFOUND ${host}`);
};

/** З'єднання з тестовими хостами насправді йдуть на локальний сервер. */
export const testHostMap = { "site.test": "127.0.0.1", "*.site.test": "127.0.0.1" };

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".xml": "application/xml",
  ".svg": "image/svg+xml",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".pdf": "application/pdf",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
};

/** Картинки фікстур генеруються з SVG-сцен: різні сцени дають різний pHash. */
function scene(kind: "hero" | "lazy" | "bg" | "og" | "team", w: number, h: number): string {
  const shapes: Record<typeof kind, string> = {
    hero: `<rect width="100%" height="100%" fill="#3b6ea5"/><circle cx="30%" cy="40%" r="22%" fill="#f2d16b"/><rect x="55%" y="20%" width="35%" height="60%" fill="#1d3557"/>`,
    lazy: `<rect width="100%" height="100%" fill="#2a9d8f"/><polygon points="0,${h} ${w / 2},0 ${w},${h}" fill="#e9c46a"/>`,
    bg: `<defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="#264653"/><stop offset="1" stop-color="#8ab17d"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><circle cx="80%" cy="70%" r="15%" fill="#ffffff"/>`,
    og: `<rect width="100%" height="100%" fill="#f4a261"/><rect x="10%" y="10%" width="20%" height="80%" fill="#264653"/><rect x="40%" y="10%" width="20%" height="80%" fill="#264653"/>`,
    team: `<rect width="100%" height="100%" fill="#6d597a"/><circle cx="25%" cy="50%" r="12%" fill="#eaac8b"/><circle cx="50%" cy="50%" r="12%" fill="#eaac8b"/><circle cx="75%" cy="50%" r="12%" fill="#eaac8b"/>`,
  };
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${shapes[kind]}</svg>`;
}

export async function renderScene(kind: Parameters<typeof scene>[0], w: number, h: number): Promise<Buffer> {
  return sharp(Buffer.from(scene(kind, w, h)))
    .jpeg({ quality: 85 })
    .toBuffer();
}

async function buildImages(): Promise<Map<string, { body: Buffer; type: string }>> {
  const jpg = (body: Buffer) => ({ body, type: "image/jpeg" });
  return new Map([
    ["/img/hero-1600.jpg", jpg(await renderScene("hero", 1600, 900))],
    ["/img/hero-800.jpg", jpg(await renderScene("hero", 800, 450))],
    ["/img/hero-copy.jpg", jpg(await renderScene("hero", 640, 360))],
    ["/img/lazy-photo.jpg", jpg(await renderScene("lazy", 1200, 900))],
    ["/img/bg.jpg", jpg(await renderScene("bg", 1920, 1080))],
    ["/img/og.jpg", jpg(await renderScene("og", 1200, 630))],
    ["/img/team.jpg", jpg(await renderScene("team", 1200, 800))],
    [
      "/img/touch-icon.png",
      {
        body: await sharp({ create: { width: 180, height: 180, channels: 4, background: "#6b3e26" } })
          .png()
          .toBuffer(),
        type: "image/png",
      },
    ],
  ]);
}

/** Статичний сервер фікстур + «внутрішній» сервер на 127.0.0.1 для перевірки SSRF. */
export async function startFixtureServers(opts: { root?: string } = {}): Promise<FixtureServers> {
  const root = opts.root ?? FIXTURE_DIR;
  const images = await buildImages();
  const hits: Hit[] = [];
  const internalHits: string[] = [];

  const internal = http.createServer((req, res) => {
    internalHits.push(req.url ?? "");
    res.writeHead(200, { "content-type": "text/plain" }).end("SECRET-INTERNAL-DATA");
  });
  await listen(internal);
  const internalOrigin = `http://127.0.0.1:${(internal.address() as AddressInfo).port}`;

  let origin = "";
  const site = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    hits.push({ path: url.pathname, host: req.headers.host ?? "", ua: req.headers["user-agent"] ?? "" });
    const p = decodeURIComponent(url.pathname);
    if (p === "/redirect-internal") {
      res.writeHead(302, { location: `${internalOrigin}/secret` }).end();
      return;
    }
    if (p === "/redirect-about") {
      res.writeHead(301, { location: "/about" }).end();
      return;
    }
    if (p === "/consent-accepted") {
      res.writeHead(204).end();
      return;
    }
    if (p.startsWith("/slow/")) {
      // Сторінка, що «висить» довше за ліміт часу.
      const timer = setTimeout(
        () => res.writeHead(200, { "content-type": "text/html" }).end("<h1>slow</h1>"),
        20_000,
      );
      res.on("close", () => clearTimeout(timer));
      return;
    }
    const img = images.get(p);
    if (img) {
      res.writeHead(200, { "content-type": img.type, "content-length": img.body.length }).end(img.body);
      return;
    }
    const file = resolveFile(root, p);
    if (!file) {
      res.writeHead(404, { "content-type": "text/html" }).end("<h1>404</h1>");
      return;
    }
    const ext = path.extname(file);
    let body: Buffer | string = readFileSync(file);
    if (ext === ".html" || ext === ".xml") {
      body = body
        .toString("utf8")
        .replaceAll("{{ORIGIN}}", origin)
        .replaceAll("{{PORT}}", String((site.address() as AddressInfo).port))
        .replaceAll("{{INTERNAL}}", internalOrigin);
    }
    res.writeHead(200, { "content-type": MIME[ext] ?? "application/octet-stream" }).end(body);
  });
  await listen(site);
  const port = (site.address() as AddressInfo).port;
  origin = `http://site.test:${port}`;

  return {
    origin,
    port,
    internalOrigin,
    hits,
    internalHits,
    close: async () => {
      site.closeAllConnections();
      internal.closeAllConnections();
      await Promise.all([close(site), close(internal)]);
    },
  };
}

function resolveFile(root: string, p: string): string | null {
  const rel = p.replace(/^\/+/, "").replace(/\/+$/, "");
  if (rel.includes("..")) return null;
  const candidates = rel === "" ? ["index.html"] : [rel, `${rel}.html`, path.join(rel, "index.html")];
  for (const c of candidates) {
    const full = path.join(root, c);
    if (existsSync(full) && statSync(full).isFile()) return full;
  }
  return null;
}

function listen(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}
