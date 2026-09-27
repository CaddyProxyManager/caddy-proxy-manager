import { type NextRequest, NextResponse } from "next/server";
import { getTranslations } from "next-intl/server";
import { auth, checkSameOrigin } from "@/src/lib/auth";
import { updateUserProfile } from "@/src/lib/models/user";
import { createAuditEvent } from "@/src/lib/models/audit";
import { MAX_AVATAR_DATA_URL_LENGTH } from "@/src/lib/avatar-limits";

export async function POST(request: NextRequest) {
  const originCheck = checkSameOrigin(request);
  if (originCheck) return originCheck;

  const t = await getTranslations();
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: t("auth.apiErrors.unauthorized") }, { status: 401 });
    }

    const userId = Number(session.user.id);
    const body = await request.json();
    const { avatarUrl } = body;

    // Validate avatarUrl is either null or a base64 image string
    if (avatarUrl !== null && typeof avatarUrl !== "string") {
      return NextResponse.json({ error: t("profile.avatarInvalid") }, { status: 400 });
    }

    // If avatarUrl is provided, validate it's a base64 image (png/jpeg/webp only)
    if (avatarUrl !== null) {
      const match = avatarUrl.match(/^data:(image\/(png|jpeg|jpg|webp));base64,/i);
      if (!match) {
        return NextResponse.json({ error: t("profile.avatarFormatInvalid") }, { status: 400 });
      }

      if (avatarUrl.length > MAX_AVATAR_DATA_URL_LENGTH) {
        return NextResponse.json({ error: t("profile.avatarImageTooLarge") }, { status: 400 });
      }
    }

    const updatedUser = await updateUserProfile(userId, {
      avatarUrl: avatarUrl,
    });

    if (!updatedUser) {
      return NextResponse.json({ error: t("auth.apiErrors.userNotFound") }, { status: 404 });
    }

    await createAuditEvent({
      userId,
      action: avatarUrl ? "avatar_updated" : "avatar_deleted",
      entityType: "user",
      entityId: userId,
      summary: avatarUrl ? "User updated profile picture" : "User removed profile picture",
      data: JSON.stringify({ hasAvatar: !!avatarUrl }),
    });

    return NextResponse.json({
      success: true,
      avatarUrl: updatedUser.avatarUrl,
    });
  } catch (error) {
    console.error("Avatar update error:", error);
    return NextResponse.json({ error: t("profile.avatarUpdateFailed") }, { status: 500 });
  }
}
