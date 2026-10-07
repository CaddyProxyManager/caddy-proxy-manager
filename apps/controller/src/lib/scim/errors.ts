/**
 * SCIM's error shape (RFC 7644 §3.12), for what CPM answers before the plugin does. The detail
 * stays English: SCIM is a machine contract, as `/api/v1` is.
 */

export const SCIM_ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";

export class ScimError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ScimError";
  }

  toJSON() {
    return { schemas: [SCIM_ERROR_SCHEMA], status: String(this.status), detail: this.message };
  }
}
