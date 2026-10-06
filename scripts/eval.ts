/**
 * Eval: `pnpm eval` (див. `pnpm eval --help`). Логіка — `tests/integration/src/eval.ts`.
 * Відносний імпорт: кореневий package.json не залежить від workspace-пакетів.
 */
import { runEvalCli } from "../tests/integration/src/eval.ts";

// Явний вихід: HTTP keep-alive клієнтів API не повинні тримати процес після звіту.
process.exit(await runEvalCli(process.argv.slice(2)));
