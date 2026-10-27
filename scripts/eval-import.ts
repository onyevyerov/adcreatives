/**
 * Імпорт прод-проєкту як бази для `pnpm eval -- --from check|review|sfx` (ТЗ класу A, Блок 8).
 * Логіка — `tests/integration/src/import-prod.ts`. Без мережі й API: вигрузку лише читає.
 *
 *   pnpm tsx scripts/eval-import.ts --from <вигрузка> --run <ім'я> [--reset codegen] [--project <id>]…
 *   pnpm tsx scripts/eval-import.ts --help
 *
 * `<вигрузка>` — тека зі структурою `/data` прода: `projects/<id>/…` і `cache/sfx/…` (що вивантажити —
 * `docs/analysis/cost-optimization.md` §5.2). Результат — `eval/runs/<ім'я>/`: `data/` (копія проєктів і кешу SFX;
 * з `--reset codegen` сцени скинуто до коду codegen v1), `base.json` (метрики бази до скидання) і `base/<id>/*.mp4`
 * (рендери бази). Далі — `pnpm eval -- --from check --run <ім'я>` з перемикачами `ADC_*` (§5.4).
 * Помилка (немає `v1.tsx`, шаблонні сцени, тека прогону вже є тощо) → код 2, тека прогону не створюється.
 * Відносний імпорт: кореневий package.json не залежить від workspace-пакетів.
 */
import { runImportCli } from "../tests/integration/src/import-prod.ts";

process.exit(await runImportCli(process.argv.slice(2)));
