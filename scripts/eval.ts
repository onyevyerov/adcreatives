/**
 * Eval: `pnpm eval` (див. `pnpm eval --help`). Логіка — `tests/integration/src/eval.ts`.
 * Кейс паритету: `pnpm eval -- --case webreportio-parity --mode pipeline|agent` → `eval/out/<кейс>/report.json`
 * ($, токени, хвилини, рівні звуку, перевірка треку, критерії); `pnpm eval -- --audio <файл.wav>` — ті самі
 * аудіо-метрики для еталона. Порівняння з `one line.mp4` — `docs/analysis/README.md`.
 * Відносний імпорт: кореневий package.json не залежить від workspace-пакетів.
 */
import { runEvalCli } from "../tests/integration/src/eval.ts";

// Явний вихід: HTTP keep-alive клієнтів API не повинні тримати процес після звіту.
process.exit(await runEvalCli(process.argv.slice(2)));
