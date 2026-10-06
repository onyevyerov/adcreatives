import http from "node:http";
import net from "node:net";
import { pinnedLookup } from "./fetch.ts";
import type { UrlGuard } from "./guard.ts";

/**
 * Фільтрувальний HTTP-проксі для Chromium. Через нього йде весь трафік браузера,
 * включно з кожним кроком редиректу (Playwright `route` редиректи не бачить),
 * WebSocket і HTTPS (CONNECT). Приватні адреси отримують 403, з'єднання йде лише на
 * перевірену IP. Браузер запускається з `--proxy-bypass-list=<-loopback>`, щоб навіть
 * 127.0.0.1 не обходив проксі.
 */
export interface GuardProxy {
  /** `http://127.0.0.1:<port>` */
  server: string;
  close(): Promise<void>;
}

const HOP_HEADERS = new Set([
  "proxy-connection",
  "proxy-authorization",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
]);

export async function startGuardProxy(
  guard: UrlGuard,
  opts: { idleTimeoutMs?: number } = {},
): Promise<GuardProxy> {
  const idle = opts.idleTimeoutMs ?? 30_000;
  const sockets = new Set<net.Socket>();
  const lookup = pinnedLookup(guard);

  const server = http.createServer((req, res) => {
    let url: URL;
    try {
      url = new URL(req.url ?? "");
      if (url.protocol !== "http:") throw new Error("protocol");
    } catch {
      res.writeHead(400).end();
      return;
    }
    guard.resolveTarget(url.hostname).then(
      () => {
        const headers: http.OutgoingHttpHeaders = {};
        for (const [k, v] of Object.entries(req.headers)) {
          if (!HOP_HEADERS.has(k.toLowerCase()) && v !== undefined) headers[k] = v;
        }
        const upstream = http.request(
          {
            protocol: "http:",
            hostname: url.hostname,
            port: url.port || 80,
            path: `${url.pathname}${url.search}`,
            method: req.method,
            headers,
            lookup,
            timeout: idle,
          },
          (up) => {
            const out: http.OutgoingHttpHeaders = {};
            for (const [k, v] of Object.entries(up.headers)) {
              if (!HOP_HEADERS.has(k.toLowerCase()) && v !== undefined) out[k] = v;
            }
            res.writeHead(up.statusCode ?? 502, up.statusMessage, out);
            up.pipe(res);
            up.on("error", () => res.destroy());
          },
        );
        upstream.on("timeout", () => upstream.destroy());
        upstream.on("error", () => {
          if (!res.headersSent) res.writeHead(502).end();
          else res.destroy();
        });
        req.pipe(upstream);
      },
      () => {
        guard.noteBlocked(url.href);
        res.writeHead(403, { "content-type": "text/plain" }).end("blocked by crawler");
      },
    );
  });

  server.on("connect", (req: http.IncomingMessage, client: net.Socket, head: Buffer) => {
    const target = req.url ?? "";
    const m = /^\[?([^\]]+?)\]?:(\d+)$/.exec(target);
    if (!m?.[1] || !m[2]) {
      client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    const host = m[1];
    const port = Number(m[2]);
    client.on("error", () => {});
    guard.resolveTarget(host).then(
      (ip) => {
        const upstream = net.connect({ host: ip, port, timeout: idle });
        upstream.once("connect", () => {
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (head.length) upstream.write(head);
          upstream.pipe(client);
          client.pipe(upstream);
        });
        upstream.on("timeout", () => upstream.destroy());
        upstream.on("error", () => {
          if (client.writable) client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
        });
        upstream.on("close", () => client.destroy());
        client.on("close", () => upstream.destroy());
      },
      () => {
        guard.noteBlocked(`https://${target}/`);
        client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      },
    );
  });

  // Upgrade (WebSocket по http://) через проксі Chromium робить CONNECT, тож тут лише закриваємо.
  server.on("upgrade", (_req, socket: net.Socket) => socket.destroy());
  server.on("connection", (s: net.Socket) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as net.AddressInfo;
  return {
    server: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
