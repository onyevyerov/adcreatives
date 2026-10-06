import { readFileSync, statSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Resolver } from "@adc/shared";
import sharp from "sharp";

/** Фікстура сайту кав'ярні: HTML з диска + фото, згенеровані sharp (детерміновані байти). */
export const SITE_DIR = fileURLToPath(new URL("../../fixtures/site", import.meta.url));

/** Хост фікстури: «публічний» для перевірки безпеки URL, з'єднання — на локальний сервер. */
export const SITE_HOST = "zerno.test";

/** DNS для тестів: `*.test` резолвиться в публічну адресу, тож `assertPublicHttpUrl` пропускає. */
export const testResolver: Resolver = async (host) => {
  if (host.endsWith(".test")) return ["93.184.216.34"];
  throw new Error(`ENOTFOUND ${host}`);
};

export const testHostMap = { [SITE_HOST]: "127.0.0.1" };

function photoSvg(kind: "hero" | "interior", w: number, h: number): string {
  const shapes =
    kind === "hero"
      ? `<rect width="100%" height="100%" fill="#3b2418"/><circle cx="35%" cy="55%" r="24%" fill="#f3e6d8"/><circle cx="35%" cy="55%" r="17%" fill="#a0673f"/><rect x="62%" y="18%" width="26%" height="64%" rx="24" fill="#e85d2a"/>`
      : `<rect width="100%" height="100%" fill="#c89f7a"/><rect x="8%" y="55%" width="84%" height="12%" fill="#6b3e26"/><circle cx="25%" cy="30%" r="10%" fill="#fff8f0"/><circle cx="70%" cy="30%" r="10%" fill="#fff8f0"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${shapes}</svg>`;
}

export async function renderPhoto(kind: "hero" | "interior", w: number, h: number): Promise<Buffer> {
  return sharp(Buffer.from(photoSvg(kind, w, h)))
    .jpeg({ quality: 85 })
    .toBuffer();
}

/** Фото клієнта (завантаження в intake): квадратний кадр 1400×1400. */
export async function userPhoto(): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="1400"><rect width="100%" height="100%" fill="#264653"/><circle cx="50%" cy="45%" r="30%" fill="#e9c46a"/><rect x="20%" y="78%" width="60%" height="8%" fill="#f4a261"/></svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 85 }).toBuffer();
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".svg": "image/svg+xml",
  ".jpg": "image/jpeg",
};

export interface FixtureSite {
  /** `http://zerno.test:<port>/` */
  url: string;
  hits: string[];
  close(): Promise<void>;
}

export async function startFixtureSite(): Promise<FixtureSite> {
  const images = new Map<string, Buffer>([
    ["/img/hero.jpg", await renderPhoto("hero", 1600, 900)],
    ["/img/interior.jpg", await renderPhoto("interior", 1200, 900)],
  ]);
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://x").pathname;
    hits.push(pathname);
    const generated = images.get(pathname);
    if (generated) {
      res.writeHead(200, { "content-type": "image/jpeg", "content-length": generated.length });
      res.end(generated);
      return;
    }
    if (pathname === "/robots.txt" || pathname === "/sitemap.xml") {
      res.writeHead(404).end();
      return;
    }
    const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const file = path.join(SITE_DIR, rel);
    if (!file.startsWith(SITE_DIR)) {
      res.writeHead(403).end();
      return;
    }
    try {
      if (!statSync(file).isFile()) throw new Error("not a file");
      const body = readFileSync(file);
      res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404, { "content-type": "text/html" }).end("<h1>404</h1>");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://${SITE_HOST}:${port}/`,
    hits,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
