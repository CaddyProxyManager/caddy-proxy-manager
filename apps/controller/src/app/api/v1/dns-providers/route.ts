import { type NextRequest, NextResponse } from "next/server";
import { requireApiUser, apiRoute } from "@/src/lib/api/auth";
import { DNS_PROVIDERS } from "@/src/lib/dns/providers";

// Provider definitions without any credential values. The catalog is static, so shaped once.
const PROVIDERS = DNS_PROVIDERS.map(
  ({ name, displayName, description, docsUrl, fields, modulePath }) => ({
    name,
    displayName,
    description,
    docsUrl,
    modulePath,
    fields: fields.map(({ key, label, type, placeholder, description, required }) => ({
      key,
      label,
      type,
      placeholder,
      description,
      required,
    })),
  }),
);

export const GET = apiRoute(async (request: NextRequest) => {
  await requireApiUser(request);
  return NextResponse.json(PROVIDERS);
});
