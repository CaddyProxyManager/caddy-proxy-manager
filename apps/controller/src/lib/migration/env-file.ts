/**
 * The app never sees the host's `.env`, so this builds a `sed` for the operator that comments out
 * (with a `.bak` - some values are the only copy of a secret) variables now in the database.
 * Variables Compose reads are held back: removing them also means changing `COMPOSE_PROFILES`.
 */
import { SETTINGS_BY_ENV } from "../settings/registry";

export type EnvCleanup = {
  /** In registry order. */
  comment: string[];
  /** Compose still reads these, whatever the database holds. */
  keep: string[];
  /** `null` when there is nothing to do. */
  command: string | null;
};

/** `stored`: env names whose settings have a database value; every other line has to stay. */
export function planEnvCleanup(stored: Iterable<string>): EnvCleanup {
  const migrated = new Set(stored);
  const comment: string[] = [];
  const keep: string[] = [];

  // Over the registry, so a name that is not a setting can never reach the command.
  for (const [env, definition] of SETTINGS_BY_ENV) {
    if (!migrated.has(env)) continue;
    (definition.composeReads ? keep : comment).push(env);
  }

  return { comment, keep, command: comment.length > 0 ? buildCommand(comment) : null };
}

/**
 * POSIX ERE, `-i.bak` and `[[:space:]]`: the spelling GNU and BSD sed both accept. Anchored at the
 * line start, so a second run changes nothing.
 */
function buildCommand(names: readonly string[]): string {
  return [
    `migrated='${names.join("|")}'`,
    `sed -i.bak -E "s/^([[:space:]]*)((export[[:space:]]+)?(\${migrated})[[:space:]]*=)/\\1# migrated to the database: \\2/" .env`,
  ].join("\n");
}
