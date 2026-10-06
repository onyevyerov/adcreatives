import { describe, expect, it } from "vitest";
import { assertPublicHttpUrl, isPublicIp, normalizeInputUrl, UnsafeUrlError } from "../src/net/safeUrl.ts";
import { classifySource } from "../src/net/source.ts";

const resolveTo =
  (...ips: string[]) =>
  async () =>
    ips;

describe("assertPublicHttpUrl", () => {
  it("accepts public http(s)", async () => {
    const url = await assertPublicHttpUrl("https://example.com/path?q=1", {
      resolve: resolveTo("93.184.215.14"),
    });
    expect(url.hostname).toBe("example.com");
    await expect(assertPublicHttpUrl("http://8.8.8.8/")).resolves.toBeInstanceOf(URL);
  });

  it.each([
    "http://127.0.0.1/",
    "http://127.1/",
    "http://2130706433/",
    "http://0x7f000001/",
    "http://0.0.0.0/",
    "http://10.0.0.5/",
    "http://172.16.1.1/",
    "http://192.168.1.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://100.100.100.200/",
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[fd00:ec2::254]/",
    "http://[fe80::1]/",
    "http://224.0.0.1/",
  ])("rejects private literal %s", async (u) => {
    await expect(assertPublicHttpUrl(u)).rejects.toMatchObject({ reason: "private_address" });
  });

  it.each([
    "http://localhost:3000/",
    "http://metadata.google.internal/",
    "http://router.local/",
    "http://intranet/",
  ])("rejects blocked host %s", async (u) => {
    await expect(assertPublicHttpUrl(u, { resolve: resolveTo("8.8.8.8") })).rejects.toMatchObject({
      reason: "blocked_host",
    });
  });

  it("rejects hostnames resolving to private addresses (DNS rebinding)", async () => {
    await expect(
      assertPublicHttpUrl("https://evil.example.com/", { resolve: resolveTo("93.184.215.14", "127.0.0.1") }),
    ).rejects.toMatchObject({ reason: "private_address" });
  });

  it("rejects bad protocols, credentials, garbage and DNS failures", async () => {
    await expect(assertPublicHttpUrl("file:///etc/passwd")).rejects.toMatchObject({ reason: "protocol" });
    await expect(assertPublicHttpUrl("ftp://example.com/")).rejects.toMatchObject({ reason: "protocol" });
    await expect(assertPublicHttpUrl("https://user:pw@example.com/")).rejects.toMatchObject({
      reason: "credentials",
    });
    await expect(assertPublicHttpUrl("not a url")).rejects.toBeInstanceOf(UnsafeUrlError);
    await expect(
      assertPublicHttpUrl("https://nx.example.com/", {
        resolve: async () => {
          throw new Error("ENOTFOUND");
        },
      }),
    ).rejects.toMatchObject({ reason: "dns" });
  });

  it("isPublicIp / normalizeInputUrl", () => {
    expect(isPublicIp("1.1.1.1")).toBe(true);
    expect(isPublicIp("2606:4700:4700::1111")).toBe(true);
    expect(isPublicIp("192.168.0.1")).toBe(false);
    expect(isPublicIp("garbage")).toBe(false);
    expect(normalizeInputUrl(" zerno.ua ")).toBe("https://zerno.ua");
    expect(normalizeInputUrl("http://zerno.ua")).toBe("http://zerno.ua");
  });
});

describe("classifySource", () => {
  it.each([
    ["https://www.instagram.com/zerno/", "social"],
    ["https://m.facebook.com/zerno", "social"],
    ["https://t.me/zerno", "social"],
    ["https://www.tiktok.com/@zerno", "social"],
    ["https://linktr.ee/zerno", "social"],
    ["https://www.google.com/maps/place/Zerno", "social"],
    ["https://rozetka.com.ua/ua/123/p123/", "marketplace"],
    ["https://prom.ua/ua/p123-kava.html", "marketplace"],
    ["https://www.olx.ua/d/uk/obyavlenie/x", "marketplace"],
    ["https://www.amazon.de/dp/B00", "marketplace"],
    ["https://www.etsy.com/shop/zerno", "marketplace"],
    ["https://zerno.example.com/", "site"],
    ["https://instagram-tips.com.ua/", "site"],
    ["https://www.google.com/", "site"],
  ])("%s → %s", (url, kind) => {
    expect(classifySource(url)).toBe(kind);
  });
});
