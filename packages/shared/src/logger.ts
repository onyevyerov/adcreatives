export type LogMeta = Record<string, unknown>;

export interface Logger {
  debug(msg: string, meta?: LogMeta): void;
  info(msg: string, meta?: LogMeta): void;
  warn(msg: string, meta?: LogMeta): void;
  error(msg: string, meta?: LogMeta): void;
  child(bindings: LogMeta): Logger;
}

/** Простий JSON-логер у stdout/stderr. */
export function createConsoleLogger(bindings: LogMeta = {}, level: "debug" | "info" = "info"): Logger {
  const write = (lvl: string, msg: string, meta?: LogMeta) => {
    const line = JSON.stringify({ ts: new Date().toISOString(), level: lvl, msg, ...bindings, ...meta });
    if (lvl === "error" || lvl === "warn") console.error(line);
    else console.log(line);
  };
  return {
    debug: (msg, meta) => {
      if (level === "debug") write("debug", msg, meta);
    },
    info: (msg, meta) => write("info", msg, meta),
    warn: (msg, meta) => write("warn", msg, meta),
    error: (msg, meta) => write("error", msg, meta),
    child: (more) => createConsoleLogger({ ...bindings, ...more }, level),
  };
}

export const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => noopLogger,
};
