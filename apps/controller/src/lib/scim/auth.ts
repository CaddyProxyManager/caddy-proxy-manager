/**
 * SCIM's own Better Auth instance: the same tables and secret as sign-in's, the plugin's native
 * transactions, and nothing else. Rebuilt when the Public URL changes, as getAuth() is.
 */
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { config } from "../config";
import db from "../db";
import { activeSchema } from "../db/schema";
import { getPublicBaseUrl } from "../http/public-url";
import { scimExtras, scimProvisioning } from "./plugin";

/** The plugin's model names, which its options cannot rename, onto CPM's tables. */
const PLUGIN_MODELS = {
  scimConnectionBinding: activeSchema.scimConnectionBindings,
  scimIdentityTombstone: activeSchema.scimIdentityTombstones,
  scimSubject: activeSchema.scimSubjects,
  scimUser: activeSchema.scimUsers,
  scimProjectionGrant: activeSchema.scimProjectionGrants,
  scimGroup: activeSchema.scimGroups,
  scimGroupMember: activeSchema.scimGroupMembers,
};

function createScimAuth(baseURL: string) {
  return betterAuth({
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: { ...activeSchema, ...PLUGIN_MODELS },
      transaction: true,
    }),
    secret: config.sessionSecret,
    baseURL,
    basePath: "/api/auth",
    advanced: { database: { generateId: "serial" } } as Record<string, unknown>,
    // Every request carries a 256-bit token; an identity provider's full sync must not be throttled.
    rateLimit: { enabled: false },
    user: {
      modelName: "users",
      fields: { image: "avatarUrl" },
      additionalFields: {
        role: { type: "string", defaultValue: "user", input: false },
        status: { type: "string", defaultValue: "active", input: false },
        provider: { type: "string", defaultValue: "", input: false },
        subject: { type: "string", defaultValue: "", input: false },
      },
    },
    session: { modelName: "sessions" },
    account: { modelName: "accounts" },
    verification: { modelName: "verifications" },
    plugins: [scimExtras(), scimProvisioning()],
  });
}

let cached: { baseURL: string; db: unknown; auth: ReturnType<typeof createScimAuth> } | null = null;

export async function getScimAuth(): Promise<ReturnType<typeof createScimAuth>> {
  const baseURL = await getPublicBaseUrl();
  // The handle too: tests swap the database under a running process.
  if (cached?.baseURL !== baseURL || cached.db !== db) {
    cached = { baseURL, db, auth: createScimAuth(baseURL) };
  }
  return cached.auth;
}
