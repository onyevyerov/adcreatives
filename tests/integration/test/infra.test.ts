import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { findRepoRoot } from "@adc/shared";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/** Статичні перевірки інфраструктури (сам `docker compose up` — у ручній верифікації, див. README). */
const root = findRepoRoot();
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

interface ComposeService {
  build?: { context: string; dockerfile: string };
  image?: string;
  command?: string[];
  environment?: Record<string, string>;
  volumes?: string[];
  ports?: string[];
  depends_on?: Record<string, { condition: string }>;
  shm_size?: string;
}
interface ComposeFile {
  services: Record<string, ComposeService>;
  volumes?: Record<string, unknown>;
}

describe("Dockerfile", () => {
  const dockerfile = read("docker/Dockerfile");

  it("версія Playwright у Dockerfile збігається з тією, що стоїть у краулера", () => {
    const req = createRequire(path.join(root, "packages", "crawler", "package.json"));
    const installed = (req("playwright/package.json") as { version: string }).version;
    expect(dockerfile).toContain(`ARG PLAYWRIGHT_VERSION=${installed}`);
  });

  it("pnpm — та сама версія, що в packageManager", () => {
    const pm = (JSON.parse(read("package.json")) as { packageManager: string }).packageManager;
    expect(dockerfile).toContain(`corepack prepare ${pm} --activate`);
  });

  it("залежності ставляться всередині Linux з lockfile; браузер Remotion — через env", () => {
    expect(dockerfile).toMatch(/pnpm install --offline --frozen-lockfile/);
    expect(dockerfile).toContain("remotion browser ensure");
    expect(dockerfile).toMatch(
      /ENV REMOTION_BROWSER_EXECUTABLE=\/app\/packages\/render\/node_modules\/\.remotion\//,
    );
  });

  it("ігнор-файл не пускає в образ node_modules з Windows і секрети", () => {
    const ignore = read("docker/Dockerfile.dockerignore").split(/\r?\n/);
    for (const entry of ["**/node_modules", ".env", ".data", "eval/runs", ".git"])
      expect(ignore).toContain(entry);
  });
});

describe("docker-compose.yml", () => {
  // merge: true — розгортає `<<: *app` (YAML 1.1 merge keys, як у docker compose).
  const compose = parse(read("docker-compose.yml"), { merge: true }) as ComposeFile;

  it("api + worker + redis; Redis з AOF і томом", () => {
    expect(Object.keys(compose.services).sort()).toEqual(["api", "redis", "worker"]);
    const redis = compose.services.redis as ComposeService;
    expect(redis.command).toEqual(expect.arrayContaining(["--appendonly", "yes"]));
    expect(redis.volumes).toContain("redis-data:/data");
    expect(Object.keys(compose.volumes ?? {})).toEqual(expect.arrayContaining(["data", "redis-data"]));
  });

  it("api і worker — один образ, спільний том DATA_DIR, Redis з мережі compose", () => {
    for (const name of ["api", "worker"]) {
      const svc = compose.services[name] as ComposeService;
      expect(svc.build?.dockerfile).toBe("docker/Dockerfile");
      expect(svc.volumes).toContain("data:/data");
      expect(svc.environment).toMatchObject({ REDIS_URL: "redis://redis:6379/0", DATA_DIR: "/data" });
      expect(svc.depends_on?.redis?.condition).toBe("service_healthy");
    }
    expect(compose.services.api?.command).toEqual(["/app/node_modules/.bin/tsx", "apps/api/src/server.ts"]);
    expect(compose.services.worker?.command).toEqual([
      "/app/node_modules/.bin/tsx",
      "apps/worker/src/main.ts",
    ]);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: це інтерполяція docker compose, не шаблон JS
    expect(compose.services.api?.ports).toEqual(["${PORT:-3000}:3000"]);
    expect(compose.services.worker?.shm_size).toBe("1gb");
  });
});

describe("docker-compose.server.yml + Caddyfile", () => {
  it("Caddy з HTTPS для APP_DOMAIN; пароль на сервері обов'язковий", () => {
    const server = read("docker-compose.server.yml");
    expect(server).toMatch(/APP_DOMAIN: \$\{APP_DOMAIN:\?/);
    expect(server).toMatch(/APP_PASSWORD: \$\{APP_PASSWORD:\?/);
    expect(server).toMatch(/"443:443"/);
    const caddy = read("docker/Caddyfile");
    expect(caddy).toMatch(/^\{\$APP_DOMAIN\} \{/m);
    expect(caddy).toMatch(/reverse_proxy api:3000/);
    expect(caddy).toMatch(/flush_interval -1/); // SSE без буферизації
  });
});
