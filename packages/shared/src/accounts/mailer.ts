import { randomBytes } from "node:crypto";
import type { Logger } from "../logger.ts";
import type { Storage } from "../storage/Storage.ts";
import { accountPaths } from "./paths.ts";
import { OutboxMail } from "./schemas.ts";

export interface Mailer {
  send(mail: Omit<OutboxMail, "id" | "at">): Promise<OutboxMail>;
}

/** Мітка часу для імені файлу: сортується як час і не містить `:` (Windows). */
const fileStamp = (at: string) => at.replace(/[:.]/g, "-");

/** Пише outbox/<ts>-<id>.json і логує {to, kind, link} рівнем info — це і є «доставка» в макеті. */
export function createOutboxMailer(deps: { storage: Storage; logger?: Logger; now?: () => Date }): Mailer {
  const now = deps.now ?? (() => new Date());
  return {
    async send(input) {
      const mail = OutboxMail.parse({
        ...input,
        id: randomBytes(8).toString("hex"),
        at: now().toISOString(),
      });
      await deps.storage.writeJson(`${accountPaths.outboxDir}/${fileStamp(mail.at)}-${mail.id}.json`, mail);
      deps.logger?.info("лист в outbox", { to: mail.to, kind: mail.kind, link: mail.link });
      return mail;
    },
  };
}

/** Листи з outbox, новіші першими; биті файли пропускаються. */
export async function readOutbox(storage: Storage, limit = 50): Promise<OutboxMail[]> {
  const keys = (await storage.list(accountPaths.outboxDir)).filter((k) => k.endsWith(".json")).reverse();
  const out: OutboxMail[] = [];
  for (const key of keys) {
    if (out.length >= limit) break;
    const r = OutboxMail.safeParse(await storage.readJson(key).catch(() => null));
    if (r.success) out.push(r.data);
  }
  return out;
}
