import { localUsersDisabled } from "@/src/lib/auth/policy";
import { type NextRequest, NextResponse } from "next/server";
import { requireApiAdmin, apiErrorResponse } from "@/src/lib/api/auth";
import { listUsers, createUser } from "@/src/lib/models/user";
import { hashPassword } from "@/src/lib/auth/password";
import { DomainError, domainErrorMessage } from "@/src/lib/errors/domain-error";
import { isEmailAddress } from "@/src/lib/email/address";
import {
  assertAcceptablePassword,
  isUserRole,
  signInUsernameRulesMessage,
} from "@/src/lib/users/admin";

function stripPasswordHash(user: Record<string, unknown>) {
  const { passwordHash: _, ...rest } = user;
  void _;
  return rest;
}

export async function GET(request: NextRequest) {
  try {
    await requireApiAdmin(request);
    const users = await listUsers();
    return NextResponse.json(
      users.map((u) => stripPasswordHash(u as unknown as Record<string, unknown>)),
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    await requireApiAdmin(request);

    if (await localUsersDisabled()) {
      return NextResponse.json(
        { error: "Local user creation is disabled. Users are provisioned by the OIDC provider." },
        { status: 403 },
      );
    }

    const body = await request.json();

    const email = String(body.email ?? "").trim();
    const password = String(body.password ?? "");
    const name = body.name ? String(body.name).trim() : null;
    if (body.role !== undefined && body.role !== null && !isUserRole(body.role)) {
      return NextResponse.json({ error: "Invalid role" }, { status: 400 });
    }
    const role = isUserRole(body.role) ? body.role : "user";
    // Optional: without one, createUser gives their own email when it can be a username.
    const username: unknown = body.username ?? null;
    if (username !== null && typeof username !== "string") {
      return NextResponse.json({ error: signInUsernameRulesMessage() }, { status: 400 });
    }

    if (!email || !password) {
      return NextResponse.json({ error: "Email and password are required" }, { status: 400 });
    }
    if (!isEmailAddress(email)) {
      return NextResponse.json({ error: domainErrorMessage("emailInvalid") }, { status: 400 });
    }

    try {
      assertAcceptablePassword(password);
    } catch (error) {
      if (error instanceof DomainError) {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
      throw error;
    }

    const passwordHash = await hashPassword(password);

    const user = await createUser({
      email,
      name,
      role,
      provider: "credentials",
      subject: email,
      passwordHash,
      username,
    });

    return NextResponse.json(stripPasswordHash(user as unknown as Record<string, unknown>), {
      status: 201,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
