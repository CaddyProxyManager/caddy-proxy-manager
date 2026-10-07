import { type NextRequest, NextResponse } from "next/server";
import { getAuth } from "./server";
import { getUserById } from "../models/user";
import { type ViewAs, readViewAs } from "../users/view-as";
import { requestMemo } from "../request-memo";

export type Session = {
  user: {
    id: string;
    email: string;
    name: string | null;
    role: string;
    provider?: string;
    image?: string | null;
    /** Whether a password is set, which is what a second factor protects. */
    hasPassword?: boolean;
    twoFactorEnabled?: boolean;
  };
  /** Viewing as another role, `user.role` is that role (checks read it); `realRole` is not. */
  viewAs?: ViewAs;
  realRole?: string;
  /** Off `user`, which the dashboard hands to the browser; read with the row at no extra cost. */
  account?: { createdAt: string; timeZone: string | null; numberFormat: string | null };
};

/**
 * Role is fetched fresh from the DB, so a demotion takes effect immediately. Without `req`, once
 * per page render: the proxy, layouts, page and metadata would otherwise each read it again.
 */
export async function auth(req?: NextRequest): Promise<Session | null> {
  if (req) return resolveSession(req.headers);
  return requestMemo("auth:session", async () => {
    const { headers } = await import("next/headers");
    return resolveSession(await headers());
  });
}

async function resolveSession(resolvedHeaders: Headers): Promise<Session | null> {
  // biome-ignore lint/suspicious/noExplicitAny: better-auth's runtime shape, narrowed below
  let betterAuthSession: any;
  try {
    betterAuthSession = await (await getAuth()).api.getSession({
      headers: resolvedHeaders,
    });
  } catch {
    return null;
  }

  if (!betterAuthSession?.user) {
    return null;
  }

  const baUser = betterAuthSession.user as {
    id: string | number;
    name?: string | null;
    email: string;
    image?: string | null;
    role?: string;
    provider?: string;
    status?: string;
    avatarUrl?: string | null;
    subject?: string;
  };
  const userId = typeof baUser.id === "string" ? Number(baUser.id) : baUser.id;

  const currentUser = await getUserById(userId);
  if (currentUser?.status !== "active") {
    return null;
  }

  const viewAs = readViewAs(betterAuthSession.session, currentUser.role);

  return {
    ...(viewAs && { viewAs, realRole: currentUser.role }),
    user: {
      id: String(currentUser.id),
      email: currentUser.email,
      name: currentUser.name,
      role: viewAs?.role ?? currentUser.role,
      provider: currentUser.provider || baUser.provider,
      image: currentUser.avatarUrl ?? (baUser.avatarUrl as string | null | undefined) ?? null,
      hasPassword: Boolean(currentUser.passwordHash),
      twoFactorEnabled: currentUser.twoFactorEnabled,
    },
    account: {
      createdAt: currentUser.createdAt,
      timeZone: currentUser.timeZone,
      numberFormat: currentUser.numberFormat,
    },
  };
}

export async function getSession(): Promise<Session | null> {
  return auth();
}

/** Null without cookie auth. Marks "current" and is spared by "revoke other sessions". */
export async function getCurrentSessionId(req?: NextRequest): Promise<number | null> {
  const hdrs = req ? req.headers : (await import("next/headers")).headers();
  const resolvedHeaders = hdrs instanceof Promise ? await hdrs : hdrs;
  try {
    const result = await (await getAuth()).api.getSession({ headers: resolvedHeaders });
    const id = result?.session?.id;
    return id != null ? Number(id) : null;
  } catch {
    return null;
  }
}

export async function getCurrentSessionInfo(
  req?: NextRequest,
): Promise<{ id: number; createdAt: Date } | null> {
  const hdrs = req ? req.headers : (await import("next/headers")).headers();
  const resolvedHeaders = hdrs instanceof Promise ? await hdrs : hdrs;
  try {
    const result = await (await getAuth()).api.getSession({ headers: resolvedHeaders });
    const session = result?.session;
    if (session?.id == null || !session.createdAt) return null;
    const createdAt = new Date(session.createdAt);
    return Number.isNaN(createdAt.getTime()) ? null : { id: Number(session.id), createdAt };
  } catch {
    return null;
  }
}

// Its own module so auth/server.ts can gate passkey registration on it without an import cycle.
export { FRESH_SESSION_MAX_AGE_MS, isFreshSession } from "./session-age";

export async function requireUser(): Promise<Session> {
  const session = await auth();
  if (!session?.user) {
    const { redirect } = await import("next/navigation");
    redirect("/login");
    throw new Error("Redirecting to login"); // TypeScript doesn't know redirect() never returns
  }
  return session;
}

/**
 * Defense-in-depth CSRF: a mutating request must carry an Origin matching Host, which browsers
 * always send cross-origin.
 */
export function checkSameOrigin(request: NextRequest): NextResponse | null {
  const origin = request.headers.get("origin");
  const method = request.method.toUpperCase();
  const isMutating = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
  if (!origin) {
    if (!isMutating) return null;
    return NextResponse.json({ error: "Forbidden: Origin header required" }, { status: 403 });
  }

  const host = request.headers.get("host");
  try {
    const originHost = new URL(origin).host;
    if (originHost === host) return null;
  } catch {
    // unparseable origin - treat as mismatch
  }
  return NextResponse.json({ error: "Forbidden" }, { status: 403 });
}
