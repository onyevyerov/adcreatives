import http from "node:http";
import { UnsafeUrlError } from "@adc/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { safeFetch } from "../src/fetch.ts";
import { UrlGuard } from "../src/guard.ts";
import { startGuardProxy } from "../src/proxy.ts";
import { type FixtureServers, startFixtureServers, testHostMap, testResolver } from "./helpers/server.ts";

let servers: FixtureServers;
beforeAll(async () => {
  servers = await startFixtureServers();
});
afterAll(async () => {
  await servers?.close();
});

const guard = () => new UrlGuard({ resolve: testResolver, hostMap: testHostMap });

describe("UrlGuard", () => {
  it("приватні адреси й службові хости заборонені, тестовий хост — дозволений", async () => {
    const g = guard();
    expect(await g.isAllowed(`${servers.origin}/`)).toBe(true);
    expect(await g.isAllowed("http://127.0.0.1/")).toBe(false);
    expect(await g.isAllowed("http://[::1]/")).toBe(false);
    expect(await g.isAllowed("http://169.254.169.254/latest")).toBe(false);
    expect(await g.isAllowed("http://localhost:3000/")).toBe(false);
    expect(await g.isAllowed("file:///etc/passwd")).toBe(false);
    expect(await g.isAllowed("http://user:pass@site.test/")).toBe(false);
    expect(await g.isAllowed("data:image/png;base64,AAAA")).toBe(true);
    await expect(g.resolveTarget("10.0.0.1")).rejects.toBeInstanceOf(UnsafeUrlError);
    expect(await g.resolveTarget("site.test")).toBe("127.0.0.1");
  });

  it("хост, що резолвиться в приватну адресу, заборонений навіть з hostMap", async () => {
    const g = new UrlGuard({ resolve: async () => ["10.1.2.3"], hostMap: testHostMap });
    await expect(g.resolveTarget("site.test")).rejects.toMatchObject({ reason: "private_address" });
  });
});

describe("safeFetch", () => {
  it("іде за безпечними редиректами", async () => {
    const res = await safeFetch(guard(), `${servers.origin}/redirect-about`);
    expect(res.status).toBe(200);
    expect(res.url).toBe(`${servers.origin}/about`);
    expect(res.body.toString()).toContain("Про нас");
  });

  it("обриває редирект на 127.0.0.1 до з'єднання", async () => {
    const g = guard();
    await expect(safeFetch(g, `${servers.origin}/redirect-internal`)).rejects.toBeInstanceOf(UnsafeUrlError);
    expect(g.blocked).toEqual([`${servers.internalOrigin}/secret`]);
    expect(servers.internalHits).toEqual([]);
  });

  it("обмежує розмір відповіді", async () => {
    await expect(safeFetch(guard(), `${servers.origin}/img/bg.jpg`, { maxBytes: 100 })).rejects.toThrow(
      /завеликий/,
    );
  });
});

describe("фільтрувальний проксі", () => {
  it("пропускає публічні адреси і відповідає 403 на приватні", async () => {
    const g = guard();
    const proxy = await startGuardProxy(g);
    const port = Number(new URL(proxy.server).port);
    const viaProxy = (target: string) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = http.request(
          { host: "127.0.0.1", port, method: "GET", path: target, headers: { host: new URL(target).host } },
          (res) => {
            let body = "";
            res.on("data", (c) => {
              body += c;
            });
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
          },
        );
        req.on("error", reject);
        req.end();
      });
    try {
      const ok = await viaProxy(`${servers.origin}/about`);
      expect(ok.status).toBe(200);
      expect(ok.body).toContain("Про нас");
      const blocked = await viaProxy(`${servers.internalOrigin}/secret`);
      expect(blocked.status).toBe(403);
      expect(servers.internalHits).toEqual([]);
      expect(g.blocked).toContain(`${servers.internalOrigin}/secret`);
    } finally {
      await proxy.close();
    }
  });
});
