import { type NextRequest, NextResponse } from "next/server";
import { requireApiAdmin, apiErrorResponse } from "@/src/lib/api/auth";
import { DefaultResponseValidationError } from "@/src/lib/caddy/default-response";
import {
  isSettingsGroup,
  readSettingsGroup,
  saveSettingsGroup,
  SettingsApplyError,
} from "@/src/lib/settings/api";
import { assertSettingsPayloadSize, SettingsValidationError } from "@/src/lib/settings/validation";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ group: string }> },
) {
  try {
    await requireApiAdmin(request);
    const { group } = await params;

    const settings = await readSettingsGroup(group);
    if (!settings) {
      return NextResponse.json({ error: "Unknown settings group" }, { status: 404 });
    }

    return NextResponse.json(
      settings.value,
      settings.sensitive ? { headers: { "Cache-Control": "no-store" } } : undefined,
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ group: string }> },
) {
  try {
    await requireApiAdmin(request);
    const { group } = await params;
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
    }

    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return NextResponse.json({ error: "Settings payload must be an object" }, { status: 400 });
    }
    const input = body as Record<string, unknown>;
    try {
      assertSettingsPayloadSize(input);
    } catch (error) {
      if (error instanceof SettingsValidationError) {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
      throw error;
    }

    if (!isSettingsGroup(group)) {
      return NextResponse.json({ error: "Unknown settings group" }, { status: 404 });
    }

    try {
      await saveSettingsGroup(group, input);
    } catch (error) {
      if (
        error instanceof SettingsValidationError ||
        error instanceof DefaultResponseValidationError
      ) {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
      if (error instanceof SettingsApplyError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      throw error;
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
