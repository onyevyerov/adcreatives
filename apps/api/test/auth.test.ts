import { describe, expect, it } from "vitest";
import { basicPassword } from "../src/auth.ts";
import { basic, form, json, setup } from "./helpers.ts";

/** Admin — щоб `/api/stats` теж відповідав 200 (Basic-gate перевіряється окремо від ролей). */
const ADMIN = { user: { email: "admin@example.com", admin: true, credits: 100 } };

describe("HTTP Basic (APP_PASSWORD)", () => {
  it("порожній пароль — без Basic-gate, доступ лише за сесією", async () => {
    const env = await setup({ appPassword: "" }, ADMIN);
    expect((await env.request("/api/projects")).status).toBe(200);
    expect((await env.request("/api/stats")).status).toBe(200);
    // Без сесії — 401 від requireUser, а не від Basic.
    const anon = await env.app.request("/api/projects");
    expect(anon.status).toBe(401);
    expect(anon.headers.get("www-authenticate")).toBeNull();
  });

  it("з паролем: 401 без заголовка і з неправильним паролем, 200 з правильним (ім'я будь-яке)", async () => {
    const env = await setup({ appPassword: "s3cret" }, ADMIN);
    for (const route of ["/", "/api/projects", "/api/stats", "/api/stats.csv", "/files/x.png"]) {
      // Навіть із валідною сесією Basic-gate стоїть поверх усього.
      const res = await env.request(route);
      expect(res.status, route).toBe(401);
      expect(res.headers.get("www-authenticate")).toMatch(/^Basic realm="AdCreative"/);
    }
    const wrong = await env.request("/api/projects", { headers: { Authorization: basic("nope") } });
    expect(wrong.status).toBe(401);
    for (const user of ["team", "", "будь-хто"]) {
      const ok = await env.request("/api/projects", {
        headers: { Authorization: basic("s3cret", user) },
      });
      expect(ok.status).toBe(200);
    }
    const page = await env.app.request("/", { headers: { Authorization: basic("s3cret") } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<div id="app"');
    expect((await env.app.request("/static/js/app.js")).status).toBe(401);
    const js = await env.app.request("/static/js/app.js", { headers: { Authorization: basic("s3cret") } });
    expect(js.status).toBe(200);
  });

  it("POST без пароля не ставить команд і не списує кредитів", async () => {
    const env = await setup({ appPassword: "s3cret" }, ADMIN);
    const res = await env.request("/api/projects", {
      method: "POST",
      body: form({ url: "https://zerno.example.com" }),
    });
    expect(res.status).toBe(401);
    expect(env.queue.pipeline).toHaveLength(0);
    expect(await env.accounts.balance(env.user?.id ?? "")).toBe(100);
  });

  it("healthz доступний без пароля", async () => {
    const env = await setup({ appPassword: "s3cret" });
    expect((await env.app.request("/healthz")).status).toBe(200);
  });

  it("basicPassword розбирає заголовок", () => {
    expect(basicPassword(basic("p:with:colons"))).toBe("p:with:colons");
    expect(basicPassword("Bearer x")).toBeNull();
    expect(basicPassword(undefined)).toBeNull();
    expect(basicPassword(`Basic ${Buffer.from("nocolon").toString("base64")}`)).toBeNull();
  });
});

describe("захист від запитів з інших сайтів", () => {
  it("POST з чужим Origin або Sec-Fetch-Site: cross-site → 403", async () => {
    const env = await setup({}, { user: { credits: 100 } });
    const evil = await env.request("/api/projects", {
      ...json({ url: "https://zerno.example.com" }),
      headers: {
        "Content-Type": "application/json",
        Origin: "https://evil.example",
        Host: "demo.example.com",
      },
    });
    expect(evil.status).toBe(403);
    const cross = await env.request("/api/projects", {
      ...json({ url: "https://zerno.example.com" }),
      headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "cross-site" },
    });
    expect(cross.status).toBe(403);
    expect(env.queue.pipeline).toHaveLength(0);
    expect(await env.accounts.balance(env.user?.id ?? "")).toBe(100);

    const same = await env.request("/api/projects", {
      ...json({ url: "https://zerno.example.com" }),
      headers: {
        "Content-Type": "application/json",
        Origin: "https://demo.example.com",
        Host: "internal:3000",
        "X-Forwarded-Host": "demo.example.com",
        "Sec-Fetch-Site": "same-origin",
      },
    });
    expect(same.status).toBe(201);
  });
});
