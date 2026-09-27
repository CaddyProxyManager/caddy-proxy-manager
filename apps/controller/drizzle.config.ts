import { defineConfig } from "drizzle-kit";
import { resolveDatabaseTarget } from "./src/lib/db/dialect";

/**
 * drizzle-kit is single-dialect, so this follows DATABASE_URL. After a schema change:
 *   bun scripts/generate-sqlite-schema.ts
 *   DATABASE_URL=postgres://... bun run db:generate     # -> drizzle/postgres/
 *   DATABASE_URL=file:./data/cpm.db bun run db:generate # -> drizzle/sqlite/
 * Nothing generates into `drizzle/legacy-sqlite/`: it builds realistic pre-3.0 databases for tests.
 */
const target = resolveDatabaseTarget(process.env);

export default target.kind === "sqlite"
  ? defineConfig({
      out: "./drizzle/sqlite",
      schema: "./src/lib/db/schema.sqlite.ts",
      dialect: "sqlite",
      dbCredentials: { url: target.path },
    })
  : defineConfig({
      out: "./drizzle/postgres",
      schema: "./src/lib/db/schema.pg.ts",
      dialect: "postgresql",
      dbCredentials:
        target.kind === "url"
          ? { url: target.url }
          : {
              host: target.hostname,
              port: target.port,
              user: target.username,
              password: target.password,
              database: target.database,
              ssl: target.tls,
            },
    });
