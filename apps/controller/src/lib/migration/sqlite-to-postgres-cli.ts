/**
 * `bun scripts/sqlite-to-postgres.ts` in a checkout, `cpm-server --copy-to-postgres` in the image.
 * Console output, so English. Exit codes: 0 copied and verified, 1 refused or failed, 2 bad usage.
 */
import { resolve } from "node:path";
import { SQL } from "bun";
import yargs from "yargs";
import {
  type DatabaseTarget,
  driverOptions,
  resolveDatabaseTarget,
  resolveSqlitePath,
} from "../db/dialect";
import { CopyRefusedError, type CopyReport, copySqliteToPostgres } from "./sqlite-to-postgres";

function describeTarget(target: Exclude<DatabaseTarget, { kind: "sqlite" }>): string {
  if (target.kind === "fields") {
    return `${target.username}@${target.hostname}:${target.port}/${target.database}`;
  }
  try {
    const url = new URL(target.url);
    return `${url.username}@${url.host}${url.pathname}`;
  } catch {
    return "the PostgreSQL URL given";
  }
}

function printReport(report: CopyReport, write: (line: string) => void): void {
  const width = Math.max(...report.tables.map((table) => table.table.length), 5);
  write(`${"table".padEnd(width)}  ${"source".padStart(8)}  ${report.dryRun ? "" : "target"}`);
  for (const table of report.tables) {
    if (table.source === 0 && (table.after ?? 0) === 0) continue;
    write(
      `${table.table.padEnd(width)}  ${String(table.source).padStart(8)}  ${
        table.after === null ? "" : String(table.after).padStart(6)
      }`,
    );
  }
}

export async function runCopyCli(
  args: string[],
  env: Record<string, string | undefined> = process.env,
  write: (line: string) => void = console.log,
): Promise<number> {
  const argv = yargs(args)
    .scriptName("sqlite-to-postgres")
    .usage(
      "$0 [options]\n\nCopies a Caddy Proxy Manager SQLite database into an empty PostgreSQL " +
        "database, then counts every table on both sides. Stop the server first.",
    )
    .option("from", {
      type: "string",
      describe: "The SQLite file, or a file: URL",
      defaultDescription: "DATABASE_URL, when it names a SQLite file",
    })
    .option("to", {
      type: "string",
      describe: "The PostgreSQL URL (postgres://user:pass@host:5432/db)",
      defaultDescription: "POSTGRES_HOST, POSTGRES_PASSWORD and the rest",
    })
    .option("dry-run", {
      type: "boolean",
      default: false,
      describe: "Check both databases and count what would be copied, writing nothing",
    })
    .option("allow-non-empty", {
      type: "boolean",
      default: false,
      describe: "Copy into a database that already holds rows, skipping rows whose key is taken",
    })
    .option("migrations", {
      type: "string",
      describe: "The folder holding the postgres/ and sqlite/ migrations",
      defaultDescription: "./drizzle",
    })
    .strict()
    .version(false)
    .help()
    .exitProcess(false)
    .fail((message, error) => {
      throw error ?? new Error(message);
    })
    .parseSync();

  if (argv.help) return 0;

  let sqlitePath: string;
  let target: Exclude<DatabaseTarget, { kind: "sqlite" }>;
  try {
    const from = argv.from ?? env.DATABASE_URL;
    if (!from) throw new Error("Name the SQLite database with --from.");
    sqlitePath = resolveSqlitePath(from);
    // DATABASE_URL names the source here, so only the POSTGRES_* fields can name the target.
    const resolved = resolveDatabaseTarget(
      argv.to ? { DATABASE_URL: argv.to } : { ...env, DATABASE_URL: undefined },
    );
    if (resolved.kind === "sqlite") throw new Error("--to must name a PostgreSQL database.");
    target = resolved;
  } catch (error) {
    console.error(`[cpm] ${error instanceof Error ? error.message : error}`);
    return 2;
  }

  write(
    `[cpm] ${argv.dryRun ? "Checking a copy of" : "Copying"} ${sqlitePath} into ${describeTarget(target)}`,
  );
  const client =
    target.kind === "url"
      ? new SQL({ url: target.url, max: 1 })
      : new SQL({ ...driverOptions(target), max: 1 });
  try {
    const report = await copySqliteToPostgres({
      sqlitePath,
      target: client,
      migrationsFolder: resolve(argv.migrations ?? resolve(process.cwd(), "drizzle")),
      dryRun: argv.dryRun,
      allowNonEmpty: argv.allowNonEmpty,
      log: (line) => write(`[cpm]   ${line}`),
    });
    printReport(report, write);
    if (report.dryRun) {
      write(
        `[cpm] Dry run: ${report.totalRows} rows would be copied${
          report.targetUnmigrated ? ", after creating the schema" : ""
        }. Nothing was written.`,
      );
      return 0;
    }
    if (report.mismatches.length > 0) {
      for (const mismatch of report.mismatches) console.error(`[cpm] ${mismatch}`);
      console.error("[cpm] The copy finished, but the counts above do not all match.");
      return 1;
    }
    write(
      `[cpm] Copied ${report.totalRows} rows, and every table's count matches. Point DATABASE_URL ` +
        "at PostgreSQL (or remove it and set POSTGRES_PASSWORD) and start the server.",
    );
    return 0;
  } catch (error) {
    if (error instanceof CopyRefusedError) {
      console.error(`[cpm] ${error.message}`);
    } else {
      console.error("[cpm] The copy failed, and nothing was written to PostgreSQL:", error);
    }
    return 1;
  } finally {
    await client.close();
  }
}
