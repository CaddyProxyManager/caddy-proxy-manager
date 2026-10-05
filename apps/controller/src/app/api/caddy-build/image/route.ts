import { type NextRequest, NextResponse } from "next/server";
import { getFormatter, getTranslations } from "next-intl/server";
import { requireApiAdmin, apiErrorResponse } from "@/src/lib/api/auth";
import { extractErrorMessage } from "@/src/lib/errors/action-error";
import { loadCaddyImage, parseAgentRowId } from "@/src/lib/caddy/image-build";
import { DomainError } from "@/src/lib/errors/domain-error";

/** POST /api/caddy-build/image - external mode's rebuild: load the image the operator built. */
export async function POST(request: NextRequest) {
  try {
    await requireApiAdmin(request);
    const status = await loadCaddyImage(parseAgentRowId(request.nextUrl.searchParams.get("agent")));
    return NextResponse.json({ status });
  } catch (error) {
    // As the rebuild route: the panel shows a refusal as it arrives, in the reader's language.
    if (error instanceof DomainError) {
      const [t, format] = await Promise.all([getTranslations(), getFormatter()]);
      return NextResponse.json(
        { error: extractErrorMessage(t, error, error.message, format) },
        { status: error.status ?? 400 },
      );
    }
    return apiErrorResponse(error);
  }
}
