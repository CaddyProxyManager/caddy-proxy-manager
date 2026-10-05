import { type NextRequest, NextResponse } from "next/server";
import { getAuth } from "./server";
import { domainError } from "../errors/domain-error";
import { getUserById } from "../models/user";
import { type ViewAs, readViewAs } from "../users/view-as";

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
};

/** Role is fetched fresh from the DB, so a demotion takes effect immediately. */
export async function auth(req?: NextRequest): Promise<Session | null> {
  const hdrs = req ? req.headers : (await import("next/headers")).headers();

  const resolvedHeaders = hdrs instanceof Promise ? await hdrs : hdrs;

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

export async function requireAdmin(): Promise<Session> {
  const session = await requireUser();
  if (session.user.role !== "admin") {
    throw domainError("adminRequired");
  }
  return session;
}

/**
 * Admin or operator: gates a page an operator may open, whose contents `lib/users/permissions.ts`
 * filters per resource. Everything global stays on `requireAdmin`.
 */
export async function requireManager(): Promise<Session> {
  const session = await requireUser();
  if (session.user.role !== "admin" && session.user.role !== "operator") {
    // Role-neutral: requireAdmin's wording would send a refused operator to find an admin.
    throw domainError("accessDenied");
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
