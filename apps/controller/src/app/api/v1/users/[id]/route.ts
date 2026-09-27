import { type NextRequest, NextResponse } from "next/server";
import {
  requireApiUser,
  requireApiAdmin,
  apiErrorResponse,
  ApiAuthError,
} from "@/src/lib/api-auth";
import {
  getUserById,
  updateUserProfile,
  updateUserRole,
  updateUserStatus,
  deleteUser,
} from "@/src/lib/models/user";
import { domainErrorMessage } from "@/src/lib/domain-error";
import { isEmailAddress } from "@/src/lib/email-address";
import { isUserRole, isUserStatus } from "@/src/lib/user-admin";

function stripPasswordHash(user: Record<string, unknown>) {
  const { passwordHash: _, ...rest } = user;
  void _;
  return rest;
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireApiUser(request);
    const { id } = await params;
    const targetId = Number(id);

    if (auth.role !== "admin" && auth.userId !== targetId) {
      throw new ApiAuthError("Forbidden", 403);
    }

    const user = await getUserById(targetId);
    if (!user) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json(stripPasswordHash(user as unknown as Record<string, unknown>));
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireApiAdmin(request);
    const { id } = await params;
    const targetId = Number(id);
    const body = await request.json();

    // Refused, not skipped: ignoring an unknown value reads as success to a client.
    const hasRole = body.role !== undefined && body.role !== null;
    const hasStatus = body.status !== undefined && body.status !== null;
    if (hasRole && !isUserRole(body.role)) {
      return NextResponse.json({ error: "Invalid role" }, { status: 400 });
    }
    if (hasStatus && !isUserStatus(body.status)) {
      return NextResponse.json({ error: "Invalid status" }, { status: 400 });
    }
    // Before any write, like the two above, so a bad address cannot land half an update.
    if (
      body.email !== undefined &&
      (typeof body.email !== "string" || !isEmailAddress(body.email.trim()))
    ) {
      return NextResponse.json({ error: domainErrorMessage("emailInvalid") }, { status: 400 });
    }

    if (hasRole) {
      if (auth.userId === targetId) {
        return NextResponse.json({ error: "Cannot change your own role" }, { status: 400 });
      }
      await updateUserRole(targetId, body.role);
    }

    if (hasStatus) {
      if (auth.userId === targetId) {
        return NextResponse.json({ error: "Cannot change your own status" }, { status: 400 });
      }
      await updateUserStatus(targetId, body.status);
    }

    const profileFields: Record<string, unknown> = {};
    if (body.email !== undefined) profileFields.email = body.email;
    if (body.name !== undefined) profileFields.name = body.name;
    if (body.avatarUrl !== undefined) profileFields.avatarUrl = body.avatarUrl;
    if (Object.keys(profileFields).length > 0) {
      await updateUserProfile(
        targetId,
        profileFields as { email?: string; name?: string | null; avatarUrl?: string | null },
      );
    }

    const user = await getUserById(targetId);
    if (!user) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json(stripPasswordHash(user as unknown as Record<string, unknown>));
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await requireApiAdmin(request);
    const { id } = await params;
    const targetId = Number(id);

    if (auth.userId === targetId) {
      return NextResponse.json({ error: "Cannot delete your own account" }, { status: 400 });
    }

    const user = await getUserById(targetId);
    if (!user) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    await deleteUser(targetId);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
