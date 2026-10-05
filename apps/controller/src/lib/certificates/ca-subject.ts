import { getAppName } from "../branding/app-name";

/** Subject and issuer of a CA this instance generates: it is self-signed, so they are the same. */
export async function internalCaSubject(
  commonName: string,
): Promise<{ name: string; value: string }[]> {
  return [
    { name: "commonName", value: commonName },
    { name: "organizationName", value: await getAppName() },
  ];
}
