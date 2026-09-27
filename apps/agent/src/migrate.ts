/**
 * Agents once kept their database on the controller's volume; now they have their own and mount
 * the controller's read-only. A fresh database would mint a new agent id, so the state is copied
 * over once (not moved: the old mount is read-only).
 */

import { copyFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { BUILD_OVERRIDE_FILE, L4_OVERRIDE_FILE } from "./docker";

const DATABASE = "agent.db";

/**
 * Also copies WAL and shm, settled since the old container is gone. Each file goes via a temp name,
 * the database last: its presence marks this done, so an interrupted start copies everything again.
 */
export function adoptLegacyState(dataDir: string, legacyDir: string | null): boolean {
  if (!legacyDir) return false;
  if (existsSync(join(dataDir, DATABASE))) return false;
  if (!existsSync(join(legacyDir, DATABASE))) return false;

  mkdirSync(dataDir, { recursive: true });
  const files = [
    BUILD_OVERRIDE_FILE,
    L4_OVERRIDE_FILE,
    `${DATABASE}-wal`,
    `${DATABASE}-shm`,
    DATABASE,
  ];
  for (const name of files) {
    const from = join(legacyDir, name);
    if (!existsSync(from)) continue;
    const to = join(dataDir, name);
    copyFileSync(from, `${to}.migrating`);
    renameSync(`${to}.migrating`, to);
  }
  return true;
}
