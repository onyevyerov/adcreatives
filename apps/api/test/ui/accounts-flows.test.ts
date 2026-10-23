// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableCSSFileLoading":true,"handleDisabledFileLoadingAsSuccess":true}}
/**
 * B13 · Наскрізні сценарії F1–F5 (Референс `#F`): справжній index.html +
 * app.js + ядро акаунта + view блоків; бекенд — in-memory стаб `fetch` за контрактом API акаунтів
 * (`docs/accounts-api.md`), потік проєкту — фейковий
 * EventSource з подіями фікстури «Зерно» (dev/fixture-events.js). Кроки — кліками й введенням у DOM,
 * за видимими текстами кадрів, а не через `actions`.
 *
 * «Браузер» — банка cookie (`jar`): посилання з листа відкривається «в новій вкладці» — новий
 * boot з тією самою банкою й localStorage, але порожнім sessionStorage; «інший браузер» — інша банка.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { t } from "@adc/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredEvent } from "../../public/static/dev/fixture-events.js";
import { eventsOf, PATHS, segments } from "../../public/static/dev/fixture-events.js";
import { CREDITS_PER_USD, CUSTOM, PACKAGES, PRICES } from "../../public/static/dev/fixtures/_base.js";
import { boot } from "../../public/static/js/app.js";
import type {
  ChatEvent,
  LedgerEntry,
  OutboxMail,
  ProjectRow,
  TopUp,
  UiState,
} from "../../public/static/js/contracts.js";
import { createAccountActions } from "../../public/static/js/data/account.js";
import { PENDING_KEY } from "../../public/static/js/lib/pending.js";
import { DEFAULT_PUBLIC_DIR } from "../../src/config.ts";

type App = Awaited<ReturnType<typeof boot>>;
type Format = ProjectRow["formats"][number];
type CreditKind = NonNullable<ProjectRow["credits"]>["parts"][number]["kind"];
type Json = Record<string, unknown>;

const APP_URL = "http://localhost:3113";
const ADMIN_EMAIL = "admin@example.com";
const NBSP = " ";

// ═════════════════════════════ стаб бекенду ═════════════════════════════

type User = {
  id: string;
  email: string;
  name: string;
  password: string;
  activatedAt: string | null;
  createdAt: string;
};

type Project = {
  id: string;
  ownerId: string;
  createdAt: string;
  url: string | null;
  formats: Format[];
  events: StoredEvent[];
  totalUsd: number;
};

/** Банка cookie одного «браузера»: токен сесії `adc_session` або нічого. */
type Jar = { token: string | null };

type Reply = { status: number; body: unknown };

const ok = (body: unknown, status = 200): Reply => ({ status, body });
const fail = (status: number, error: string, message: string, extra: Json = {}): Reply => ({
  status,
  body: { error, message, ...extra },
});

/** Фейковий EventSource: підписка на потік проєкту стаба. */
class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  /** Сервер, до якого підключаються нові потоки (ставить `createServer`). */
  static server: FakeServer | null = null;

  readyState = FakeEventSource.CONNECTING;
  onopen: ((ev: Event) => unknown) | null = null;
  onerror: ((ev: Event) => unknown) | null = null;
  readonly projectId: string;
  readonly lastEventId: string | null;
  private readonly listeners = new Map<string, ((ev: MessageEvent) => void)[]>();

  constructor(readonly url: string) {
    const u = new URL(url, APP_URL);
    const m = /^\/api\/projects\/([^/]+)\/events$/.exec(u.pathname);
    this.projectId = decodeURIComponent(m?.[1] ?? "");
    this.lastEventId = u.searchParams.get("lastEventId");
    const server = FakeEventSource.server;
    queueMicrotask(() => {
      if (this.readyState === FakeEventSource.CLOSED) return;
      if (!server?.canStream(this.projectId)) {
        this.readyState = FakeEventSource.CLOSED;
        this.onerror?.(new Event("error"));
        return;
      }
      this.readyState = FakeEventSource.OPEN;
      this.onopen?.(new Event("open"));
      server.attach(this);
    });
  }

  addEventListener(type: string, fn: (ev: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }

  close() {
    this.readyState = FakeEventSource.CLOSED;
    FakeEventSource.server?.detach(this);
  }

  /** Доставка події стріму (як SSE: `id` + `data`). */
  deliver({ id, event }: StoredEvent) {
    if (this.readyState !== FakeEventSource.OPEN) return;
    const ev = { data: JSON.stringify(event), lastEventId: id } as MessageEvent;
    for (const fn of this.listeners.get(event.type) ?? []) fn(ev);
  }
}

/**
 * In-memory бекенд за контрактом розділу 10: auth, account, billing, projects (+ події), admin.
 * Ціни й пакети — як `config/credits.json` (= `_base.js`); `signupBonus` 0; адмін — `ADMIN_EMAIL`.
 * Оркестратор спрощено до білінгу (B4 бекенду): старт −10; ЧП3 з N форматами — −2·(N−1) за ще не
 * оплачені; правка після видачі −3; відмови й списання — повідомлення `assistant` текстами `uk.ts`.
 */
class FakeServer {
  readonly users = new Map<string, User>();
  readonly ledger = new Map<string, LedgerEntry[]>(); // userId → записи, старіші першими
  readonly sessions = new Map<string, string>(); // token → userId
  readonly tokens = new Map<string, { kind: "activate" | "reset"; userId: string }>();
  readonly outbox: OutboxMail[] = []; // новіші першими
  readonly topups = new Map<string, TopUp>();
  readonly projects = new Map<string, Project>();
  /** Журнал запитів `METHOD path` — для перевірок «без запиту». */
  readonly log: string[] = [];
  /** Банка поточного «браузера»; міняє `useJar`. */
  jar: Jar = { token: null };
  private readonly streams = new Set<FakeEventSource>();
  private seq = 0;
  private eventSeq = Date.now();

  private nextId(prefix: string) {
    this.seq++;
    return `${prefix}${String(this.seq).padStart(8, "0")}`;
  }

  private now() {
    return new Date().toISOString();
  }

  // ───── дані для сценаріїв ─────

  /** Активований користувач з балансом (adjust від адміна, як ручне коригування). */
  seedUser(o: { email: string; name: string; password: string; balance?: number }): User {
    const user: User = {
      id: this.nextId("u_"),
      email: o.email,
      name: o.name,
      password: o.password,
      activatedAt: this.now(),
      createdAt: this.now(),
    };
    this.users.set(user.id, user);
    if (o.balance) this.apply(user.id, { kind: "adjust", credits: o.balance, note: "Стартовий баланс" });
    return user;
  }

  /** Сесія для користувача в банці (вхід, зроблений раніше). */
  signIn(jar: Jar, userId: string) {
    jar.token = this.nextId("s_");
    this.sessions.set(jar.token, userId);
  }

  /** Проєкт користувача з уже програним шляхом фікстури (без списань — вони в `ledger`). */
  seedProject(ownerId: string, path: keyof typeof PATHS, formats: Format[] = ["vertical"]): Project {
    const project: Project = {
      id: this.nextId("p_"),
      ownerId,
      createdAt: this.now(),
      url: "https://zerno.example.com/",
      formats,
      events: [],
      totalUsd: 0,
    };
    this.projects.set(project.id, project);
    this.apply(ownerId, {
      id: `video:${project.id}`,
      kind: "charge",
      credits: -PRICES.video,
      ref: { projectId: project.id },
      note: "Відео",
    });
    this.emit(
      project,
      eventsOf(PATHS[path]).map((e) => e.event),
    );
    return project;
  }

  balance(userId: string) {
    return (this.ledger.get(userId) ?? []).reduce((sum, e) => sum + e.credits, 0);
  }

  lastMail(to: string, kind: OutboxMail["kind"]) {
    const mail = this.outbox.find((m) => m.to === to && m.kind === kind);
    if (!mail) throw new Error(`немає листа ${kind} для ${to}`);
    return mail;
  }

  // ───── леджер ─────

  private apply(
    userId: string,
    e: { id?: string; kind: LedgerEntry["kind"]; credits: number; ref?: LedgerEntry["ref"]; note?: string },
  ): LedgerEntry | { required: number; available: number } {
    const list = this.ledger.get(userId) ?? [];
    const id = e.id ?? `adjust:${this.nextId("")}`;
    const dup = list.find((x) => x.id === id);
    if (dup) return dup;
    const balance = this.balance(userId);
    if (e.credits < 0 && balance + e.credits < 0) return { required: -e.credits, available: balance };
    const entry: LedgerEntry = {
      id,
      userId,
      at: this.now(),
      kind: e.kind,
      credits: e.credits,
      balanceAfter: balance + e.credits,
      ref: e.ref ?? {},
      note: e.note ?? "",
    };
    this.ledger.set(userId, [...list, entry]);
    return entry;
  }

  // ───── користувачі й сесії ─────

  private isAdmin(u: User) {
    return u.email === ADMIN_EMAIL;
  }

  private publicUser(u: User) {
    return {
      id: u.id,
      email: u.email,
      name: u.name,
      isAdmin: this.isAdmin(u),
      activatedAt: u.activatedAt,
      createdAt: u.createdAt,
    };
  }

  private current(): User | null {
    const id = this.jar.token ? this.sessions.get(this.jar.token) : undefined;
    return (id && this.users.get(id)) || null;
  }

  private findByEmail(email: string) {
    const e = email.trim().toLowerCase();
    return [...this.users.values()].find((u) => u.email === e) ?? null;
  }

  private signedIn(u: User): Reply {
    this.signIn(this.jar, u.id);
    return ok({ user: this.publicUser(u), balance: this.balance(u.id) });
  }

  private mail(kind: "activate" | "reset", u: User) {
    const token = this.nextId("tok_");
    this.tokens.set(token, { kind, userId: u.id });
    const link = `${APP_URL}/?auth=${kind}&token=${encodeURIComponent(token)}`;
    this.outbox.unshift({
      id: this.nextId("m_"),
      at: this.now(),
      to: u.email,
      kind,
      subject: kind === "activate" ? "Активація акаунта Crealab" : "Скидання пароля Crealab",
      text: `Вітаємо, ${u.name}!\n\n${link}`,
      link,
    });
  }

  private consume(kind: "activate" | "reset", token: unknown) {
    const rec = typeof token === "string" ? this.tokens.get(token) : undefined;
    if (!rec || rec.kind !== kind) return null;
    this.tokens.delete(String(token));
    return this.users.get(rec.userId) ?? null;
  }

  private destroyAll(userId: string) {
    for (const [token, id] of this.sessions) if (id === userId) this.sessions.delete(token);
  }

  // ───── проєкти й потік ─────

  canStream(projectId: string) {
    const p = this.projects.get(projectId);
    const u = this.current();
    return Boolean(p && u && (p.ownerId === u.id || this.isAdmin(u)));
  }

  attach(es: FakeEventSource) {
    this.streams.add(es);
    const p = this.projects.get(es.projectId);
    const after = es.lastEventId;
    for (const e of p?.events ?? []) if (!after || e.id > after) es.deliver(e);
  }

  detach(es: FakeEventSource) {
    this.streams.delete(es);
  }

  /** Дописує події в стрім проєкту (свіжі `id` і `at`) і доставляє відкритим потокам. */
  emit(p: Project, events: ChatEvent[]) {
    for (const event of events) {
      const stored: StoredEvent = {
        id: `${++this.eventSeq}-0`,
        event: { ...event, at: this.now() } as ChatEvent,
      };
      p.events.push(stored);
      if (event.type === "cost") p.totalUsd = event.totalUsd;
      for (const es of this.streams) if (es.projectId === p.id) queueMicrotask(() => es.deliver(stored));
    }
  }

  private say(p: Project, text: string) {
    this.emit(p, [{ type: "message", role: "assistant", text, at: this.now() } as ChatEvent]);
  }

  private status(p: Project) {
    const last = [...p.events].reverse().find((e) => e.event.type === "state")?.event;
    return last?.type === "state"
      ? { status: last.status, rev: last.rev }
      : { status: "intake" as const, rev: 1 };
  }

  private credits(p: Project): NonNullable<ProjectRow["credits"]> {
    const parts = (this.ledger.get(p.ownerId) ?? [])
      .filter((e) => e.ref.projectId === p.id)
      .map((e) => {
        const kind: CreditKind = e.kind === "refund" ? "refund" : (e.id.split(":")[0] as CreditKind);
        return {
          kind,
          credits: e.credits,
          ...(e.ref.format ? { format: e.ref.format } : {}),
          ...(e.ref.rev ? { rev: e.ref.rev } : {}),
        };
      });
    const charged = -parts.filter((x) => x.kind !== "refund").reduce((s, x) => s + x.credits, 0);
    const refunded = parts.filter((x) => x.kind === "refund").reduce((s, x) => s + x.credits, 0);
    return { charged, refunded, parts };
  }

  private row(p: Project): ProjectRow {
    return {
      id: p.id,
      ownerId: p.ownerId,
      createdAt: p.createdAt,
      status: this.status(p).status,
      site: p.url,
      formats: p.formats,
      totalUsd: p.totalUsd,
      chatUrl: `/?project=${p.id}`,
      credits: this.credits(p),
    };
  }

  /** Повідомлення клієнта: ехо + реакція оркестратора (формати; правка після видачі з білінгом). */
  private onMessage(p: Project, text: string) {
    this.emit(p, [{ type: "message", role: "user", text, at: this.now() } as ChatEvent]);
    const formats = /^Формати: (.+)$/.exec(text);
    if (formats) {
      const byLabel: Record<string, Format> = { "9:16": "vertical", "1:1": "square", "16:9": "landscape" };
      p.formats = (formats[1] ?? "").split(", ").flatMap((l) => (byLabel[l] ? [byLabel[l]] : []));
      this.say(p, `Записав: формати — ${formats[1]}.`);
      return;
    }
    const { status, rev } = this.status(p);
    if (status !== "delivered") {
      this.say(p, `Записав: ${text}`);
      return;
    }
    const next = rev + 1;
    const charge = this.apply(p.ownerId, {
      id: `revision:${p.id}:r${next}`,
      kind: "charge",
      credits: -PRICES.revision,
      ref: { projectId: p.id, rev: next },
      note: "Правка",
    });
    if ("required" in charge) {
      this.say(p, t("insufficientCredits", { need: charge.required, have: charge.available }));
      return;
    }
    this.say(p, t("chargedRevision", { credits: PRICES.revision, balance: charge.balanceAfter }));
    // Сегмент ревізії без власного повідомлення клієнта (ехо вже є).
    this.emit(
      p,
      segments.revisionAfterDelivery.slice(1).map((e) => e.event),
    );
  }

  private onApprove(p: Project) {
    const { status, rev } = this.status(p);
    if (status === "awaiting_brand")
      return this.emit(
        p,
        segments.toScript.map((e) => e.event),
      );
    if (status === "awaiting_script")
      return this.emit(
        p,
        segments.toStoryboard.map((e) => e.event),
      );
    if (status !== "awaiting_storyboard") return;
    // Доплата за формати — лише до першої видачі (`chargeExtraFormats` оркестратора).
    const delivered = p.events.some((e) => e.event.type === "state" && e.event.status === "delivered");
    const paid = new Set(
      (this.ledger.get(p.ownerId) ?? [])
        .filter((e) => e.ref.projectId === p.id && e.ref.format)
        .map((e) => e.ref.format),
    );
    const extra = delivered ? [] : p.formats.slice(1).filter((f) => !paid.has(f));
    const need = extra.length * PRICES.extraFormat;
    const have = this.balance(p.ownerId);
    if (need > have) {
      this.say(p, t("insufficientCreditsFormats", { need, have }));
      return;
    }
    let last: LedgerEntry | null = null;
    for (const format of extra) {
      const e = this.apply(p.ownerId, {
        id: `format:${p.id}:${format}`,
        kind: "charge",
        credits: -PRICES.extraFormat,
        ref: { projectId: p.id, format },
        note: `Додатковий формат`,
      });
      if (!("required" in e)) last = e;
    }
    if (last)
      this.say(p, t("chargedFormats", { credits: need, count: extra.length, balance: last.balanceAfter }));
    this.emit(
      p,
      (rev > 1 ? segments.revisionDelivered : segments.toDelivered).map((e) => e.event),
    );
  }

  // ───── маршрутизатор ─────

  handle(method: string, url: URL, body: unknown, form: FormData | null): Reply {
    const p = url.pathname;
    this.log.push(`${method} ${p}${url.search}`);
    const b = (body ?? {}) as Json;
    const str = (k: string) => (typeof b[k] === "string" ? (b[k] as string) : "");
    const me = this.current();
    const anon = () => fail(401, "unauthorized", "Потрібно увійти.");
    const notFound = () => fail(404, "not_found", "Не знайдено.");
    const weak = (pw: string) => pw.length < 8 || pw.length > 128;

    // ── /api/auth ──
    if (p === "/api/auth/me" && method === "GET") {
      if (!me) return anon();
      return ok({
        user: this.publicUser(me),
        balance: this.balance(me.id),
        prices: PRICES,
        packages: PACKAGES,
        custom: CUSTOM,
        creditsPerUsd: CREDITS_PER_USD,
      });
    }
    if (p === "/api/auth/register" && method === "POST") {
      if (weak(str("password"))) return fail(400, "weak_password", "Пароль — від 8 до 128 символів.");
      let u = this.findByEmail(str("email"));
      if (!u) {
        u = {
          id: this.nextId("u_"),
          email: str("email").trim().toLowerCase(),
          name: str("name").trim(),
          password: str("password"),
          activatedAt: null,
          createdAt: this.now(),
        };
        this.users.set(u.id, u);
      }
      if (u.activatedAt === null) this.mail("activate", u);
      return ok({ message: "Якщо адреса вільна, ми надіслали лист для активації." }, 202);
    }
    if (p === "/api/auth/activate" && method === "POST") {
      const u = this.consume("activate", b.token);
      if (!u) return fail(400, "invalid_token", "Посилання недійсне або застаріло.");
      u.activatedAt ??= this.now();
      return this.signedIn(u);
    }
    if (p === "/api/auth/resend" && method === "POST") {
      const u = this.findByEmail(str("email"));
      if (u && u.activatedAt === null) this.mail("activate", u);
      return ok({ message: "Якщо акаунт очікує активації, ми надіслали лист ще раз." }, 202);
    }
    if (p === "/api/auth/login" && method === "POST") {
      const u = this.findByEmail(str("email"));
      if (!u || u.password !== str("password"))
        return fail(401, "invalid_credentials", "Невірний e-mail або пароль.");
      if (u.activatedAt === null)
        return fail(403, "not_activated", "Акаунт ще не активовано — перевірте пошту.");
      return this.signedIn(u);
    }
    if (p === "/api/auth/logout" && method === "POST") {
      if (this.jar.token) this.sessions.delete(this.jar.token);
      this.jar.token = null;
      return ok(null, 204);
    }
    if (p === "/api/auth/forgot" && method === "POST") {
      const u = this.findByEmail(str("email"));
      if (u && u.activatedAt !== null) this.mail("reset", u);
      return ok({ message: "Якщо акаунт існує, ми надіслали лист для скидання пароля." }, 202);
    }
    if (p === "/api/auth/reset" && method === "POST") {
      if (weak(str("password"))) return fail(400, "weak_password", "Пароль — від 8 до 128 символів.");
      const u = this.consume("reset", b.token);
      if (!u) return fail(400, "invalid_token", "Посилання недійсне або застаріло.");
      u.password = str("password");
      this.destroyAll(u.id);
      return this.signedIn(u);
    }
    if (p === "/api/auth/google" && method === "POST")
      return fail(501, "not_implemented", "Вхід через Google ще не підключено.");

    // ── /api/billing/packages — публічний ──
    if (p === "/api/billing/packages" && method === "GET")
      return ok({ creditsPerUsd: CREDITS_PER_USD, prices: PRICES, packages: PACKAGES, custom: CUSTOM });

    if (!me) return anon();

    // ── /api/account ──
    if (p === "/api/account" && method === "GET")
      return ok({ user: this.publicUser(me), balance: this.balance(me.id) });
    if (p === "/api/account" && method === "PATCH") {
      me.name = str("name").trim();
      return ok({ user: this.publicUser(me) });
    }
    if (p === "/api/account/password" && method === "POST") {
      if (me.password !== str("current"))
        return fail(401, "invalid_credentials", "Невірний поточний пароль.");
      if (weak(str("next"))) return fail(400, "weak_password", "Пароль — від 8 до 128 символів.");
      me.password = str("next");
      this.destroyAll(me.id);
      this.signIn(this.jar, me.id);
      return ok({ ok: true });
    }
    if (p === "/api/account/transactions" && method === "GET") return ok(this.page(me.id, url));

    // ── /api/billing ──
    if (p === "/api/billing/topups" && method === "POST") {
      const pkg = PACKAGES.find((x) => x.id === b.packageId);
      const credits = pkg ? pkg.credits : Number(b.credits);
      if (!pkg && !(Number.isInteger(credits) && credits >= CUSTOM.min && credits <= CUSTOM.max))
        return fail(
          400,
          "invalid_body",
          `Кількість кредитів — ціле число від ${CUSTOM.min} до ${CUSTOM.max}.`,
        );
      const topup: TopUp = {
        id: this.nextId("t_"),
        userId: me.id,
        packageId: pkg?.id ?? "custom",
        credits,
        priceUsd: pkg ? pkg.priceUsd : credits / CREDITS_PER_USD,
        status: "pending",
        createdAt: this.now(),
        paidAt: null,
      };
      this.topups.set(topup.id, topup);
      return ok({ topup, checkoutUrl: `${APP_URL}/?checkout=${topup.id}` }, 201);
    }
    if (p === "/api/billing/topups" && method === "GET")
      return ok({ topups: [...this.topups.values()].filter((x) => x.userId === me.id).reverse() });
    const topupMatch = /^\/api\/billing\/topups\/([^/]+)(\/confirm)?$/.exec(p);
    if (topupMatch) {
      const topup = this.topups.get(decodeURIComponent(topupMatch[1] ?? ""));
      if (!topup || topup.userId !== me.id) return fail(404, "not_found", "Поповнення не знайдено.");
      if (!topupMatch[2] && method === "GET") return ok({ topup });
      if (topupMatch[2] && method === "POST") {
        if (topup.status === "pending") {
          topup.status = b.outcome === "paid" ? "paid" : "failed";
          topup.paidAt = topup.status === "paid" ? this.now() : null;
          if (topup.status === "paid")
            this.apply(me.id, {
              id: `topup:${topup.id}`,
              kind: "topup",
              credits: topup.credits,
              ref: { topupId: topup.id },
              note: "Поповнення",
            });
        }
        return ok({ topup, balance: this.balance(me.id) });
      }
    }

    // ── /api/projects ──
    if (p === "/api/projects" && method === "GET") {
      const all = url.searchParams.get("all") === "1" && this.isAdmin(me);
      const rows = [...this.projects.values()].filter((x) => all || x.ownerId === me.id).reverse();
      return ok({ projects: rows.map((x) => this.row(x)) });
    }
    if (p === "/api/projects" && method === "POST") {
      const balance = this.balance(me.id);
      if (balance < PRICES.video)
        return fail(402, "insufficient_credits", "Не вистачає кредитів.", {
          required: PRICES.video,
          available: balance,
        });
      const site = form?.get("url");
      const project: Project = {
        id: this.nextId("p_"),
        ownerId: me.id,
        createdAt: this.now(),
        url: typeof site === "string" && site ? site : null,
        formats: ["vertical"],
        events: [],
        totalUsd: 0,
      };
      this.projects.set(project.id, project);
      this.apply(me.id, {
        id: `video:${project.id}`,
        kind: "charge",
        credits: -PRICES.video,
        ref: { projectId: project.id },
        note: "Відео",
      });
      // Сканування; решта сегмента `toBrand` — коли знадобиться сценарію.
      this.emit(
        project,
        segments.toBrand.slice(0, 4).map((e) => e.event),
      );
      return ok({ id: project.id, chatUrl: `/?project=${project.id}`, balance: this.balance(me.id) }, 201);
    }
    const projectMatch = /^\/api\/projects\/([^/]+)(\/messages|\/commands|\/uploads)?$/.exec(p);
    if (projectMatch) {
      const project = this.projects.get(decodeURIComponent(projectMatch[1] ?? ""));
      if (!project || (project.ownerId !== me.id && !this.isAdmin(me))) return notFound();
      const action = projectMatch[2];
      if (!action && method === "GET") {
        const { status, rev } = this.status(project);
        return ok({
          id: project.id,
          status,
          project: { rev, input: { url: project.url } },
          intake: null,
          totalUsd: project.totalUsd,
          credits: this.credits(project),
        });
      }
      if (action === "/messages" && method === "POST") {
        this.onMessage(project, str("text"));
        return ok({ commandId: this.nextId("c_"), messageId: this.nextId("msg_"), eventId: "0-0" }, 202);
      }
      if (action === "/commands" && method === "POST") {
        if (b.type === "approve") {
          // ЧП1: вибір форматів приходить разом з approve (`choices`), а не окремим повідомленням.
          const choices = b.choices as { formats?: Format[] } | undefined;
          if (choices?.formats) project.formats = choices.formats;
          this.onApprove(project);
        }
        return ok({ commandId: this.nextId("c_") }, 202);
      }
    }

    // ── /api/admin ──
    if (p.startsWith("/api/admin/")) {
      if (!this.isAdmin(me)) return fail(403, "forbidden", "Лише для адміністратора.");
      if (p === "/api/admin/users" && method === "GET")
        return ok({
          users: [...this.users.values()].map((u) => ({
            ...this.publicUser(u),
            balance: this.balance(u.id),
          })),
        });
      if (p === "/api/admin/outbox" && method === "GET") return ok({ mails: this.outbox });
      const userMatch = /^\/api\/admin\/users\/([^/]+)(\/credits|\/transactions)?$/.exec(p);
      const user = userMatch ? this.users.get(decodeURIComponent(userMatch[1] ?? "")) : undefined;
      if (userMatch && !user) return fail(404, "not_found", "Користувача не знайдено.");
      if (user && !userMatch?.[2] && method === "GET")
        return ok({ user: this.publicUser(user), balance: this.balance(user.id) });
      if (user && userMatch?.[2] === "/transactions" && method === "GET") return ok(this.page(user.id, url));
      if (user && userMatch?.[2] === "/credits" && method === "POST") {
        const credits = Number(b.credits);
        if (!Number.isInteger(credits) || credits === 0 || str("note").length > 200)
          return fail(400, "invalid_body", "credits — ціле число ≠ 0; note — до 200 символів.");
        const entry = this.apply(user.id, {
          kind: "adjust",
          credits,
          ref: { byUserId: me.id },
          note: str("note"),
        });
        if ("required" in entry)
          return fail(
            402,
            "insufficient_credits",
            `Баланс не може стати від'ємним: списання ${entry.required}, на балансі ${entry.available}.`,
            entry,
          );
        return ok({ entry, balance: this.balance(user.id) });
      }
    }

    return notFound();
  }

  /** Сторінка леджера, новіші першими (`?limit&before`). */
  private page(userId: string, url: URL) {
    const all = [...(this.ledger.get(userId) ?? [])].reverse();
    const limit = Number(url.searchParams.get("limit")) || 50;
    const before = url.searchParams.get("before");
    const from = before ? all.findIndex((e) => e.id === before) + 1 : 0;
    const entries = all.slice(from, from + limit);
    const more = from + limit < all.length;
    return { entries, nextBefore: more ? (entries.at(-1)?.id ?? null) : null };
  }
}

/** `fetch` поверх стаба: JSON або multipart, відповідь — справжній `Response`. */
function fetchFor(server: FakeServer) {
  return vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input), APP_URL);
    const method = (init.method ?? "GET").toUpperCase();
    const raw = init.body;
    const form = raw instanceof FormData ? raw : null;
    let body: unknown = null;
    if (typeof raw === "string" && raw) body = JSON.parse(raw);
    const reply = server.handle(method, url, body, form);
    if (reply.status === 204) return new Response(null, { status: 204 });
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { "Content-Type": "application/json" },
    });
  });
}

// ═════════════════════════════ хелпери сторінки ═════════════════════════════

/** Розмітка <body> справжнього index.html (у тесті innerHTML дозволено; у public — ні). */
function mountIndexHtml() {
  const html = readFileSync(path.join(DEFAULT_PUBLIC_DIR, "index.html"), "utf8");
  const body = /<body>([\s\S]*)<\/body>/.exec(html)?.[1];
  if (!body) throw new Error("index.html без <body>");
  document.body.innerHTML = body;
}

let server: FakeServer;
let app: App | null = null;
const errors = vi.spyOn(console, "error");

/** Відкриває сторінку за адресою в поточному «браузері» (`server.jar`). */
async function open(url: string): Promise<App> {
  app?.destroy();
  document.body.textContent = "";
  mountIndexHtml();
  history.replaceState(null, "", url);
  const params = new URLSearchParams(location.search);
  app = await boot({
    params,
    actions: (store) =>
      createAccountActions(store, { params, EventSource: FakeEventSource as never, batchMs: 0 }),
  });
  await settle();
  return app;
}

/** Посилання з листа «в новій вкладці»: та сама банка й localStorage, порожній sessionStorage. */
async function openInNewTab(link: string) {
  sessionStorage.clear();
  const u = new URL(link);
  return open(`${u.pathname}${u.search}`);
}

const state = (): UiState => {
  if (!app) throw new Error("сторінку не відкрито");
  return app.store.getState();
};

/** Мікрозадачі й нульові таймери (fetch стаба, рендер). */
async function settle(ms = 0) {
  await vi.advanceTimersByTimeAsync(ms);
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

/** Крутить фейкові таймери, доки `pred` не стане істинним. */
async function until(pred: (s: UiState) => boolean, label: string, maxMs = 60_000) {
  for (let t = 0; t <= maxMs; t += 50) {
    if (pred(state())) return;
    await settle(50);
  }
  const s = state();
  throw new Error(
    `не дочекались «${label}»: route=${s.route} status=${s.status} me=${s.account.meStatus} auth=${s.auth?.view ?? null}`,
  );
}

/** Елемент видимий: немає `hidden` у предків (CSS у happy-dom вимкнено). */
function visible(el: Element): boolean {
  for (let n: Element | null = el; n; n = n.parentElement) if ((n as HTMLElement).hidden) return false;
  return true;
}

const textOf = (el: Element | null) =>
  (el?.textContent ?? "").replaceAll(NBSP, " ").replace(/\s+/g, " ").trim();

/** Видимий текст області (U+00A0 → пробіл). */
const screenText = (selector = "#app") => textOf(document.querySelector(selector));

/** Видима активна кнопка або посилання, чий текст містить `label`. */
function control(label: string | RegExp, scope = "#app"): HTMLElement {
  const root = document.querySelector(scope);
  if (!root) throw new Error(`немає ${scope}`);
  const all = [...root.querySelectorAll<HTMLElement>("button, a, [role='button'], [role='menuitem']")].filter(
    visible,
  );
  const match = all.filter((el) =>
    typeof label === "string" ? textOf(el).includes(label) : label.test(textOf(el)),
  );
  const found = match.find((el) => !(el as HTMLButtonElement).disabled) ?? match[0];
  if (!found)
    throw new Error(`немає кнопки «${label}» у ${scope}: ${all.map((el) => `«${textOf(el)}»`).join(", ")}`);
  return found;
}

/** Клік по видимій кнопці за текстом; вона має бути активною. */
async function click(label: string | RegExp, scope = "#app") {
  const el = control(label, scope);
  expect((el as HTMLButtonElement).disabled ?? false, `«${label}» disabled`).toBe(false);
  el.click();
  await settle();
}

/**
 * Поле у видимій області за `name`, `autocomplete`, `type`, `aria-label`, `placeholder` або текстом
 * `<label>`; введення як від користувача.
 */
async function fill(field: string, value: string, scope = "#app") {
  const root = document.querySelector(scope);
  const byAttr = [
    ...(root?.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
      `[name="${field}"], [autocomplete="${field}"], input[type="${field}"], [aria-label="${field}"], [placeholder="${field}"]`,
    ) ?? []),
  ];
  const byLabel = [...(root?.querySelectorAll("label") ?? [])]
    .filter((l) => textOf(l).startsWith(field))
    .map((l) => l.control ?? l.querySelector<HTMLInputElement | HTMLTextAreaElement>("input, textarea"));
  const el = [...byAttr, ...byLabel].find(
    (x): x is HTMLInputElement | HTMLTextAreaElement => x instanceof HTMLElement && visible(x),
  );
  if (!el) throw new Error(`немає поля ${field} у ${scope}`);
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  await settle();
}

/** Надсилання видимої форми, що містить елемент `selector`. */
async function submit(selector: string) {
  const el = [...document.querySelectorAll(selector)].find(visible);
  const form = el?.closest("form") ?? (el instanceof HTMLFormElement ? el : null);
  if (!form) throw new Error(`немає форми для ${selector}`);
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await settle();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  server = new FakeServer();
  FakeEventSource.server = server;
  vi.stubGlobal("fetch", fetchFor(server));
  vi.stubGlobal("EventSource", FakeEventSource);
  history.replaceState(null, "", "/");
});

afterEach(() => {
  app?.destroy();
  app = null;
  FakeEventSource.server = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.textContent = "";
  localStorage.clear();
  sessionStorage.clear();
  errors.mockClear();
});

// ═════════════════════════════ стаб і каркас ═════════════════════════════

describe("стаб бекенду і boot", () => {
  it("гість на старті: me 401 → anon, ціни з публічного packages, «Увійти» в шапці", async () => {
    await open("/");
    await until((s) => s.account.meStatus === "anon" && s.account.prices !== null, "гість із цінами");
    expect(state().account.prices).toEqual(PRICES);
    expect(server.log).toContain("GET /api/auth/me");
    expect(server.log).toContain("GET /api/billing/packages");
    expect($("#app").dataset.route).toBe("start");
    expect(control("Увійти", "#start")).toBeTruthy();
    expect(errors).not.toHaveBeenCalled();
  });

  it("користувач у проєкті: me ready, потік фікстури доходить до ЧП1 через фейковий EventSource", async () => {
    const olena = server.seedUser({
      email: "olena@example.com",
      name: "Олена Коваль",
      password: "kava-2026!",
      balance: 20,
    });
    server.signIn(server.jar, olena.id);
    const p = server.seedProject(olena.id, "brand");
    await open(`/?project=${p.id}`);
    await until((s) => s.account.meStatus === "ready" && s.status === "awaiting_brand", "ЧП1");
    expect(state().account.me?.balance).toBe(10);
    expect(state().projectCredits).toMatchObject({ charged: 10, refunded: 0 });
    expect($("#app").dataset.route).toBe("project");
    expect(screenText("#chat")).toContain("Чекпоінт 1");
    expect(errors).not.toHaveBeenCalled();
  });
});

function $<T extends Element = HTMLElement>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`немає ${selector}`);
  return el;
}

// ═════════════════════════════ F1–F5 ═════════════════════════════
// Кроки — кадри Референсу `#F` (номер і id кадру в коментарі), перевірки — §10 ТЗ.

describe("F1 · Перший ролик з нуля (гість → реєстрація → лист → оплата → автостарт)", () => {
  it("n3-guest → n1-register-filled → n2-check → n2-activated → f1-topup → f1-pay → f1-paid → n3-auto → ws-crawl", async () => {
    // 01 · n3-guest — гість вводить адресу і тисне «Почати».
    await open("/");
    await until((s) => s.account.meStatus === "anon", "гість");
    await fill("url", "zerno.example.com", "#start");
    await submit('#start input[name="url"]');
    // Запиту на створення немає: pending у localStorage, модалка реєстрації.
    expect(server.log.some((l) => l.startsWith("POST /api/projects"))).toBe(false);
    expect(JSON.parse(localStorage.getItem(PENDING_KEY) ?? "null")).toMatchObject({
      url: "zerno.example.com",
    });
    await until((s) => s.auth?.view === "register" && s.auth.context === "start", "модалка register");

    // 02 · n1-register-filled — ім'я, e-mail, пароль → «Створити акаунт».
    await fill("name", "Олена Коваль", "#overlay");
    await fill("email", "olena@example.com", "#overlay");
    await fill("new-password", "kava-2026!", "#overlay");
    await click("Створити акаунт", "#overlay");

    // 03 · n2-check — «Перевірте пошту», кулдаун «Надіслати ще раз · 0:…».
    await until((s) => s.auth?.view === "check", "перевірте пошту");
    expect(screenText("#overlay")).toContain("Перевірте пошту");
    expect(screenText("#overlay")).toContain("olena@example.com");

    // 04 · n2-activated — посилання з листа в новій вкладці: «Акаунт активовано», баланс 0,
    // картка нестачі на ролик і «Поповнити».
    const link = server.lastMail("olena@example.com", "activate").link;
    await openInNewTab(link);
    expect(location.search).not.toContain("token="); // токен прибрано з адреси
    await until((s) => s.auth?.view === "activated", "активовано");
    expect(state().account.me?.balance).toBe(0);
    expect(screenText("#overlay")).toContain("Акаунт активовано");
    await click("Поповнити", "#overlay");

    // 05 · f1-topup — кабінет · баланс, банер «Після оплати поверну до старту», вибір «Кілька роликів».
    await until(
      (s) => s.route === "cabinet" && s.cabinet.section === "balance" && s.auth === null,
      "кабінет",
    );
    expect(state().cabinet.backTo).toEqual({ kind: "start" });
    await click("Кілька роликів", "#cabinet");
    await click(/^Поповнити/, "#cab-main");

    // 06 · f1-pay — тестова оплата: «Оплатити».
    await until((s) => s.route === "checkout" && s.checkout?.status === "pending", "чек");
    expect(screenText("#checkout")).toContain("Кілька роликів");
    await click("Оплатити", "#checkout");

    // 07 · f1-paid — «Зараховано», «Повертаю на старт…», через 1.4 с — старт.
    await until((s) => s.checkout?.status === "paid", "зараховано");
    expect(state().account.me?.balance).toBe(25);
    expect(screenText("#checkout")).toContain("Зараховано");

    // 08 · n3-auto — автостарт: «Починаю ролик…» · −10, залишок 15.
    await until((s) => s.route === "start" && s.account.autostart !== null, "автостарт");
    expect(state().account.autostart).toMatchObject({
      host: "zerno.example.com",
      charged: 10,
      after: 15,
      photosLost: false,
    });

    // 09 · ws-crawl — робочий простір, сканування, топбар показує 15.
    await until((s) => s.route === "project" && s.status === "crawling", "діалог");
    await until((s) => s.account.me?.balance === 15, "баланс 15");
    expect(screenText("#topbar")).toContain("15");
    expect(localStorage.getItem(PENDING_KEY)).toBeNull();
    expect(errors).not.toHaveBeenCalled();
  });
});

describe("F2 · Нестача на ЧП3 (баланс 1 · 9:16 + 1:1)", () => {
  it("n5-cp1-short → n5-cp3-short → n7-fmt-short → n6-cab-return → n6-pay → n6-retry → n7-fmt", async () => {
    const olena = server.seedUser({
      email: "olena@example.com",
      name: "Олена Коваль",
      password: "kava-2026!",
      balance: 11,
    });
    server.signIn(server.jar, olena.id);
    const p = server.seedProject(olena.id, "brand"); // −10 на старті → баланс 1
    await open(`/?project=${p.id}`);
    await until((s) => s.status === "awaiting_brand" && s.account.me?.balance === 1, "ЧП1, баланс 1");

    // 01 · n5-cp1-short — 9:16 + 1:1: тег ціни на тайлі і рядок «спишу на ЧП3».
    await click("Квадрат", "#stage");
    expect(screenText("#stage")).toContain("+2 за 1:1 спишу на ЧП3");
    // Вибір — чернетка: на сервер нічого не йде, доки не натиснули «Затвердити».
    await settle(1_000);
    expect(server.log).not.toContain(`POST /api/projects/${p.id}/messages`);
    expect(server.projects.get(p.id)?.formats).toEqual(["vertical"]);
    await click(/^Затвердити/, "#stage");
    // «Затвердити» несе формати в `choices` команди approve.
    expect(server.log).toContain(`POST /api/projects/${p.id}/commands`);
    expect(server.projects.get(p.id)?.formats).toEqual(["vertical", "square"]);

    // 02 · n5-cp3-short — ЧП2 → ЧП3: «Затвердити й рендерити · 2 кредити».
    await until((s) => s.status === "awaiting_script", "ЧП2");
    await click(/^Затвердити/, "#stage");
    await until((s) => s.status === "awaiting_storyboard", "ЧП3");
    expect(screenText("#stage")).toMatch(/2 кредити/);
    await click(/Затвердити й рендерити/, "#stage");

    // 03 · n7-fmt-short — відмова в чаті дослівно + K3 «Не вистачає на формати».
    await until(
      (s) =>
        s.feed.some(
          (f) => f.kind === "message" && f.text.startsWith("Не вистачає кредитів на додаткові формати"),
        ),
      "відмова",
    );
    expect(screenText("#chat")).toContain(t("insufficientCreditsFormats", { need: 2, have: 1 }));
    expect(document.querySelector('#chat [role="alert"]')).not.toBeNull();
    await click("Поповнити", "#chat");

    // 04 · n6-cab-return — кабінет з банером повернення до проєкту; пакет, що закриває різницю.
    await until((s) => s.route === "cabinet" && s.cabinet.section === "balance", "кабінет");
    expect(state().cabinet.backTo).toMatchObject({ kind: "project", projectId: p.id, retry: { ctx: "cp3" } });
    await click(/^Поповнити/, "#cab-main");

    // 05 · n6-pay — оплата → «Повернутися до проєкту».
    await until((s) => s.route === "checkout" && s.checkout?.status === "pending", "чек");
    await click("Оплатити", "#checkout");
    await until((s) => s.checkout?.status === "paid", "зараховано");
    await click("Повернутися до проєкту", "#checkout");

    // 06 · n6-retry — картка «Баланс поповнено · +10 · тепер 11» і «Повторити».
    await until(
      (s) => s.route === "project" && s.ui.retry !== null && s.status === "awaiting_storyboard",
      "картка повтору",
    );
    expect(state().ui.retry).toMatchObject({ ctx: "cp3", plus: 10 });
    expect(screenText("#chat")).toContain("Баланс поповнено");
    await click("Повторити", "#chat");

    // 07 · n7-fmt — «Списано 2 кредитів за додаткові формати (1)…», баланс 9, рендер.
    await until((s) => s.ui.retry === null && s.account.me?.balance === 9, "списано 2");
    expect(screenText("#chat")).toContain(t("chargedFormats", { credits: 2, count: 1, balance: 9 }));
    await until((s) => s.status === "delivered", "готово");
    expect(errors).not.toHaveBeenCalled();
  });
});

describe("F3 · Правка після видачі", () => {
  it("n5-done → n5-done-typing → n7-rev → f3-done2", async () => {
    const olena = server.seedUser({
      email: "olena@example.com",
      name: "Олена Коваль",
      password: "kava-2026!",
      balance: 22,
    });
    server.signIn(server.jar, olena.id);
    // Видано 9:16 + 1:1 (як у фікстурі); доплату за 1:1 спрощено не списуємо → баланс 12.
    const p = server.seedProject(olena.id, "delivered", ["vertical", "square"]);
    await open(`/?project=${p.id}`);
    await until((s) => s.status === "delivered" && s.account.me?.balance === 12, "готово, баланс 12");

    // 01 · n5-done — підказка «правка — 3 кредити» біля композера.
    // 02 · n5-done-typing — правка в композері.
    expect(screenText("#chat")).toContain("правка — 3 кредити");
    await fill("Повідомлення", "Зроби заголовок першої сцени коротшим", "#chat");
    await submit("#chat textarea");

    // 03 · n7-rev — «Списано 3 кредитів за правку. Залишок: 9.» і мітка «−3» у топбарі.
    await until((s) => s.account.me?.balance === 9, "баланс 9");
    expect(screenText("#chat")).toContain(t("chargedRevision", { credits: 3, balance: 9 }));
    expect(state().account.delta).toMatchObject({ credits: -3 });
    expect(screenText("#topbar")).toContain("−3");

    // 04 · f3-done2 — нова ревізія: ЧП3 рев. 2 → «Затвердити» → «Готово · ревізія 2».
    await until((s) => s.status === "awaiting_storyboard" && s.rev === 2, "ЧП3 рев. 2");
    await click(/^Затвердити/, "#stage");
    await until((s) => s.status === "delivered" && s.rev === 2, "готово, ревізія 2");
    expect(state().account.me?.balance).toBe(9); // один формат — без доплати
    expect(errors).not.toHaveBeenCalled();
  });
});

describe("F4 · Відновлення пароля (десктоп → телефон)", () => {
  it("n1-login → n2-forgot → n2-forgot-sent → n2-reset → n2-reset-weak → n2-reset-done; стара сесія → 401 у сцені", async () => {
    const olena = server.seedUser({
      email: "olena@example.com",
      name: "Олена Коваль",
      password: "old-pass-1",
      balance: 22,
    });
    const project = server.seedProject(olena.id, "brand");
    // Інший браузер, де Олена давно увійшла.
    const desktop: Jar = { token: null };
    server.signIn(desktop, olena.id);

    // 01 · n1-login — гість: «Увійти» → «Забули пароль?».
    await open("/");
    await until((s) => s.account.meStatus === "anon", "гість");
    await click("Увійти", "#start");
    await until((s) => s.auth?.view === "login", "вхід");
    await click("Забули пароль?", "#overlay");

    // 02 · n2-forgot → 03 · n2-forgot-sent.
    await until((s) => s.auth?.view === "forgot", "забули пароль");
    await fill("email", "olena@example.com", "#overlay");
    await click("Надіслати посилання", "#overlay");
    await until((s) => s.auth?.view === "forgotSent", "надіслано");
    expect(screenText("#overlay")).toContain("olena@example.com");

    // 04 · n2-reset — посилання на телефоні (390): новий пароль.
    await openInNewTab(server.lastMail("olena@example.com", "reset").link);
    expect(location.search).not.toContain("token=");
    await until((s) => s.auth?.view === "reset", "новий пароль");

    // 05 · n2-reset-weak — закороткий: повідомлення сервера (400 weak_password).
    await fill("new-password", "short", "#overlay");
    await click("Зберегти й увійти", "#overlay");
    await until((s) => s.auth?.error === "weak_password", "weak");
    expect(screenText("#overlay")).toContain("Пароль — від 8 до 128 символів.");

    // 06 · n2-reset-done — «Пароль змінено» / «Вхід виконано».
    await fill("new-password", "new-pass-2026", "#overlay");
    await click("Зберегти й увійти", "#overlay");
    await until((s) => s.auth?.view === "resetDone" && s.account.meStatus === "ready", "вхід виконано");
    expect(screenText("#overlay")).toMatch(/Вхід виконано|Пароль змінено/);

    // Стара сесія в іншому браузері → 401 → форма входу в сцені.
    server.jar = desktop;
    await open(`/?project=${project.id}`);
    await until((s) => s.session === "401", "401 у сцені");
    expect(stage()?.getAttribute("data-view") ?? "").not.toBe("progress");
    expect(screenText("#stage")).toMatch(/Сесія завершилась|Увійдіть ще раз/);
    await fill("email", "olena@example.com", "#stage");
    await fill("current-password", "new-pass-2026", "#stage");
    await click("Увійти", "#stage");
    await until((s) => s.session === null && s.status === "awaiting_brand", "проєкт на тому ж екрані");
    expect(errors).not.toHaveBeenCalled();
  });
});

/** Екран сцени (корінь у `#stage`). */
const stage = () => document.querySelector("#stage")?.firstElementChild ?? null;

describe("F5 · Адмін", () => {
  it("adm-users → adm-user (+5 «компенсація») → adm-done → adm-outbox (Копіювати)", async () => {
    const admin = server.seedUser({
      email: ADMIN_EMAIL,
      name: "Адмін",
      password: "admin-pass-1",
      balance: 500,
    });
    const olena = server.seedUser({
      email: "olena@example.com",
      name: "Олена Коваль",
      password: "kava-2026!",
      balance: 12,
    });
    server.signIn(server.jar, admin.id);
    // Лист в outbox (скидання для Олени).
    server.handle("POST", new URL("/api/auth/forgot", APP_URL), { email: olena.email }, null);
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });

    // 01 · adm-users — список користувачів з балансами.
    await open("/?admin=users");
    await until((s) => s.route === "admin" && s.admin.users.length === 2, "користувачі");
    expect(screenText("#admin-main")).toContain("olena@example.com");
    await click("olena@example.com", "#admin-main");

    // 02 · adm-user — «+5», примітка «компенсація» → «Нарахувати».
    await until((s) => s.admin.selected?.user.id === olena.id, "картка користувача");
    await fill("+5 або −3", "+5", "#admin-main");
    await fill("компенсація", "компенсація", "#admin-main");
    await click("Нарахувати", "#admin-main");

    // 03 · adm-done — «Нараховано +5», запис зверху історії, баланс 17.
    await until((s) => s.admin.adjust.done !== null, "нараховано");
    expect(server.balance(olena.id)).toBe(17);
    expect(state().admin.selected?.entries[0]).toMatchObject({
      kind: "adjust",
      credits: 5,
      note: "компенсація",
    });
    expect(screenText("#admin-main")).toContain("компенсація");

    // 04 · adm-outbox — лист і «Копіювати» → посилання в буфері.
    await click("Outbox", "#admin");
    await until((s) => s.admin.tab === "outbox" && s.admin.outbox.length > 0, "outbox");
    await click("Копіювати", "#admin-main");
    expect(writeText).toHaveBeenCalledWith(server.lastMail(olena.email, "reset").link);
    expect(errors).not.toHaveBeenCalled();
  });
});

describe("§10 п. 6 · системні стани", () => {
  it("чужий проєкт → «Проєкт не знайдено»; клієнт на /?admin=users → 403; вихід → старт із рядком-статусом", async () => {
    const olena = server.seedUser({
      email: "olena@example.com",
      name: "Олена Коваль",
      password: "kava-2026!",
      balance: 12,
    });
    const andriy = server.seedUser({
      email: "andriy@example.com",
      name: "Андрій",
      password: "andriy-pass",
      balance: 30,
    });
    const foreign = server.seedProject(andriy.id, "brand");
    server.signIn(server.jar, olena.id);

    await open(`/?project=${foreign.id}`);
    await until((s) => s.session === "404", "404");
    expect(screenText("#stage")).toContain("Проєкт не знайдено");

    await open("/?admin=users");
    await until((s) => s.session === "403" && s.admin.forbidden, "403");
    expect(server.log.some((l) => l.startsWith("GET /api/admin/"))).toBe(false);

    await open("/?cabinet=profile");
    await until((s) => s.route === "cabinet" && s.account.meStatus === "ready", "кабінет");
    await click("Вийти з акаунта", "#cab-main");
    await until((s) => s.route === "start" && s.account.meStatus === "anon", "старт");
    expect(screenText("#start")).toContain("Ви вийшли з акаунта");
    expect(errors).not.toHaveBeenCalled();
  });
});
