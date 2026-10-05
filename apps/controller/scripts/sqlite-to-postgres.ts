/**
 * `bun scripts/sqlite-to-postgres.ts --from file:./data/cpm.db --to postgres://... [--dry-run]`.
 * The same command as `cpm-server --copy-to-postgres` in the image; see the database docs page.
 */
import { hideBin } from "yargs/helpers";
import { runCopyCli } from "../src/lib/migration/sqlite-to-postgres-cli";

process.exit(await runCopyCli(hideBin(process.argv)));
