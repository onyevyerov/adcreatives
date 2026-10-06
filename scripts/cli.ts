/**
 * Пайплайн з термінала без API і Redis: `pnpm tsx scripts/cli.ts run <url>` | `stats [--csv]`.
 * Логіка — `tests/integration/src/cli.ts` (той самий in-process рантайм, що й у eval).
 */
import { runCli } from "../tests/integration/src/cli.ts";

process.exit(await runCli(process.argv.slice(2)));
