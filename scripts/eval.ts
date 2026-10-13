/**
 * Eval: `pnpm eval` (див. `pnpm eval --help`). Логіка — `tests/integration/src/eval.ts`.
 * Кейс паритету: `pnpm eval -- --case webreportio-parity --mode pipeline|agent` → `eval/out/<кейс>/report.json`
 * ($, токени, хвилини, рівні звуку, перевірка треку, `audio`: LUFS/dBTP мастера, тональність, такт, стерео,
 * критерії); `pnpm eval -- --audio <файл.wav>` — ті самі аудіо-метрики для еталона. Порівняння з `one line.mp4`
 * і цілі звуку — `docs/analysis/README.md` (замір — `pnpm audio-measure`).
 * Відносний імпорт: кореневий package.json не залежить від workspace-пакетів.
 */
import { runEvalCli } from "../tests/integration/src/eval.ts";

// Явний вихід: HTTP keep-alive клієнтів API не повинні тримати процес після звіту.
process.exit(await runEvalCli(process.argv.slice(2)));
