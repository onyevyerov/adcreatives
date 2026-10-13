/**
 * Кеш стандартних SFX (раз на деплой): `LIVE=1 pnpm sfx-cache [--source=chat|eval|test]`.
 * Пише `DATA_DIR/cache/sfx/<hash>.mp3`, витрати — у `DATA_DIR/costs-shared.jsonl`; друкує таблицю QC.
 * `pnpm sfx-cache --recheck` — QC наявного кешу (безкоштовно);
 * `LIVE=1 pnpm sfx-cache --regenerate-failed` — перегенерувати ті, що не проходять QC (платно).
 * Відносний імпорт: кореневий package.json не залежить від `@adc/audio`.
 */
import { runSfxCacheCli } from "../packages/audio/src/index.ts";

process.exitCode = await runSfxCacheCli(process.argv.slice(2));
