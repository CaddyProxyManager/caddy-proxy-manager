import { type NextRequest, NextResponse } from "next/server";
import { requireApiUser, apiErrorResponse } from "@/src/lib/api/auth";
import { APP_VERSION } from "@/src/lib/runtime/app-version";
import { TOKEN_AREAS, TOKEN_SCOPE_KINDS } from "@/src/lib/api-tokens/scope";
import { APP_ROLES } from "@/src/lib/auth/oidc/groups";
import { USER_STATUSES } from "@/src/lib/users/admin";
import { SETTINGS_GROUPS } from "@/src/lib/settings/api";
import {
  DEFAULT_CACHE_MAX_AGE,
  HOST_CACHE_MODES,
  MAX_CACHE_MAX_AGE,
  MIN_CACHE_MAX_AGE,
} from "@/src/lib/proxy-hosts/cache";
import {
  CACHE_STORAGES,
  CDN_PROVIDERS,
  CDN_STRATEGIES,
  MAX_CACHE_ENDPOINTS,
  MAX_OTTER_SIZE,
  MAX_REDIS_DB,
  MIN_OTTER_SIZE,
} from "@/src/lib/proxy-hosts/http-cache-options";

const TOKEN_PERMISSION_VALUES = TOKEN_AREAS.flatMap((area) => [`${area}:read`, `${area}:write`]);

const spec = {
  openapi: "3.1.0",
  info: {
    title: "Caddy Proxy Manager API",
    version: APP_VERSION,
    description:
      "REST API for managing Caddy reverse proxy configurations, certificates, access lists, and more.",
  },
  servers: [{ url: "/" }],
  security: [{ bearerAuth: [] }, { sessionAuth: [] }],
  tags: [
    { name: "Tokens", description: "API token management" },
    { name: "Proxy Hosts", description: "HTTP/HTTPS reverse proxy hosts" },
    { name: "L4 Proxy Hosts", description: "Layer 4 (TCP/UDP) proxy hosts" },
    { name: "Certificates", description: "TLS certificate management" },
    { name: "CA Certificates", description: "Certificate Authority certificates" },
    { name: "Client Certificates", description: "Client certificate management" },
    { name: "Access Lists", description: "HTTP basic-auth access lists" },
    { name: "Settings", description: "Application settings" },
    { name: "Users", description: "User management" },
    { name: "Groups", description: "User groups for forward auth access control" },
    { name: "mTLS Roles", description: "Role-based access control for mTLS client certificates" },
    {
      name: "WAF Presets",
      description: "Named SecLang rule sets the global WAF settings and each host select by id",
    },
    {
      name: "CRS Plugins",
      description:
        "Plugins from the OWASP CRS plugin registry, installed at a release and selected by id like presets",
    },
    { name: "Forward Auth", description: "Forward auth sessions and per-host access control" },
    { name: "Audit Log", description: "Audit log" },
    { name: "Caddy", description: "Caddy server operations" },
    { name: "Sessions", description: "Your active management-UI sessions" },
    { name: "OAuth Providers", description: "External OIDC/OAuth2 identity providers for SSO" },
  ],
  paths: {
    // ── Tokens ──────────────────────────────────────────────────────
    "/api/v1/tokens": {
      get: {
        tags: ["Tokens"],
        summary: "List tokens",
        operationId: "listTokens",
        responses: {
          "200": {
            description: "List of tokens",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: { $ref: "#/components/schemas/Token" },
                },
              },
            },
          },
          "401": { $ref: "#/components/responses/Unauthorized" },
        },
      },
      post: {
        tags: ["Tokens"],
        summary: "Create a token",
        description:
          "Requires an interactive cookie-authenticated management session. Bearer tokens cannot create replacement credentials.",
        security: [{ sessionAuth: [] }],
        operationId: "createToken",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/TokenInput" },
            },
          },
        },
        responses: {
          "201": {
            description: "Token created",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    token: { $ref: "#/components/schemas/Token" },
                    raw_token: {
                      type: "string",
                      description: "Plain-text token value. Only returned at creation time.",
                    },
                  },
                  required: ["token", "raw_token"],
                },
              },
            },
          },
          "400": { $ref: "#/components/responses/BadRequest" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "403": { $ref: "#/components/responses/Forbidden" },
        },
      },
    },
    "/api/v1/tokens/{id}": {
      delete: {
        tags: ["Tokens"],
        summary: "Delete a token",
        operationId: "deleteToken",
        parameters: [{ $ref: "#/components/parameters/IdPath" }],
        responses: {
          "200": { $ref: "#/components/responses/Ok" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
    },

    // ── Sessions ────────────────────────────────────────────────────
    "/api/v1/sessions": {
      get: {
        tags: ["Sessions"],
        summary: "List your active sessions",
        operationId: "listSessions",
        responses: {
          "200": {
            description: "Active sessions for the authenticated user",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      id: { type: "integer" },
                      createdAt: { type: "string" },
                      updatedAt: { type: "string" },
                      expiresAt: { type: "string" },
                      ipAddress: { type: "string", nullable: true },
                      userAgent: { type: "string", nullable: true },
                      current: {
                        type: "boolean",
                        description: "True for the session making this request",
                      },
                    },
                  },
                },
              },
            },
          },
          "401": { $ref: "#/components/responses/Unauthorized" },
        },
      },
      delete: {
        tags: ["Sessions"],
        summary: "Revoke all of your other sessions",
        operationId: "revokeOtherSessions",
        responses: {
          "200": {
            description: "Count of revoked sessions",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { revoked: { type: "integer" } },
                  required: ["revoked"],
                },
              },
            },
          },
          "401": { $ref: "#/components/responses/Unauthorized" },
        },
      },
    },
    "/api/v1/sessions/{id}": {
      delete: {
        tags: ["Sessions"],
        summary: "Revoke one of your sessions",
        operationId: "revokeSession",
        parameters: [{ $ref: "#/components/parameters/IdPath" }],
        responses: {
          "200": { $ref: "#/components/responses/Ok" },
          "400": { $ref: "#/components/responses/BadRequest" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
    },

    // ── Proxy Hosts ─────────────────────────────────────────────────
    "/api/v1/proxy-hosts": {
      get: {
        tags: ["Proxy Hosts"],
        summary: "List proxy hosts",
        operationId: "listProxyHosts",
        responses: {
          "200": {
            description: "List of proxy hosts",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: { $ref: "#/components/schemas/ProxyHost" },
                },
              },
            },
          },
          "401": { $ref: "#/components/responses/Unauthorized" },
        },
      },
      post: {
        tags: ["Proxy Hosts"],
        summary: "Create a proxy host",
        operationId: "createProxyHost",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ProxyHostInput" },
            },
          },
        },
        responses: {
          "201": {
            description: "Proxy host created",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ProxyHost" },
              },
            },
          },
          "400": { $ref: "#/components/responses/BadRequest" },
          "401": { $ref: "#/components/responses/Unauthorized" },
        },
      },
    },
    "/api/v1/proxy-hosts/{id}": {
      get: {
        tags: ["Proxy Hosts"],
        summary: "Get a proxy host",
        operationId: "getProxyHost",
        parameters: [{ $ref: "#/components/parameters/HostPath" }],
        responses: {
          "200": {
            description: "Proxy host",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ProxyHost" },
              },
            },
          },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
      put: {
        tags: ["Proxy Hosts"],
        summary: "Update a proxy host",
        operationId: "updateProxyHost",
        parameters: [{ $ref: "#/components/parameters/HostPath" }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ProxyHostInput" },
            },
          },
        },
        responses: {
          "200": {
            description: "Proxy host updated",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ProxyHost" },
              },
            },
          },
          "400": { $ref: "#/components/responses/BadRequest" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
      delete: {
        tags: ["Proxy Hosts"],
        summary: "Delete a proxy host",
        operationId: "deleteProxyHost",
        parameters: [{ $ref: "#/components/parameters/HostPath" }],
        responses: {
          "200": { $ref: "#/components/responses/Ok" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
    },

    "/api/v1/proxy-hosts/preview": {
      post: {
        tags: ["Proxy Hosts"],
        summary: "Preview creating a proxy host",
        description:
          "Runs every check the save runs and returns the field diff, secrets masked, and its impact: agents that reload, certificates requested, warnings. Stores nothing.",
        operationId: "previewProxyHostCreate",
        parameters: [{ $ref: "#/components/parameters/RevertQuery" }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ProxyHostInput" },
            },
          },
        },
        responses: {
          "200": {
            description: "What the save would change; nothing stored",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/HostChangePreview" },
              },
            },
          },
          "400": { $ref: "#/components/responses/BadRequest" },
          "401": { $ref: "#/components/responses/Unauthorized" },
        },
      },
    },
    "/api/v1/proxy-hosts/{id}/preview": {
      post: {
        tags: ["Proxy Hosts"],
        summary: "Preview updating a proxy host",
        description:
          "Runs every check the save runs and returns the field diff, secrets masked, and its impact: agents that reload, certificates requested, warnings. Stores nothing.",
        operationId: "previewProxyHostUpdate",
        parameters: [
          { $ref: "#/components/parameters/HostPath" },
          { $ref: "#/components/parameters/RevertQuery" },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ProxyHostInput" },
            },
          },
        },
        responses: {
          "200": {
            description: "What the save would change; nothing stored",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/HostChangePreview" },
              },
            },
          },
          "400": { $ref: "#/components/responses/BadRequest" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
    },

    "/api/v1/proxy-hosts/{id}/revisions": {
      get: {
        tags: ["Proxy Hosts"],
        summary: "List a proxy host's revisions",
        description:
          "Newest first, one per write. Summaries only: GraphQL's hostRevision answers a revision in full, and rollbackHost and restoreHost go back to one.",
        operationId: "listProxyHostRevisions",
        parameters: [
          { $ref: "#/components/parameters/HostPath" },
          { name: "limit", in: "query", schema: { type: "integer", default: 20, maximum: 200 } },
          { name: "offset", in: "query", schema: { type: "integer", default: 0 } },
        ],
        responses: {
          "200": {
            description: "One page of revisions and how many there are",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    items: { type: "array", items: { $ref: "#/components/schemas/HostRevision" } },
                    total: { type: "integer" },
                  },
                },
              },
            },
          },
          "401": { $ref: "#/components/responses/Unauthorized" },
        },
      },
    },

    "/api/v1/proxy-hosts/bulk": {
      post: {
        tags: ["Proxy Hosts"],
        summary: "Change many proxy hosts at once",
        description:
          "All or nothing: an unknown id or an invalid target refuses the whole batch and changes nothing. One audit row per host, then one Caddy apply.",
        operationId: "bulkProxyHosts",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ProxyHostBulkInput" },
            },
          },
        },
        responses: {
          "200": {
            description: "Every host changed",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/BulkResult" },
              },
            },
          },
          "400": { $ref: "#/components/responses/BadRequest" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
    },

    // ── L4 Proxy Hosts ──────────────────────────────────────────────
    "/api/v1/l4-proxy-hosts": {
      get: {
        tags: ["L4 Proxy Hosts"],
        summary: "List L4 proxy hosts",
        operationId: "listL4ProxyHosts",
        responses: {
          "200": {
            description: "List of L4 proxy hosts",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: { $ref: "#/components/schemas/L4ProxyHost" },
                },
              },
            },
          },
          "401": { $ref: "#/components/responses/Unauthorized" },
        },
      },
      post: {
        tags: ["L4 Proxy Hosts"],
        summary: "Create an L4 proxy host",
        operationId: "createL4ProxyHost",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/L4ProxyHostInput" },
            },
          },
        },
        responses: {
          "201": {
            description: "L4 proxy host created",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/L4ProxyHost" },
              },
            },
          },
          "400": { $ref: "#/components/responses/BadRequest" },
          "401": { $ref: "#/components/responses/Unauthorized" },
        },
      },
    },
    "/api/v1/l4-proxy-hosts/{id}": {
      get: {
        tags: ["L4 Proxy Hosts"],
        summary: "Get an L4 proxy host",
        operationId: "getL4ProxyHost",
        parameters: [{ $ref: "#/components/parameters/HostPath" }],
        responses: {
          "200": {
            description: "L4 proxy host",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/L4ProxyHost" },
              },
            },
          },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
      put: {
        tags: ["L4 Proxy Hosts"],
        summary: "Update an L4 proxy host",
        operationId: "updateL4ProxyHost",
        parameters: [{ $ref: "#/components/parameters/HostPath" }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/L4ProxyHostInput" },
            },
          },
        },
        responses: {
          "200": {
            description: "L4 proxy host updated",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/L4ProxyHost" },
              },
            },
          },
          "400": { $ref: "#/components/responses/BadRequest" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
      delete: {
        tags: ["L4 Proxy Hosts"],
        summary: "Delete an L4 proxy host",
        operationId: "deleteL4ProxyHost",
        parameters: [{ $ref: "#/components/parameters/HostPath" }],
        responses: {
          "200": { $ref: "#/components/responses/Ok" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
    },

    "/api/v1/l4-proxy-hosts/preview": {
      post: {
        tags: ["L4 Proxy Hosts"],
        summary: "Preview creating an L4 proxy host",
        description:
          "Runs every check the save runs and returns the field diff, secrets masked, and its impact: agents that reload, certificates requested, warnings. Stores nothing.",
        operationId: "previewL4ProxyHostCreate",
        parameters: [{ $ref: "#/components/parameters/RevertQuery" }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/L4ProxyHostInput" },
            },
          },
        },
        responses: {
          "200": {
            description: "What the save would change; nothing stored",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/HostChangePreview" },
              },
            },
          },
          "400": { $ref: "#/components/responses/BadRequest" },
          "401": { $ref: "#/components/responses/Unauthorized" },
        },
      },
    },
    "/api/v1/l4-proxy-hosts/{id}/preview": {
      post: {
        tags: ["L4 Proxy Hosts"],
        summary: "Preview updating an L4 proxy host",
        description:
          "Runs every check the save runs and returns the field diff, secrets masked, and its impact: agents that reload, certificates requested, warnings. Stores nothing.",
        operationId: "previewL4ProxyHostUpdate",
        parameters: [
          { $ref: "#/components/parameters/HostPath" },
          { $ref: "#/components/parameters/RevertQuery" },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/L4ProxyHostInput" },
            },
          },
        },
        responses: {
          "200": {
            description: "What the save would change; nothing stored",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/HostChangePreview" },
              },
            },
          },
          "400": { $ref: "#/components/responses/BadRequest" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
    },

    "/api/v1/l4-proxy-hosts/{id}/revisions": {
      get: {
        tags: ["L4 Proxy Hosts"],
        summary: "List an L4 proxy host's revisions",
        description:
          "Newest first, one per write. Summaries only: GraphQL's hostRevision answers a revision in full, and rollbackHost and restoreHost go back to one.",
        operationId: "listL4ProxyHostRevisions",
        parameters: [
          { $ref: "#/components/parameters/HostPath" },
          { name: "limit", in: "query", schema: { type: "integer", default: 20, maximum: 200 } },
          { name: "offset", in: "query", schema: { type: "integer", default: 0 } },
        ],
        responses: {
          "200": {
            description: "One page of revisions and how many there are",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    items: { type: "array", items: { $ref: "#/components/schemas/HostRevision" } },
                    total: { type: "integer" },
                  },
                },
              },
            },
          },
          "401": { $ref: "#/components/responses/Unauthorized" },
        },
      },
    },

    "/api/v1/l4-proxy-hosts/bulk": {
      post: {
        tags: ["L4 Proxy Hosts"],
        summary: "Change many L4 proxy hosts at once",
        description: "All or nothing, as for proxy hosts.",
        operationId: "bulkL4ProxyHosts",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/L4ProxyHostBulkInput" },
            },
          },
        },
        responses: {
          "200": {
            description: "Every host changed",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/BulkResult" },
              },
            },
          },
          "400": { $ref: "#/components/responses/BadRequest" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
    },

    // ── Certificates ────────────────────────────────────────────────
    "/api/v1/certificates": {
      get: {
        tags: ["Certificates"],
        summary: "List certificates",
        operationId: "listCertificates",
        responses: {
          "200": {
            description: "List of certificates",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: { $ref: "#/components/schemas/Certificate" },
                },
              },
            },
          },
          "401": { $ref: "#/components/responses/Unauthorized" },
        },
      },
      post: {
        tags: ["Certificates"],
        summary: "Create a certificate",
        description:
          "With `source: agent-file` the agent reads the two files first, and the certificate is created only if they parse and the key matches. Its names come from the certificate's SANs.",
        operationId: "createCertificate",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                oneOf: [
                  { $ref: "#/components/schemas/CertificateInput" },
                  { $ref: "#/components/schemas/AgentFileCertificateInput" },
                ],
              },
            },
          },
        },
        responses: {
          "201": {
            description: "Certificate created",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Certificate" },
              },
            },
          },
          "400": { $ref: "#/components/responses/BadRequest" },
          "401": { $ref: "#/components/responses/Unauthorized" },
        },
      },
    },
    "/api/v1/certificates/{id}": {
      get: {
        tags: ["Certificates"],
        summary: "Get a certificate",
        operationId: "getCertificate",
        parameters: [{ $ref: "#/components/parameters/IdPath" }],
        responses: {
          "200": {
            description: "Certificate",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Certificate" },
              },
            },
          },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
      put: {
        tags: ["Certificates"],
        summary: "Update a certificate",
        operationId: "updateCertificate",
        parameters: [{ $ref: "#/components/parameters/IdPath" }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/CertificateInput" },
            },
          },
        },
        responses: {
          "200": {
            description: "Certificate updated",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Certificate" },
              },
            },
          },
          "400": { $ref: "#/components/responses/BadRequest" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
      delete: {
        tags: ["Certificates"],
        summary: "Delete a certificate",
        description: "Refused with 409 while a proxy host or the dashboard host uses it.",
        operationId: "deleteCertificate",
        parameters: [{ $ref: "#/components/parameters/IdPath" }],
        responses: {
          "200": { $ref: "#/components/responses/Ok" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" },
          "409": { description: "A host still uses the certificate" },
        },
      },
    },
    "/api/v1/certificates/{id}/reread": {
      post: {
        tags: ["Certificates"],
        summary: "Read a file certificate again now",
        description:
          "Only for a certificate with `source: agent-file`. A failed read is recorded in `sourceError`, and the last good certificate keeps serving.",
        operationId: "rereadCertificate",
        parameters: [{ $ref: "#/components/parameters/IdPath" }],
        responses: {
          "200": {
            description: "The certificate after the read",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Certificate" },
              },
            },
          },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" },
          "409": { description: "The source agent is not connected" },
        },
      },
    },

    // ── CA Certificates ─────────────────────────────────────────────
    "/api/v1/ca-certificates": {
      get: {
        tags: ["CA Certificates"],
        summary: "List CA certificates",
        operationId: "listCaCertificates",
        responses: {
          "200": {
            description: "List of CA certificates",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: { $ref: "#/components/schemas/CaCertificate" },
                },
              },
            },
          },
          "401": { $ref: "#/components/responses/Unauthorized" },
        },
      },
      post: {
        tags: ["CA Certificates"],
        summary: "Create a CA certificate",
        operationId: "createCaCertificate",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/CaCertificateInput" },
            },
          },
        },
        responses: {
          "201": {
            description: "CA certificate created",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/CaCertificate" },
              },
            },
          },
          "400": { $ref: "#/components/responses/BadRequest" },
          "401": { $ref: "#/components/responses/Unauthorized" },
        },
      },
    },
    "/api/v1/ca-certificates/{id}": {
      get: {
        tags: ["CA Certificates"],
        summary: "Get a CA certificate",
        operationId: "getCaCertificate",
        parameters: [{ $ref: "#/components/parameters/IdPath" }],
        responses: {
          "200": {
            description: "CA certificate",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/CaCertificate" },
              },
            },
          },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
      put: {
        tags: ["CA Certificates"],
        summary: "Update a CA certificate",
        operationId: "updateCaCertificate",
        parameters: [{ $ref: "#/components/parameters/IdPath" }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/CaCertificateInput" },
            },
          },
        },
        responses: {
          "200": {
            description: "CA certificate updated",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/CaCertificate" },
              },
            },
          },
          "400": { $ref: "#/components/responses/BadRequest" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
      delete: {
        tags: ["CA Certificates"],
        summary: "Delete a CA certificate",
        operationId: "deleteCaCertificate",
        parameters: [{ $ref: "#/components/parameters/IdPath" }],
        responses: {
          "200": { $ref: "#/components/responses/Ok" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
    },

    // ── Client Certificates ─────────────────────────────────────────
    "/api/v1/client-certificates": {
      get: {
        tags: ["Client Certificates"],
        summary: "List client certificates",
        operationId: "listClientCertificates",
        responses: {
          "200": {
            description: "List of client certificates",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: { $ref: "#/components/schemas/ClientCertificate" },
                },
              },
            },
          },
          "401": { $ref: "#/components/responses/Unauthorized" },
        },
      },
      post: {
        tags: ["Client Certificates"],
        summary: "Create a client certificate",
        operationId: "createClientCertificate",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ClientCertificateInput" },
            },
          },
        },
        responses: {
          "201": {
            description: "Client certificate created",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ClientCertificate" },
              },
            },
          },
          "400": { $ref: "#/components/responses/BadRequest" },
          "401": { $ref: "#/components/responses/Unauthorized" },
        },
      },
    },
    "/api/v1/client-certificates/{id}": {
      get: {
        tags: ["Client Certificates"],
        summary: "Get a client certificate",
        operationId: "getClientCertificate",
        parameters: [{ $ref: "#/components/parameters/IdPath" }],
        responses: {
          "200": {
            description: "Client certificate",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ClientCertificate" },
              },
            },
          },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
      delete: {
        tags: ["Client Certificates"],
        summary: "Revoke a client certificate",
        operationId: "revokeClientCertificate",
        parameters: [{ $ref: "#/components/parameters/IdPath" }],
        responses: {
          "200": { $ref: "#/components/responses/Ok" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
    },

    "/api/v1/client-certificates/{id}/roles": {
      get: {
        tags: ["Client Certificates"],
        summary: "List the mTLS roles a client certificate holds",
        operationId: "listClientCertificateRoles",
        parameters: [{ $ref: "#/components/parameters/IdPath" }],
        responses: {
          "200": {
            description: "Roles",
            content: {
              "application/json": {
                schema: { type: "array", items: { $ref: "#/components/schemas/MtlsRole" } },
              },
            },
          },
          "401": { $ref: "#/components/responses/Unauthorized" },
        },
      },
    },

    // ── mTLS access rules ───────────────────────────────────────────
    "/api/v1/proxy-hosts/{id}/mtls-access-rules": {
      get: {
        tags: ["Proxy Hosts"],
        summary: "List a host's mTLS access rules",
        operationId: "listMtlsAccessRules",
        parameters: [{ $ref: "#/components/parameters/IdPath" }],
        responses: {
          "200": {
            description: "Rules, in priority order",
            content: {
              "application/json": {
                schema: { type: "array", items: { $ref: "#/components/schemas/MtlsAccessRule" } },
              },
            },
          },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
      post: {
        tags: ["Proxy Hosts"],
        summary: "Add an mTLS access rule to a host",
        operationId: "createMtlsAccessRule",
        parameters: [{ $ref: "#/components/parameters/IdPath" }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/MtlsAccessRuleInput" },
            },
          },
        },
        responses: {
          "201": {
            description: "The rule",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/MtlsAccessRule" } },
            },
          },
          "400": { $ref: "#/components/responses/BadRequest" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
    },
    "/api/v1/proxy-hosts/{id}/mtls-access-rules/{ruleId}": {
      get: {
        tags: ["Proxy Hosts"],
        summary: "Get an mTLS access rule",
        operationId: "getMtlsAccessRule",
        parameters: [
          { $ref: "#/components/parameters/IdPath" },
          { $ref: "#/components/parameters/RuleIdPath" },
        ],
        responses: {
          "200": {
            description: "The rule",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/MtlsAccessRule" } },
            },
          },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
      put: {
        tags: ["Proxy Hosts"],
        summary: "Update an mTLS access rule",
        operationId: "updateMtlsAccessRule",
        parameters: [
          { $ref: "#/components/parameters/IdPath" },
          { $ref: "#/components/parameters/RuleIdPath" },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/MtlsAccessRuleInput" },
            },
          },
        },
        responses: {
          "200": {
            description: "The rule",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/MtlsAccessRule" } },
            },
          },
          "400": { $ref: "#/components/responses/BadRequest" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
      delete: {
        tags: ["Proxy Hosts"],
        summary: "Delete an mTLS access rule",
        operationId: "deleteMtlsAccessRule",
        parameters: [
          { $ref: "#/components/parameters/IdPath" },
          { $ref: "#/components/parameters/RuleIdPath" },
        ],
        responses: {
          "200": { $ref: "#/components/responses/Ok" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
    },

    // ── DNS providers ───────────────────────────────────────────────
    "/api/v1/dns-providers": {
      get: {
        tags: ["Settings"],
        summary: "List the DNS providers the controller knows",
        description:
          "The catalog of DNS-01 providers with the fields each takes. Credentials are saved through the dns-provider settings group and never returned.",
        operationId: "listDnsProviders",
        responses: {
          "200": {
            description: "Provider definitions",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: { $ref: "#/components/schemas/DnsProviderDefinition" },
                },
              },
            },
          },
          "401": { $ref: "#/components/responses/Unauthorized" },
        },
      },
    },

    // ── Access Lists ────────────────────────────────────────────────
    "/api/v1/access-lists": {
      get: {
        tags: ["Access Lists"],
        summary: "List access lists",
        operationId: "listAccessLists",
        responses: {
          "200": {
            description: "List of access lists",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: { $ref: "#/components/schemas/AccessList" },
                },
              },
            },
          },
          "401": { $ref: "#/components/responses/Unauthorized" },
        },
      },
      post: {
        tags: ["Access Lists"],
        summary: "Create an access list",
        operationId: "createAccessList",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/AccessListInput" },
            },
          },
        },
        responses: {
          "201": {
            description: "Access list created",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/AccessList" },
              },
            },
          },
          "400": { $ref: "#/components/responses/BadRequest" },
          "401": { $ref: "#/components/responses/Unauthorized" },
        },
      },
    },
    "/api/v1/access-lists/{id}": {
      get: {
        tags: ["Access Lists"],
        summary: "Get an access list",
        operationId: "getAccessList",
        parameters: [{ $ref: "#/components/parameters/IdPath" }],
        responses: {
          "200": {
            description: "Access list",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/AccessList" },
              },
            },
          },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
      put: {
        tags: ["Access Lists"],
        summary: "Update an access list",
        operationId: "updateAccessList",
        parameters: [{ $ref: "#/components/parameters/IdPath" }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/AccessListInput" },
            },
          },
        },
        responses: {
          "200": {
            description: "Access list updated",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/AccessList" },
              },
            },
          },
          "400": { $ref: "#/components/responses/BadRequest" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
      delete: {
        tags: ["Access Lists"],
        summary: "Delete an access list",
        description:
          "Refused with 409 while a proxy host, one of its location rules, an L4 host, or the dashboard host uses it.",
        operationId: "deleteAccessList",
        parameters: [{ $ref: "#/components/parameters/IdPath" }],
        responses: {
          "200": { $ref: "#/components/responses/Ok" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" },
          "409": { description: "A host still uses the access list" },
        },
      },
    },
    "/api/v1/access-lists/{id}/entries": {
      post: {
        tags: ["Access Lists"],
        summary: "Add an entry to an access list",
        operationId: "addAccessListEntry",
        parameters: [{ $ref: "#/components/parameters/IdPath" }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  username: { type: "string" },
                  password: { type: "string" },
                },
                required: ["username", "password"],
              },
            },
          },
        },
        responses: {
          "201": {
            description: "Entry added",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/AccessListEntry" },
              },
            },
          },
          "400": { $ref: "#/components/responses/BadRequest" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
    },
    "/api/v1/backup": {
      post: {
        tags: ["Backup"],
        summary: "Download a backup of the whole configuration",
        description:
          "Every secret the database holds is decrypted into the file, and the file is encrypted with the passphrase sent. Restoring is done from Settings > Backup, which asks for a recent sign-in.",
        operationId: "createBackup",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  passphrase: { type: "string", minLength: 12 },
                  auditLog: { type: "boolean", description: "Include the audit log" },
                  settingsHistory: { type: "boolean", description: "Include the settings history" },
                },
                required: ["passphrase"],
              },
            },
          },
        },
        responses: {
          "200": {
            description: "The backup file",
            content: {
              "application/octet-stream": { schema: { type: "string", format: "binary" } },
            },
          },
          "400": { $ref: "#/components/responses/BadRequest" },
          "401": { $ref: "#/components/responses/Unauthorized" },
        },
      },
    },
    "/api/v1/access-lists/{id}/ip-rules": {
      get: {
        tags: ["Access Lists"],
        summary: "List an access list's IP rules, in the order they are checked",
        operationId: "getAccessListIpRules",
        parameters: [{ $ref: "#/components/parameters/IdPath" }],
        responses: {
          "200": {
            description: "The rules",
            content: {
              "application/json": {
                schema: { type: "array", items: { $ref: "#/components/schemas/AccessListIpRule" } },
              },
            },
          },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
      put: {
        tags: ["Access Lists"],
        summary: "Replace an access list's IP rules",
        description:
          "The array sent becomes the whole set, in its order. An empty array removes every rule, and is refused with 409 while an L4 host uses the list. A hostname no cached answer knows is looked up before the response, for up to 3 seconds; a slower one is left to the background refresh.",
        operationId: "setAccessListIpRules",
        parameters: [{ $ref: "#/components/parameters/IdPath" }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { type: "array", items: { $ref: "#/components/schemas/AccessListIpRule" } },
            },
          },
        },
        responses: {
          "200": {
            description: "The rules as stored",
            content: {
              "application/json": {
                schema: { type: "array", items: { $ref: "#/components/schemas/AccessListIpRule" } },
              },
            },
          },
          "400": { $ref: "#/components/responses/BadRequest" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" },
          "409": {
            description: "An L4 host uses the list, and emptying it would close every connection",
          },
        },
      },
    },
    "/api/v1/access-lists/{id}/entries/{entryId}": {
      delete: {
        tags: ["Access Lists"],
        summary: "Remove an entry from an access list",
        operationId: "removeAccessListEntry",
        parameters: [
          { $ref: "#/components/parameters/IdPath" },
          {
            name: "entryId",
            in: "path",
            required: true,
            schema: { type: "integer" },
            description: "Entry ID",
          },
        ],
        responses: {
          "200": { $ref: "#/components/responses/Ok" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
    },

    // ── Settings ────────────────────────────────────────────────────
    "/api/v1/settings/{group}": {
      get: {
        tags: ["Settings"],
        summary: "Get settings for a group",
        operationId: "getSettings",
        parameters: [
          {
            name: "group",
            in: "path",
            required: true,
            schema: {
              type: "string",
              enum: [...SETTINGS_GROUPS],
            },
            description: "Settings group name",
          },
        ],
        responses: {
          "200": {
            description: "Settings object (shape varies by group).",
            content: {
              "application/json": {
                schema: {
                  oneOf: [
                    { $ref: "#/components/schemas/GeneralSettings" },
                    { $ref: "#/components/schemas/CloudflareStatus" },
                    { $ref: "#/components/schemas/DnsProviderStatus" },
                    { $ref: "#/components/schemas/AuthentikSettings" },
                    { $ref: "#/components/schemas/MetricsSettings" },
                    { $ref: "#/components/schemas/LoggingSettings" },
                    { $ref: "#/components/schemas/DnsSettings" },
                    { $ref: "#/components/schemas/UpstreamDnsSettings" },
                    { $ref: "#/components/schemas/GeoBlockConfig" },
                    { $ref: "#/components/schemas/WafSettings" },
                    { $ref: "#/components/schemas/DefaultResponseSettings" },
                    { $ref: "#/components/schemas/TailscaleSettingsStatus" },
                    { $ref: "#/components/schemas/HttpCacheSettingsStatus" },
                    { $ref: "#/components/schemas/CrowdSecSettingsStatus" },
                  ],
                },
              },
            },
          },
          "401": { $ref: "#/components/responses/Unauthorized" },
        },
      },
      put: {
        tags: ["Settings"],
        summary: "Update settings for a group",
        operationId: "updateSettings",
        parameters: [
          {
            name: "group",
            in: "path",
            required: true,
            schema: {
              type: "string",
              enum: [...SETTINGS_GROUPS],
            },
            description: "Settings group name",
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                oneOf: [
                  { $ref: "#/components/schemas/GeneralSettings" },
                  { $ref: "#/components/schemas/CloudflareSettings" },
                  { $ref: "#/components/schemas/AuthentikSettings" },
                  { $ref: "#/components/schemas/MetricsSettings" },
                  { $ref: "#/components/schemas/LoggingSettings" },
                  { $ref: "#/components/schemas/DnsSettings" },
                  { $ref: "#/components/schemas/DnsProviderSettings" },
                  { $ref: "#/components/schemas/UpstreamDnsSettings" },
                  { $ref: "#/components/schemas/GeoBlockConfig" },
                  { $ref: "#/components/schemas/WafSettings" },
                  { $ref: "#/components/schemas/DefaultResponseSettings" },
                  { $ref: "#/components/schemas/TailscaleSettings" },
                  { $ref: "#/components/schemas/HttpCacheSettings" },
                  { $ref: "#/components/schemas/CrowdSecSettings" },
                ],
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Settings updated",
            content: {
              "application/json": { schema: { $ref: "#/components/responses/Ok" } },
            },
          },
          "400": { $ref: "#/components/responses/BadRequest" },
          "401": { $ref: "#/components/responses/Unauthorized" },
        },
      },
    },

    // ── Users ───────────────────────────────────────────────────────
    "/api/v1/users": {
      get: {
        tags: ["Users"],
        summary: "List users",
        operationId: "listUsers",
        responses: {
          "200": {
            description: "List of users",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: { $ref: "#/components/schemas/User" },
                },
              },
            },
          },
          "401": { $ref: "#/components/responses/Unauthorized" },
        },
      },
      post: {
        tags: ["Users"],
        summary: "Create a user",
        operationId: "createUser",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  email: {
                    type: "string",
                    description:
                      "Stored trimmed and lowercased. Fails with 400 when another account has it (in any case) or " +
                      "signs in with it as username (for a @localhost address, also with the part before " +
                      "it), or when lowercasing turns a character into an ASCII letter (such as the Kelvin sign)",
                  },
                  password: { type: "string" },
                  name: { type: ["string", "null"] },
                  role: {
                    type: "string",
                    enum: ["admin", "operator", "user", "viewer"],
                    default: "user",
                  },
                  username: {
                    type: "string",
                    description:
                      "Username for the login page, which signs in by username only, ignoring case. Surrounding " +
                      "whitespace is removed; the rest must be 3-255 characters of lowercase letters (a-z), " +
                      "digits and _ . @ -, and must not be another account's username, email address or " +
                      "forward-auth portal name (the email <name>@localhost), compared case-insensitively." +
                      " Optional: without it the user gets their email address as username only when it " +
                      "qualifies. Otherwise the request fails with 400 and no user is created.",
                  },
                },
                required: ["email", "password"],
              },
            },
          },
        },
        responses: {
          "201": {
            description: "User created",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/User" },
              },
            },
          },
          "400": { $ref: "#/components/responses/BadRequest" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "403": { $ref: "#/components/responses/Forbidden" },
        },
      },
    },
    "/api/v1/users/{id}": {
      get: {
        tags: ["Users"],
        summary: "Get a user",
        operationId: "getUser",
        parameters: [{ $ref: "#/components/parameters/IdPath" }],
        responses: {
          "200": {
            description: "User",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/User" },
              },
            },
          },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
      put: {
        tags: ["Users"],
        summary: "Update a user",
        operationId: "updateUser",
        parameters: [{ $ref: "#/components/parameters/IdPath" }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  name: { type: ["string", "null"] },
                  email: {
                    type: "string",
                    description:
                      "Changing it leaves username unchanged. " +
                      "Stored trimmed and lowercased. Fails with 400 when another account has it (in any case) or " +
                      "signs in with it as username (for a @localhost address, also with the part before " +
                      "it), or when lowercasing turns a character into an ASCII letter (such as the Kelvin sign)",
                  },
                  username: {
                    type: ["string", "null"],
                    description:
                      "Username for the login page, which signs in by username only, ignoring case. Surrounding " +
                      "whitespace is removed; the rest must be 3-255 characters of lowercase letters (a-z), " +
                      "digits and _ . @ -, and must not be another account's username, email address or " +
                      "forward-auth portal name (the email <name>@localhost), compared case-insensitively." +
                      " The username the user already has, or null, is no change. Otherwise the request " +
                      "fails with 400, and a request refused with 400 changes no field. Audited.",
                  },
                  role: { type: "string", enum: ["admin", "operator", "user", "viewer"] },
                  status: { type: "string", enum: ["active", "disabled"] },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "User updated",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/User" },
              },
            },
          },
          "400": { $ref: "#/components/responses/BadRequest" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "403": { $ref: "#/components/responses/Forbidden" },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
    },

    // ── Audit Log ───────────────────────────────────────────────────
    "/api/v1/audit-log": {
      get: {
        tags: ["Audit Log"],
        summary: "List audit log events",
        operationId: "listAuditLog",
        parameters: [
          {
            name: "page",
            in: "query",
            schema: { type: "integer", default: 1 },
            description: "Page number",
          },
          {
            name: "per_page",
            in: "query",
            schema: { type: "integer", default: 50 },
            description: "Items per page",
          },
          {
            name: "search",
            in: "query",
            schema: { type: "string" },
            description: "Search term",
          },
        ],
        responses: {
          "200": {
            description: "Paginated audit log",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/AuditLogResponse" },
              },
            },
          },
          "401": { $ref: "#/components/responses/Unauthorized" },
        },
      },
    },

    // ── Groups ──────────────────────────────────────────────────────
    "/api/v1/groups": {
      get: {
        tags: ["Groups"],
        summary: "List groups",
        operationId: "listGroups",
        responses: {
          "200": {
            description: "List of groups",
            content: {
              "application/json": {
                schema: { type: "array", items: { $ref: "#/components/schemas/Group" } },
              },
            },
          },
          "401": { $ref: "#/components/responses/Unauthorized" },
        },
      },
      post: {
        tags: ["Groups"],
        summary: "Create a group",
        operationId: "createGroup",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["name"],
                properties: { name: { type: "string" }, description: { type: "string" } },
              },
            },
          },
        },
        responses: {
          "201": {
            description: "Group created",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Group" } } },
          },
          "401": { $ref: "#/components/responses/Unauthorized" },
        },
      },
    },
    "/api/v1/groups/{id}": {
      get: {
        tags: ["Groups"],
        summary: "Get a group",
        operationId: "getGroup",
        parameters: [{ $ref: "#/components/parameters/IdPath" }],
        responses: {
          "200": {
            description: "Group details",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Group" } } },
          },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
      patch: {
        tags: ["Groups"],
        summary: "Update a group",
        operationId: "updateGroup",
        parameters: [{ $ref: "#/components/parameters/IdPath" }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { name: { type: "string" }, description: { type: "string" } },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Group updated",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Group" } } },
          },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
      delete: {
        tags: ["Groups"],
        summary: "Delete a group",
        operationId: "deleteGroup",
        parameters: [{ $ref: "#/components/parameters/IdPath" }],
        responses: {
          "200": { $ref: "#/components/responses/Ok" },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
    },
    "/api/v1/groups/{id}/members": {
      post: {
        tags: ["Groups"],
        summary: "Add a member to a group",
        operationId: "addGroupMember",
        parameters: [{ $ref: "#/components/parameters/IdPath" }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["userId"],
                properties: { userId: { type: "integer" } },
              },
            },
          },
        },
        responses: {
          "200": { $ref: "#/components/responses/Ok" },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
    },
    "/api/v1/groups/{id}/members/{userId}": {
      delete: {
        tags: ["Groups"],
        summary: "Remove a member from a group",
        operationId: "removeGroupMember",
        parameters: [
          { $ref: "#/components/parameters/IdPath" },
          {
            name: "userId",
            in: "path",
            required: true,
            schema: { type: "integer" },
            description: "User ID to remove",
          },
        ],
        responses: {
          "200": { $ref: "#/components/responses/Ok" },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
    },

    // ── mTLS Roles ─────────────────────────────────────────────────
    "/api/v1/waf-presets": {
      get: {
        tags: ["WAF Presets"],
        summary: "List WAF presets",
        operationId: "listWafPresets",
        responses: {
          "200": {
            description: "List of presets",
            content: {
              "application/json": {
                schema: { type: "array", items: { $ref: "#/components/schemas/WafPreset" } },
              },
            },
          },
          "401": { $ref: "#/components/responses/Unauthorized" },
        },
      },
      post: {
        tags: ["WAF Presets"],
        summary: "Create a WAF preset",
        operationId: "createWafPreset",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["name", "directives"],
                properties: {
                  name: { type: "string" },
                  description: { type: ["string", "null"] },
                  directives: {
                    type: "string",
                    description:
                      "SecRule, SecAction, SecMarker and SecDefaultAction only - the custom-directive allowlist. A write that would drop a directive is refused.",
                  },
                },
              },
            },
          },
        },
        responses: {
          "201": {
            description: "Preset created",
            content: { "application/json": { schema: { $ref: "#/components/schemas/WafPreset" } } },
          },
          "400": { $ref: "#/components/responses/BadRequest" },
          "401": { $ref: "#/components/responses/Unauthorized" },
        },
      },
    },
    "/api/v1/waf-presets/{id}": {
      get: {
        tags: ["WAF Presets"],
        summary: "Get a WAF preset",
        operationId: "getWafPreset",
        parameters: [{ $ref: "#/components/parameters/IdPath" }],
        responses: {
          "200": {
            description: "Preset details",
            content: { "application/json": { schema: { $ref: "#/components/schemas/WafPreset" } } },
          },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
      put: {
        tags: ["WAF Presets"],
        summary: "Update a WAF preset",
        description:
          "Applies the Caddy config when a host or the global settings select the preset.",
        operationId: "updateWafPreset",
        parameters: [{ $ref: "#/components/parameters/IdPath" }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  description: { type: ["string", "null"] },
                  directives: {
                    type: "string",
                    description:
                      "SecRule, SecAction, SecMarker and SecDefaultAction only - the custom-directive allowlist. A write that would drop a directive is refused.",
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Preset updated",
            content: { "application/json": { schema: { $ref: "#/components/schemas/WafPreset" } } },
          },
          "400": { $ref: "#/components/responses/BadRequest" },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
      delete: {
        tags: ["WAF Presets"],
        summary: "Delete a WAF preset",
        description: "Refused with 409 while the global settings or any host still select it.",
        operationId: "deleteWafPreset",
        parameters: [{ $ref: "#/components/parameters/IdPath" }],
        responses: {
          "200": { $ref: "#/components/responses/Ok" },
          "404": { $ref: "#/components/responses/NotFound" },
          "409": { description: "The preset is still selected" },
        },
      },
    },
    "/api/v1/crs-plugins": {
      get: {
        tags: ["CRS Plugins"],
        summary: "List installed CRS plugins",
        operationId: "listCrsPlugins",
        responses: {
          "200": {
            description: "Installed plugins",
            content: {
              "application/json": {
                schema: { type: "array", items: { $ref: "#/components/schemas/CrsPlugin" } },
              },
            },
          },
          "401": { $ref: "#/components/responses/Unauthorized" },
        },
      },
      post: {
        tags: ["CRS Plugins"],
        summary: "Install a CRS plugin",
        description:
          "Fetches the plugin's latest release from GitHub. Refused when a rule needs a Lua script or data file, uses a directive outside the plugin allowlist, or defines a rule id outside the plugin's registered range.",
        operationId: "installCrsPlugin",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["name"],
                properties: {
                  name: { type: "string", description: "The registry's plugin name" },
                  registry: {
                    type: "string",
                    description:
                      "The id of the registry listing it. Needed only when several registries list the name.",
                  },
                },
              },
            },
          },
        },
        responses: {
          "201": {
            description: "Plugin installed",
            content: { "application/json": { schema: { $ref: "#/components/schemas/CrsPlugin" } } },
          },
          "400": { $ref: "#/components/responses/BadRequest" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { description: "No plugin of that name in the registry" },
          "409": { description: "Already installed" },
        },
      },
    },
    "/api/v1/crs-plugins/registry": {
      get: {
        tags: ["CRS Plugins"],
        summary: "List the CRS plugin registries' plugins",
        description:
          "Every configured registry's public entries, from the last read: a registry not read yet is read now. Each carries the verdict of the last check and the id it is installed under.",
        operationId: "listCrsRegistry",
        responses: {
          "200": {
            description: "Registry entries",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      registryId: { type: "string" },
                      registryName: { type: "string" },
                      name: { type: "string" },
                      repository: { type: "string", format: "uri" },
                      type: { type: "string", enum: ["official", "3rd-party"] },
                      status: {
                        type: "string",
                        enum: ["tested", "being-tested", "untested", "draft"],
                      },
                      license: { type: "string" },
                      ruleIdStart: { type: "integer" },
                      ruleIdEnd: { type: "integer" },
                      installedId: { type: ["integer", "null"] },
                      unsupported: {
                        type: ["string", "null"],
                        enum: [
                          "files",
                          "engine",
                          "compile",
                          "ruleIds",
                          "noRules",
                          "directives",
                          null,
                        ],
                        description:
                          "Why the last check found it cannot install here, or null: installable, or not checked yet",
                      },
                      checkedVersion: {
                        type: ["string", "null"],
                        description: "The release the verdict is for",
                      },
                    },
                  },
                },
              },
            },
          },
          "400": { $ref: "#/components/responses/BadRequest" },
          "401": { $ref: "#/components/responses/Unauthorized" },
        },
      },
    },
    "/api/v1/crs-plugins/registry/settings": {
      get: {
        tags: ["CRS Plugins"],
        summary: "Get the CRS plugin registry settings",
        operationId: "getCrsRegistrySettings",
        responses: {
          "200": {
            description: "Registry settings",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/CrsRegistrySettings" } },
            },
          },
          "401": { $ref: "#/components/responses/Unauthorized" },
        },
      },
      put: {
        tags: ["CRS Plugins"],
        summary: "Update the CRS plugin registry settings",
        description:
          "Fields left out keep their value. A change of registries or token starts a check in the background.",
        operationId: "updateCrsRegistrySettings",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  registries: {
                    type: "array",
                    maxItems: 10,
                    description:
                      "The full list. An entry without an id is new; a registry left out is removed.",
                    items: {
                      type: "object",
                      required: ["name", "url"],
                      properties: {
                        id: { type: ["string", "null"] },
                        name: { type: "string", maxLength: 64 },
                        url: { type: "string", format: "uri", description: "https only" },
                      },
                    },
                  },
                  refreshIntervalHours: {
                    type: "integer",
                    minimum: 0,
                    maximum: 720,
                    description: "0 checks only on demand",
                  },
                  githubToken: {
                    type: "string",
                    description: "Write-only. An empty string removes the stored token.",
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Settings as saved",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/CrsRegistrySettings" } },
            },
          },
          "400": { $ref: "#/components/responses/BadRequest" },
          "401": { $ref: "#/components/responses/Unauthorized" },
        },
      },
    },
    "/api/v1/crs-plugins/registry/check": {
      post: {
        tags: ["CRS Plugins"],
        summary: "Check the CRS plugin registries now",
        description:
          "Re-reads every registry and checks each plugin's latest release the way an install would, answering once the pass is done. Only releases not checked before are fetched. The checks are static: whether Coraza compiles a plugin is not tested.",
        operationId: "checkCrsRegistry",
        responses: {
          "200": { description: "The pass's outcome and the listing it produced" },
          "401": { $ref: "#/components/responses/Unauthorized" },
        },
      },
    },
    "/api/v1/crs-plugins/{id}": {
      get: {
        tags: ["CRS Plugins"],
        summary: "Get an installed CRS plugin",
        operationId: "getCrsPlugin",
        parameters: [{ $ref: "#/components/parameters/IdPath" }],
        responses: {
          "200": {
            description: "Plugin details",
            content: { "application/json": { schema: { $ref: "#/components/schemas/CrsPlugin" } } },
          },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
      put: {
        tags: ["CRS Plugins"],
        summary: "Edit a CRS plugin's configuration",
        description:
          "Replaces the plugin's -config file. null or an empty string restores the upstream one. Applies the Caddy config when anything selects the plugin.",
        operationId: "setCrsPluginConfig",
        parameters: [{ $ref: "#/components/parameters/IdPath" }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["config"],
                properties: { config: { type: ["string", "null"] } },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Configuration saved",
            content: { "application/json": { schema: { $ref: "#/components/schemas/CrsPlugin" } } },
          },
          "400": { $ref: "#/components/responses/BadRequest" },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
      delete: {
        tags: ["CRS Plugins"],
        summary: "Uninstall a CRS plugin",
        description: "Refused with 409 while the global settings or any host still select it.",
        operationId: "uninstallCrsPlugin",
        parameters: [{ $ref: "#/components/parameters/IdPath" }],
        responses: {
          "200": { $ref: "#/components/responses/Ok" },
          "404": { $ref: "#/components/responses/NotFound" },
          "409": { description: "The plugin is still selected" },
        },
      },
    },
    "/api/v1/crs-plugins/{id}/update": {
      post: {
        tags: ["CRS Plugins"],
        summary: "Update a CRS plugin to its latest release",
        description: "A no-op when it is current. An edited configuration is kept.",
        operationId: "updateCrsPlugin",
        parameters: [{ $ref: "#/components/parameters/IdPath" }],
        responses: {
          "200": {
            description: "Plugin as now installed",
            content: { "application/json": { schema: { $ref: "#/components/schemas/CrsPlugin" } } },
          },
          "400": { $ref: "#/components/responses/BadRequest" },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
    },
    "/api/v1/mtls-roles": {
      get: {
        tags: ["mTLS Roles"],
        summary: "List mTLS roles",
        operationId: "listMtlsRoles",
        responses: {
          "200": {
            description: "List of roles",
            content: {
              "application/json": {
                schema: { type: "array", items: { $ref: "#/components/schemas/MtlsRole" } },
              },
            },
          },
          "401": { $ref: "#/components/responses/Unauthorized" },
        },
      },
      post: {
        tags: ["mTLS Roles"],
        summary: "Create an mTLS role",
        operationId: "createMtlsRole",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["name"],
                properties: { name: { type: "string" }, description: { type: "string" } },
              },
            },
          },
        },
        responses: {
          "201": {
            description: "Role created",
            content: { "application/json": { schema: { $ref: "#/components/schemas/MtlsRole" } } },
          },
          "401": { $ref: "#/components/responses/Unauthorized" },
        },
      },
    },
    "/api/v1/mtls-roles/{id}": {
      get: {
        tags: ["mTLS Roles"],
        summary: "Get an mTLS role",
        operationId: "getMtlsRole",
        parameters: [{ $ref: "#/components/parameters/IdPath" }],
        responses: {
          "200": {
            description: "Role details",
            content: { "application/json": { schema: { $ref: "#/components/schemas/MtlsRole" } } },
          },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
      put: {
        tags: ["mTLS Roles"],
        summary: "Update an mTLS role",
        operationId: "updateMtlsRole",
        parameters: [{ $ref: "#/components/parameters/IdPath" }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { name: { type: "string" }, description: { type: "string" } },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Role updated",
            content: { "application/json": { schema: { $ref: "#/components/schemas/MtlsRole" } } },
          },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
      delete: {
        tags: ["mTLS Roles"],
        summary: "Delete an mTLS role",
        operationId: "deleteMtlsRole",
        parameters: [{ $ref: "#/components/parameters/IdPath" }],
        responses: {
          "200": { $ref: "#/components/responses/Ok" },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
    },
    "/api/v1/mtls-roles/{id}/certificates": {
      post: {
        tags: ["mTLS Roles"],
        summary: "Assign a certificate to an mTLS role",
        operationId: "assignMtlsRoleCertificate",
        parameters: [{ $ref: "#/components/parameters/IdPath" }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["certificateId"],
                properties: { certificateId: { type: "integer" } },
              },
            },
          },
        },
        responses: {
          "200": { $ref: "#/components/responses/Ok" },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
    },
    "/api/v1/mtls-roles/{id}/certificates/{certId}": {
      delete: {
        tags: ["mTLS Roles"],
        summary: "Remove a certificate from an mTLS role",
        operationId: "removeMtlsRoleCertificate",
        parameters: [
          { $ref: "#/components/parameters/IdPath" },
          {
            name: "certId",
            in: "path",
            required: true,
            schema: { type: "integer" },
            description: "Client certificate ID",
          },
        ],
        responses: {
          "200": { $ref: "#/components/responses/Ok" },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
    },

    // ── Forward Auth ───────────────────────────────────────────────
    "/api/v1/proxy-hosts/{id}/forward-auth-access": {
      get: {
        tags: ["Forward Auth"],
        summary: "Get forward auth access list for a proxy host",
        operationId: "getForwardAuthAccess",
        parameters: [{ $ref: "#/components/parameters/HostPath" }],
        responses: {
          "200": {
            description: "Access list with user IDs and group IDs",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    userIds: { type: "array", items: { type: "integer" } },
                    groupIds: { type: "array", items: { type: "integer" } },
                  },
                },
              },
            },
          },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
      put: {
        tags: ["Forward Auth"],
        summary: "Set forward auth access list for a proxy host",
        operationId: "setForwardAuthAccess",
        parameters: [{ $ref: "#/components/parameters/HostPath" }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  userIds: { type: "array", items: { type: "integer" } },
                  groupIds: { type: "array", items: { type: "integer" } },
                },
              },
            },
          },
        },
        responses: {
          "200": { $ref: "#/components/responses/Ok" },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
    },
    "/api/v1/forward-auth-sessions": {
      get: {
        tags: ["Forward Auth"],
        summary: "List forward auth sessions",
        operationId: "listForwardAuthSessions",
        parameters: [
          {
            name: "userId",
            in: "query",
            schema: { type: "integer" },
            description: "Filter by user ID",
          },
        ],
        responses: {
          "200": {
            description: "List of sessions",
            content: {
              "application/json": { schema: { type: "array", items: { type: "object" } } },
            },
          },
          "401": { $ref: "#/components/responses/Unauthorized" },
        },
      },
      delete: {
        tags: ["Forward Auth"],
        summary: "Delete forward auth sessions",
        operationId: "deleteForwardAuthSessions",
        parameters: [
          {
            name: "userId",
            in: "query",
            schema: { type: "integer" },
            description: "Delete sessions for a specific user",
          },
        ],
        responses: {
          "200": { $ref: "#/components/responses/Ok" },
          "401": { $ref: "#/components/responses/Unauthorized" },
        },
      },
    },
    "/api/v1/forward-auth-sessions/{id}": {
      delete: {
        tags: ["Forward Auth"],
        summary: "Delete a specific forward auth session",
        operationId: "deleteForwardAuthSession",
        parameters: [{ $ref: "#/components/parameters/IdPath" }],
        responses: {
          "200": { $ref: "#/components/responses/Ok" },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
    },

    // ── Caddy ───────────────────────────────────────────────────────
    "/api/v1/caddy/apply": {
      post: {
        tags: ["Caddy"],
        summary: "Apply Caddy configuration",
        operationId: "applyCaddyConfig",
        responses: {
          "200": { $ref: "#/components/responses/Ok" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "500": { $ref: "#/components/responses/InternalError" },
        },
      },
    },

    // ── OAuth Providers ─────────────────────────────────────────────
    "/api/v1/oauth-providers": {
      get: {
        tags: ["OAuth Providers"],
        summary: "List OAuth providers",
        operationId: "listOauthProviders",
        responses: {
          "200": {
            description: "List of OAuth providers",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: { $ref: "#/components/schemas/OauthProvider" },
                },
              },
            },
          },
          "401": { $ref: "#/components/responses/Unauthorized" },
        },
      },
      post: {
        tags: ["OAuth Providers"],
        summary: "Create an OAuth provider",
        operationId: "createOauthProvider",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/OauthProviderInput" },
            },
          },
        },
        responses: {
          "201": {
            description: "OAuth provider created",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/OauthProvider" },
              },
            },
          },
          "400": { $ref: "#/components/responses/BadRequest" },
          "401": { $ref: "#/components/responses/Unauthorized" },
        },
      },
    },
    "/api/v1/oauth-providers/{id}": {
      get: {
        tags: ["OAuth Providers"],
        summary: "Get an OAuth provider",
        operationId: "getOauthProvider",
        parameters: [{ $ref: "#/components/parameters/IdPath" }],
        responses: {
          "200": {
            description: "OAuth provider",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/OauthProvider" },
              },
            },
          },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
      put: {
        tags: ["OAuth Providers"],
        summary: "Update an OAuth provider",
        description:
          "Environment-sourced providers only allow toggling `enabled`. A blank or omitted clientSecret preserves the stored secret.",
        operationId: "updateOauthProvider",
        parameters: [{ $ref: "#/components/parameters/IdPath" }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/OauthProviderUpdate" },
            },
          },
        },
        responses: {
          "200": {
            description: "OAuth provider updated",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/OauthProvider" },
              },
            },
          },
          "400": { $ref: "#/components/responses/BadRequest" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
      delete: {
        tags: ["OAuth Providers"],
        summary: "Delete an OAuth provider",
        description: "Environment-sourced providers cannot be deleted.",
        operationId: "deleteOauthProvider",
        parameters: [{ $ref: "#/components/parameters/IdPath" }],
        responses: {
          "200": { $ref: "#/components/responses/Ok" },
          "400": { $ref: "#/components/responses/BadRequest" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
    },
    "/api/v1/caddy/modules": {
      get: {
        tags: ["Caddy"],
        summary: "List Caddy modules and the current selection",
        description:
          "Returns the module catalog, the stored selection, and how it differs from the modules compiled into the running Caddy image.",
        operationId: "listCaddyModules",
        responses: {
          "200": {
            description: "Module catalog and selection",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/CaddyModulesResponse" } },
            },
          },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "500": { $ref: "#/components/responses/InternalError" },
        },
      },
      put: {
        tags: ["Caddy"],
        summary: "Replace the Caddy module selection",
        description:
          "Saves which plugins the Caddy image should be built with, re-applies the config without any module removed, and pushes the selection to the agents. An agent that builds its own image starts rebuilding at once; the running container keeps its current set until the new one is ready. An agent in external build mode waits for its image to be loaded.",
        operationId: "updateCaddyModules",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  modules: {
                    type: "object",
                    additionalProperties: { type: "boolean" },
                    description: "Module id to enabled. Omitted ids default to enabled.",
                  },
                  customModules: {
                    type: "array",
                    items: { $ref: "#/components/schemas/CaddyCustomModule" },
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Updated selection",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/CaddyModulesResponse" } },
            },
          },
          "400": { $ref: "#/components/responses/BadRequest" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "409": {
            description:
              "A module in the selection is still in use - by an enabled L4 proxy host, a host with per-host WAF or geoblocking, or a configured DNS provider. Turn that feature off first.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { error: { type: "string" } },
                },
              },
            },
          },
          "500": { $ref: "#/components/responses/InternalError" },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        description: "API token created from the Profile page",
      },
      sessionAuth: {
        type: "apiKey",
        in: "cookie",
        name: "authjs.session-token",
        description: "Cookie-based session from browser login",
      },
    },
    parameters: {
      RevertQuery: {
        name: "revert",
        in: "query",
        required: false,
        description: "A field to leave as stored (or at its default, for a create). Repeatable.",
        schema: { type: "array", items: { type: "string" } },
        style: "form",
        explode: true,
      },
      HostPath: {
        name: "id",
        in: "path",
        required: true,
        schema: { type: "string" },
        description: "The host's `uuid`. The numeric `id` is not accepted.",
      },
      IdPath: {
        name: "id",
        in: "path",
        required: true,
        schema: { type: "integer" },
        description: "Resource ID",
      },
      RuleIdPath: {
        name: "ruleId",
        in: "path",
        required: true,
        schema: { type: "integer" },
        description: "The rule's ID",
      },
    },
    responses: {
      Ok: {
        description: "Success",
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: { ok: { type: "boolean", enum: [true] } },
              required: ["ok"],
            },
          },
        },
      },
      BadRequest: {
        description: "Bad request",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/Error" },
          },
        },
      },
      PendingApproval: {
        description:
          "Held for approval: the change approval policy covers this write, so it was stored as a " +
          "change request instead of applied. Approvers decide it on the Approvals page or over " +
          "GraphQL; the request is the token owner's.",
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                status: { type: "string", enum: ["pending"] },
                changeRequestId: { type: "integer" },
                message: { type: "string" },
              },
              required: ["status", "changeRequestId", "message"],
            },
          },
        },
      },
      Unauthorized: {
        description: "Unauthorized",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/Error" },
          },
        },
      },
      Forbidden: {
        description: "Forbidden",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/Error" },
          },
        },
      },
      NotFound: {
        description: "Not found",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/Error" },
          },
        },
      },
      InternalError: {
        description: "Internal server error",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/Error" },
          },
        },
      },
    },
    schemas: {
      Error: {
        type: "object",
        properties: { error: { type: "string" } },
        required: ["error"],
      },
      ProxyHostBulkInput: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: [
              "enable",
              "disable",
              "delete",
              "maintenanceOn",
              "maintenanceOff",
              "setCertificate",
              "setAccessList",
              "addTag",
            ],
          },
          ids: {
            type: "array",
            items: { type: "integer" },
            minItems: 1,
            maxItems: 500,
          },
          certificateId: {
            type: ["integer", "null"],
            description: "Required with setCertificate; null is automatic (ACME).",
          },
          accessListId: {
            type: ["integer", "null"],
            description: "Required with setAccessList; null removes it.",
          },
          tag: {
            type: "string",
            description:
              "Required with addTag. Added to each host's tags; the Caddy config is not reloaded.",
          },
        },
        required: ["action", "ids"],
      },
      L4ProxyHostBulkInput: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["enable", "disable", "delete", "addTag"] },
          ids: {
            type: "array",
            items: { type: "integer" },
            minItems: 1,
            maxItems: 500,
          },
          tag: {
            type: "string",
            description:
              "Required with addTag. Added to each host's tags; the Caddy config is not reloaded.",
          },
        },
        required: ["action", "ids"],
      },
      HostRevision: {
        type: "object",
        properties: {
          id: { type: "integer" },
          hostKind: { type: "string", enum: ["http", "l4"] },
          hostId: { type: "integer" },
          operation: {
            type: "string",
            enum: [
              "create",
              "update",
              "maintenance",
              "delete",
              "bulk",
              "import",
              "rollback",
              "restore",
            ],
          },
          detail: { type: ["object", "null"] },
          userId: { type: ["integer", "null"] },
          userName: { type: ["string", "null"] },
          createdAt: { type: "string", format: "date-time" },
          name: { type: "string" },
        },
      },
      HostChangePreview: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["http", "l4"] },
          hostId: { type: ["integer", "null"] },
          changes: {
            type: "array",
            items: {
              type: "object",
              properties: {
                field: { type: "string" },
                section: { type: "string" },
                before: {},
                after: {},
                leaves: {
                  type: ["array", "null"],
                  items: {
                    type: "object",
                    properties: { path: { type: "string" }, before: {}, after: {} },
                  },
                },
                masked: { type: "boolean" },
                revertible: { type: "boolean" },
              },
            },
          },
          impact: {
            type: "object",
            properties: {
              reload: { type: "boolean" },
              agents: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "integer" },
                    name: { type: "string" },
                    connected: { type: "boolean" },
                  },
                },
              },
              everyAgent: { type: "boolean" },
              pinned: { type: "boolean" },
              pinChanged: { type: "boolean" },
              certificates: {
                type: "array",
                items: {
                  type: "object",
                  properties: { domain: { type: "string" }, wildcard: { type: "boolean" } },
                },
              },
              warnings: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    code: { type: "string" },
                    severity: { type: "string", enum: ["warning", "info"] },
                    values: { type: "object" },
                  },
                },
              },
            },
          },
        },
      },
      BulkResult: {
        type: "object",
        properties: { count: { type: "integer" } },
        required: ["count"],
      },
      Token: {
        type: "object",
        properties: {
          id: { type: "integer" },
          name: { type: "string" },
          createdBy: { type: "integer" },
          createdAt: { type: "string", format: "date-time" },
          lastUsedAt: { type: ["string", "null"], format: "date-time" },
          expiresAt: { type: ["string", "null"], format: "date-time" },
          scope: { type: "string", enum: [...TOKEN_SCOPE_KINDS] },
          permissions: {
            type: "array",
            items: { type: "string", enum: TOKEN_PERMISSION_VALUES },
            description: "The custom scope's permissions; empty for full and read.",
          },
        },
        required: ["id", "name", "createdBy", "createdAt", "scope", "permissions"],
      },
      TokenInput: {
        type: "object",
        description:
          "Note: this endpoint accepts expires_at (snake_case) for input; the rest of the API uses camelCase.",
        properties: {
          name: { type: "string", example: "CI/CD Pipeline" },
          expires_at: {
            type: "string",
            format: "date-time",
            description:
              "Optional expiration date (ISO 8601). Field name is snake_case for this endpoint.",
          },
          scope: {
            type: "string",
            enum: [...TOKEN_SCOPE_KINDS],
            default: "full",
            description:
              "full acts with the owner's role, read refuses every change, custom allows the permissions listed. A scope never widens the owner's role.",
          },
          permissions: {
            type: "array",
            items: { type: "string", enum: TOKEN_PERMISSION_VALUES },
            description: "Required for a custom scope. area:write implies area:read.",
          },
        },
        required: ["name"],
      },

      // ── Shared sub-schemas ──────────────────────────────────────
      AuthentikConfig: {
        type: "object",
        description: "Authentik SSO forward-auth configuration",
        properties: {
          enabled: { type: "boolean" },
          outpostDomain: { type: ["string", "null"], example: "auth.example.com" },
          outpostUpstream: { type: ["string", "null"], example: "http://authentik:9000" },
          authEndpoint: { type: ["string", "null"] },
          copyHeaders: {
            type: "array",
            items: { type: "string" },
            description: "Headers to copy from Authentik response",
          },
          trustedProxies: { type: "array", items: { type: "string" }, example: ["private_ranges"] },
          setOutpostHostHeader: { type: "boolean" },
          protectedPaths: {
            type: ["array", "null"],
            items: { type: "string" },
            description: "Paths to protect (null = all)",
          },
          excludedPaths: {
            type: ["array", "null"],
            items: { type: "string" },
            description: "Paths to exclude from auth (bypassed while rest is protected)",
          },
        },
      },
      LoadBalancerConfig: {
        type: "object",
        description: "Load balancing configuration for multiple upstreams",
        properties: {
          enabled: { type: "boolean" },
          policy: {
            type: "string",
            enum: [
              "random",
              "round_robin",
              "least_conn",
              "ip_hash",
              "first",
              "header",
              "cookie",
              "uri_hash",
            ],
          },
          policyHeaderField: {
            type: ["string", "null"],
            description: "Header name for 'header' policy",
          },
          policyCookieName: {
            type: ["string", "null"],
            description: "Cookie name for 'cookie' policy",
          },
          policyCookieSecret: { type: ["string", "null"] },
          tryDuration: { type: ["string", "null"], example: "5s" },
          tryInterval: { type: ["string", "null"], example: "250ms" },
          retries: { type: ["integer", "null"] },
          activeHealthCheck: {
            type: ["object", "null"],
            properties: {
              enabled: { type: "boolean" },
              uri: { type: ["string", "null"], example: "/health" },
              port: { type: ["integer", "null"] },
              interval: { type: ["string", "null"], example: "30s" },
              timeout: { type: ["string", "null"], example: "5s" },
              status: { type: ["integer", "null"], example: 200 },
              body: { type: ["string", "null"] },
            },
          },
          passiveHealthCheck: {
            type: ["object", "null"],
            properties: {
              enabled: { type: "boolean" },
              failDuration: { type: ["string", "null"], example: "30s" },
              maxFails: { type: ["integer", "null"], example: 3 },
              unhealthyStatus: { type: ["array", "null"], items: { type: "integer" } },
              unhealthyLatency: { type: ["string", "null"], example: "5s" },
            },
          },
        },
      },
      L4LoadBalancerConfig: {
        type: "object",
        description: "L4 load balancing configuration",
        properties: {
          enabled: { type: "boolean" },
          policy: {
            type: "string",
            enum: [
              "random",
              "random_choose",
              "round_robin",
              "weighted_round_robin",
              "least_conn",
              "ip_hash",
              "first",
            ],
          },
          policyChoose: {
            type: ["integer", "null"],
            description: "How many upstreams random_choose picks between",
          },
          policyWeights: {
            type: ["array", "null"],
            items: { type: "integer", minimum: 1 },
            description:
              "weighted_round_robin weights, positional against upstreams; a list of the wrong length falls back to round_robin",
          },
          tryDuration: { type: ["string", "null"] },
          tryInterval: { type: ["string", "null"] },
          activeHealthCheck: {
            type: ["object", "null"],
            properties: {
              enabled: { type: "boolean" },
              port: { type: ["integer", "null"] },
              interval: { type: ["string", "null"] },
              timeout: { type: ["string", "null"] },
            },
          },
          passiveHealthCheck: {
            type: ["object", "null"],
            properties: {
              enabled: { type: "boolean" },
              failDuration: { type: ["string", "null"] },
              maxFails: { type: ["integer", "null"] },
            },
          },
        },
      },
      DnsResolverConfig: {
        type: "object",
        description: "Custom DNS resolver for upstream resolution",
        properties: {
          enabled: { type: "boolean" },
          resolvers: { type: "array", items: { type: "string" }, example: ["1.1.1.1", "9.9.9.9"] },
          fallbacks: { type: ["array", "null"], items: { type: "string" } },
          timeout: {
            type: ["string", "null"],
            example: "5s",
            description: "A Caddy duration. On a proxy host it bounds lookup and connect together",
          },
        },
      },
      UpstreamDnsResolutionConfig: {
        type: "object",
        description: "Upstream DNS address family preference",
        properties: {
          enabled: { type: ["boolean", "null"] },
          family: { type: ["string", "null"], enum: ["ipv4", "ipv6", "both", null] },
        },
      },
      GeoBlockConfig: {
        type: "object",
        description: "Geographic/network-based access control",
        properties: {
          enabled: { type: "boolean" },
          block_countries: {
            type: "array",
            items: { type: "string" },
            example: ["CN", "RU"],
            description: "ISO 3166-1 alpha-2 codes",
          },
          block_continents: {
            type: "array",
            items: { type: "string" },
            example: ["AS"],
            description: "AF, AN, AS, EU, NA, OC, SA",
          },
          block_asns: { type: "array", items: { type: "integer" } },
          block_cidrs: { type: "array", items: { type: "string" }, example: ["10.0.0.0/8"] },
          block_ips: { type: "array", items: { type: "string" } },
          allow_countries: { type: "array", items: { type: "string" } },
          allow_continents: { type: "array", items: { type: "string" } },
          allow_asns: { type: "array", items: { type: "integer" } },
          allow_cidrs: { type: "array", items: { type: "string" } },
          allow_ips: { type: "array", items: { type: "string" } },
          trusted_proxies: {
            type: "array",
            items: { type: "string" },
            description: "Trusted proxy CIDRs for X-Forwarded-For",
          },
          fail_closed: {
            type: "boolean",
            description: "Block when client IP cannot be determined",
          },
          response_status: { type: "integer", example: 403 },
          response_body: { type: "string", example: "Forbidden" },
          response_headers: {
            type: "object",
            additionalProperties: { type: "string" },
            example: { "Content-Type": "text/plain", "X-Custom": "blocked" },
            description: "Custom response headers (header name → value)",
          },
          redirect_url: {
            type: "string",
            description: "If set, 302 redirect instead of status/body",
          },
        },
      },
      WafConfig: {
        type: "object",
        description: "Web Application Firewall configuration",
        properties: {
          enabled: { type: "boolean" },
          mode: {
            type: "string",
            enum: ["Off", "On", "DetectionOnly"],
            description: "Unset inherits the global mode",
          },
          load_owasp_crs: { type: "boolean", description: "Load OWASP Core Rule Set" },
          custom_directives: { type: "string", description: "Custom WAF directives" },
          excluded_rule_ids: {
            type: "array",
            items: { type: "integer" },
            description:
              "Deprecated: rule IDs to exclude. Still applied, and moved into WAF exclusions on the next start; use the WAF exclusion mutations in GraphQL instead.",
          },
          preset_ids: {
            type: "array",
            items: { type: "integer" },
            description:
              "WAF preset ids, loaded ahead of the CRS rules. Merge mode adds them to the global selection; override replaces it.",
          },
          plugin_ids: {
            type: "array",
            items: { type: "integer" },
            description:
              "Installed CRS plugin ids, loaded only with the CRS. Merge mode adds them to the global selection; override replaces it.",
          },
          waf_mode: {
            type: "string",
            enum: ["merge", "override"],
            description: "How per-host WAF merges with global",
          },
          request_body_limit: {
            type: "integer",
            minimum: 1024,
            maximum: 1073741824,
            description:
              "SecRequestBodyLimit in bytes. Coraza rejects values above 1 GiB. Unset inherits Coraza's default (12.5 MiB when the OWASP CRS is loaded, else 128 MiB)",
          },
          request_body_in_memory_limit: {
            type: "integer",
            minimum: 1024,
            maximum: 1073741824,
            description: "SecRequestBodyInMemoryLimit in bytes; must not exceed request_body_limit",
          },
          request_body_limit_action: {
            type: "string",
            enum: ["Reject", "ProcessPartial"],
            description:
              "SecRequestBodyLimitAction - reject oversized bodies or inspect the buffered part and forward the rest",
          },
        },
      },
      MtlsConfig: {
        type: "object",
        description: "Mutual TLS (client certificate) configuration",
        properties: {
          enabled: { type: "boolean" },
          ca_certificate_ids: {
            type: "array",
            items: { type: "integer" },
            description: "CA certificate IDs to trust",
          },
        },
      },
      ForwardAuthConfig: {
        type: "object",
        description:
          "Authentication through an external forward-auth server (Authelia and anything else answering a forward-auth subrequest). Mutually exclusive with `authentik` and `cpmForwardAuth`.",
        properties: {
          enabled: { type: "boolean" },
          provider: {
            type: "string",
            enum: ["authelia", "custom"],
            description: "Preset filling in the endpoint and identity headers. Default: authelia",
          },
          authUpstream: {
            type: ["string", "null"],
            example: "http://authelia:9091",
            description: "Base URL of the auth server. Required when enabled",
          },
          authEndpoint: {
            type: ["string", "null"],
            example: "/api/authz/forward-auth",
            description: "URI the auth subrequest is rewritten to. Required for provider=custom",
          },
          copyHeaders: {
            type: "array",
            items: { type: "string" },
            description:
              "Headers copied from the auth server's 2xx answer onto the upstream request, and stripped from every inbound request so they cannot be forged",
          },
          trustedProxies: {
            type: "array",
            items: { type: "string" },
            description: "CIDRs, or the shorthand private_ranges",
          },
          apiSplit: {
            type: "boolean",
            description:
              "Answer a caller that did not ask for HTML with 401 rather than the auth server's redirect to its login portal",
          },
          apiBypassHeaders: {
            type: "array",
            items: { type: "string" },
            example: ["X-Api-Key"],
            description:
              "A request carrying any of these headers skips forward auth entirely; the upstream checks the credential itself",
          },
          protectedPaths: {
            type: ["array", "null"],
            items: { type: "string" },
            description: "Paths to protect (null = all)",
          },
          excludedPaths: {
            type: ["array", "null"],
            items: { type: "string" },
            description: "Paths to exclude from auth. Ignored when protectedPaths is set",
          },
        },
      },
      CpmForwardAuthConfig: {
        type: "object",
        description: "Built-in CPM forward-auth (replaces Authentik when enabled)",
        properties: {
          enabled: { type: "boolean" },
          protected_paths: {
            type: ["array", "null"],
            items: { type: "string" },
            description: "Paths to protect (null = all)",
          },
          excluded_paths: {
            type: ["array", "null"],
            items: { type: "string" },
            description: "Paths to exclude from auth",
          },
          require_captcha: {
            type: "boolean",
            description:
              "Ask for the sign-in CAPTCHA on the portal, when one is configured. Defaults to true; omitted on update, the host keeps its current value.",
          },
        },
      },
      TailscaleHostConfig: {
        type: "object",
        description:
          "How this host uses Tailscale. Requires the Tailscale Caddy module. `auth` is only honoured together with `serve`, because the identity check needs a tailnet listener to ask who is calling.",
        properties: {
          serve: {
            type: "boolean",
            description: "Serve this host on a tailscale/<node> listener",
          },
          node: {
            type: "string",
            example: "caddy",
            description:
              "Tailnet machine name. Empty inherits the default from Tailscale settings.",
          },
          tailnetOnly: {
            type: "boolean",
            description: "Keep the host off the public :80/:443 listener entirely",
          },
          auth: {
            type: "boolean",
            description: "Require a Tailscale identity (tailscale_auth)",
          },
          protected_paths: {
            type: ["array", "null"],
            items: { type: "string" },
            description: "Paths the identity gate covers (null = the whole host)",
          },
          excluded_paths: {
            type: ["array", "null"],
            items: { type: "string" },
            description: "Paths that bypass the gate. Ignored when protected_paths is set.",
          },
          forwardIdentity: {
            type: "boolean",
            description: "Send X-Tailscale-User and friends upstream",
          },
          upstreamNode: {
            type: ["string", "null"],
            description:
              "Dial the upstreams through this node, for a backend on the tailnet. The node joins the tailnet so it can dial out, but serves nothing and gets no listener of its own unless a host is served on it (serve: true).",
          },
        },
      },
      TailscaleSettings: {
        type: "object",
        description: "Tailscale node defaults for the whole deployment",
        properties: {
          enabled: { type: "boolean" },
          authKey: {
            type: "string",
            description:
              "Auth key used to register each node. Stored encrypted and never returned. A Caddy placeholder such as {env.TS_AUTHKEY} is passed through untouched.",
          },
          controlUrl: {
            type: "string",
            description: "Coordination server URL. Empty uses Tailscale's own.",
          },
          ephemeral: { type: "boolean", description: "Register nodes as ephemeral" },
          stateDir: {
            type: "string",
            example: "/data/tailscale",
            description: "Parent directory for per-node state. Must be on a volume.",
          },
          tags: {
            type: "array",
            items: { type: "string", example: "tag:caddy" },
            description: "ACL tags applied at registration",
          },
          defaultNode: {
            type: "string",
            example: "caddy",
            description: "Node name for hosts that do not choose one",
          },
          validateAuthKey: {
            type: "boolean",
            description:
              "Check the auth key against the Tailscale API before saving. Needs apiAccessToken.",
          },
          apiAccessToken: {
            type: "string",
            description:
              "Tailscale API access token (tskey-api-…) used for that check. Stored encrypted and never returned.",
          },
          apiTailnet: {
            type: "string",
            example: "-",
            description: 'Tailnet the check addresses. "-" means the token\'s own tailnet.',
          },
          http3: {
            type: "boolean",
            default: false,
            description:
              "Serve HTTP/3 on tailnet listeners. While the control server is unreachable, an h3 listener stalls Caddy's config load and its admin API.",
          },
        },
        required: ["enabled"],
      },
      HttpCacheSettings: {
        type: "object",
        description:
          "Where the Caddy cache keeps entries, and which CDN it purges. A blank redis.password or cdn.apiKey keeps the stored one",
        properties: {
          storage: {
            type: "string",
            enum: [...CACHE_STORAGES],
          },
          otterSize: {
            type: ["integer", "null"],
            minimum: MIN_OTTER_SIZE,
            maximum: MAX_OTTER_SIZE,
          },
          redis: {
            type: "object",
            properties: {
              addresses: {
                type: "array",
                maxItems: MAX_CACHE_ENDPOINTS,
                items: { type: "string", example: "redis:6379" },
              },
              username: { type: "string" },
              password: { type: "string", writeOnly: true },
              db: { type: "integer", minimum: 0, maximum: MAX_REDIS_DB },
            },
          },
          etcd: {
            type: "object",
            properties: {
              endpoints: {
                type: "array",
                maxItems: MAX_CACHE_ENDPOINTS,
                items: { type: "string" },
              },
            },
          },
          cdn: {
            type: "object",
            properties: {
              provider: { type: "string", enum: [...CDN_PROVIDERS] },
              apiKey: { type: "string", writeOnly: true },
              email: { type: "string" },
              zoneId: { type: "string" },
              serviceId: { type: "string" },
              strategy: { type: "string", enum: [...CDN_STRATEGIES] },
            },
          },
        },
      },
      HttpCacheSettingsStatus: {
        description:
          "HttpCacheSettings with redis.hasPassword and cdn.hasApiKey in place of the secrets",
        allOf: [{ $ref: "#/components/schemas/HttpCacheSettings" }],
      },
      CrowdSecSettings: {
        type: "object",
        description:
          "The CrowdSec Local API every proxy host and L4 host checks clients against. Needs the opt-in caddy-crowdsec-bouncer module; without it nothing is checked",
        properties: {
          enabled: { type: "boolean" },
          mode: {
            type: "string",
            enum: ["external", "managed"],
            description:
              "external: the apiUrl and apiKey below. managed: a crowdsec container the bundled agent runs, with a bouncer key the controller generates and never returns; hosts on other agents are then not checked. Omitted means external",
          },
          onlineApi: {
            type: "boolean",
            description:
              "Managed only: register with CrowdSec's Central API, sharing signals for the community blocklist. Defaults to false",
          },
          managedAppsec: {
            type: "boolean",
            description:
              "Managed only: send every HTTP request to the container's AppSec component",
          },
          apiUrl: {
            type: "string",
            description: "Local API base URL. Plain http only for a private address",
            example: "http://crowdsec:8080",
          },
          apiKey: {
            type: "string",
            writeOnly: true,
            description:
              "Bouncer key from `cscli bouncers add`. Stored encrypted and never returned. Omitted or empty keeps the stored key, but only while apiUrl and appsecUrl are unchanged",
          },
          appsecUrl: {
            type: "string",
            description: "AppSec component URL; empty leaves AppSec off",
            example: "http://crowdsec:7422",
          },
          appsecFailOpen: {
            type: "boolean",
            description: "Let requests through while AppSec is unavailable. Defaults to false",
          },
          tickerInterval: {
            type: "string",
            description: "Go duration between decision pulls, 1s to 24h",
            example: "60s",
          },
        },
        required: ["enabled"],
      },
      CrowdSecSettingsStatus: {
        type: "object",
        description: "CrowdSec settings as returned by GET, with the bouncer key withheld",
        properties: {
          enabled: { type: "boolean" },
          mode: { type: "string", enum: ["external", "managed"] },
          onlineApi: { type: "boolean" },
          managedAppsec: { type: "boolean" },
          apiUrl: { type: "string" },
          hasApiKey: {
            type: "boolean",
            description:
              "Whether an external bouncer key is stored. The managed one is never reported",
          },
          appsecUrl: { type: "string" },
          appsecFailOpen: { type: "boolean" },
          tickerInterval: { type: "string" },
        },
      },
      TailscaleSettingsStatus: {
        type: "object",
        description: "Tailscale settings as returned by GET, with the auth key withheld",
        properties: {
          enabled: { type: "boolean" },
          hasAuthKey: { type: "boolean", description: "Whether an auth key is stored" },
          hasApiAccessToken: { type: "boolean" },
          controlUrl: { type: "string" },
          ephemeral: { type: "boolean" },
          stateDir: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          defaultNode: { type: "string" },
          validateAuthKey: { type: "boolean" },
          apiTailnet: { type: "string" },
          http3: { type: "boolean" },
        },
      },
      RedirectRule: {
        type: "object",
        description: "HTTP redirect rule",
        properties: {
          from: {
            type: "string",
            example: "/.well-known/carddav",
            description: "Path pattern to match",
          },
          to: { type: "string", example: "/remote.php/dav/", description: "Redirect destination" },
          status: { type: "integer", enum: [301, 302, 307, 308], example: 301 },
          preservePath: {
            type: "string",
            enum: ["full", "suffix"],
            description:
              "Append the request's path and query to `to`: all of it, or only what follows the part of `from` before its first `*`. Omit to redirect to `to` as is.",
          },
        },
        required: ["from", "to", "status"],
      },
      HostMaintenanceConfig: {
        type: "object",
        description:
          "Maintenance mode: a 503 for every client outside bypassCidrs, ahead of everything else on the host. Kept while off",
        properties: {
          enabled: { type: "boolean" },
          retryAfter: {
            oneOf: [{ type: "integer", minimum: 1, maximum: 604800 }, { type: "null" }],
            description: "Seconds, sent as Retry-After",
          },
          bypassCidrs: {
            type: "array",
            maxItems: 100,
            items: { type: "string", example: "203.0.113.0/24" },
          },
          body: {
            oneOf: [{ type: "string", maxLength: 65536 }, { type: "null" }],
            description:
              "HTML page; null uses the host's 503 error page, then the global one, then a built-in page",
          },
        },
        required: ["enabled"],
      },
      HostUpstreamTimeoutsConfig: {
        type: "object",
        description:
          "Caddy durations (30s, 1m30s, 2h, 1d); null or omitted keeps Caddy's default. Replaced as a whole. Location rules inherit them; a Tailscale upstream node takes only the stream pair",
        properties: {
          dialTimeout: { type: ["string", "null"], example: "5s" },
          responseHeaderTimeout: { type: ["string", "null"] },
          readTimeout: { type: ["string", "null"] },
          writeTimeout: { type: ["string", "null"] },
          keepAliveIdleTimeout: { type: ["string", "null"] },
          streamTimeout: {
            type: ["string", "null"],
            description: "Closes WebSockets and other upgraded connections after this long",
          },
          streamCloseDelay: {
            type: ["string", "null"],
            description: "How long upgraded connections survive a config reload",
          },
        },
      },
      HostRateLimitConfig: {
        type: "object",
        description:
          "Per-client request limits, answered with 429 and Retry-After (and the host's 429 error page when it has one). Needs the opt-in caddy-ratelimit module; without it the host is served unlimited. Zones are replaced as a whole and kept while disabled. Addresses on the global never-limited list (settings group rate-limit) are never counted",
        properties: {
          enabled: { type: "boolean", description: "Whether this host's own zones apply" },
          mode: {
            type: "string",
            enum: ["inherit", "merge", "override"],
            description:
              "inherit: only the global zones. merge: the global zones and this host's. override: only this host's. Omitted on a host stored before global zones, which keeps its own zones (merge)",
          },
          zones: {
            type: "array",
            maxItems: 20,
            items: {
              type: "object",
              properties: {
                paths: {
                  type: "array",
                  maxItems: 50,
                  items: { type: "string" },
                  description: "Caddy path matchers; empty covers every request",
                  example: ["/login", "/api/*"],
                },
                methods: {
                  type: "array",
                  items: {
                    type: "string",
                    enum: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
                  },
                  description: "Only these methods count; empty counts every method",
                },
                maxEvents: { type: "integer", minimum: 1, maximum: 1000000, example: 100 },
                window: {
                  type: "string",
                  description: "A Caddy duration above zero",
                  example: "1m",
                },
                key: {
                  type: "string",
                  enum: ["ip", "ip+path", "header", "user"],
                  description:
                    "Count per client IP, per client IP and path, per value of a request header, or per user forward auth signed in. A header or user zone counts a request without one by its client IP",
                },
                header: {
                  type: ["string", "null"],
                  maxLength: 64,
                  description: "The header a header zone counts by: an RFC 7230 token, no braces",
                  example: "X-Api-Key",
                },
                ipv6Prefix: {
                  type: ["integer", "null"],
                  minimum: 1,
                  maximum: 128,
                  description: "Counts a whole IPv6 prefix as one client; ignored for ip+path",
                  example: 64,
                },
              },
              required: ["maxEvents", "window"],
            },
          },
        },
        required: ["enabled", "zones"],
      },
      HostAnubisConfig: {
        type: "object",
        description:
          "A proof-of-work bot challenge from an Anubis instance you run in subrequest mode (TARGET set to a space). Checked after geo blocking and the WAF and before any sign-in; /.within.website/* is proxied to Anubis. Kept while disabled. Ignored on the dashboard host",
        properties: {
          enabled: { type: "boolean" },
          upstream: {
            type: ["string", "null"],
            description: "Anubis's http or https base URL; required to enable it",
            example: "http://anubis:8923",
          },
          exemptPaths: {
            type: "array",
            maxItems: 50,
            items: { type: "string" },
            description:
              "Caddy path matchers that skip the challenge, for API clients and webhooks",
            example: ["/api/*"],
          },
        },
        required: ["enabled"],
      },
      HostCacheConfig: {
        type: "object",
        description:
          "Cache assets: static asset paths only. Caddy mode needs the opt-in cache-handler module and falls back to browser mode without it",
        properties: {
          mode: { type: "string", enum: [...HOST_CACHE_MODES] },
          maxAge: {
            type: "integer",
            minimum: MIN_CACHE_MAX_AGE,
            maximum: MAX_CACHE_MAX_AGE,
            example: DEFAULT_CACHE_MAX_AGE,
          },
        },
        required: ["mode", "maxAge"],
      },
      RewriteConfig: {
        type: "object",
        description: "Path rewrite (strip prefix)",
        properties: {
          path_prefix: {
            type: "string",
            example: "/app",
            description: "Prefix to strip from request path",
          },
        },
        required: ["path_prefix"],
      },
      LocationRule: {
        type: "object",
        description:
          "Route a path pattern to specific upstream servers (like nginx location blocks)",
        properties: {
          path: { type: "string", example: "/ws/*", description: "Caddy path pattern to match" },
          upstreams: {
            type: "array",
            items: { type: "string" },
            example: ["ws-backend:8080", "ws-backend2:8080"],
            description: "Upstream servers for this path",
          },
          loadBalancer: {
            oneOf: [{ $ref: "#/components/schemas/LoadBalancerConfig" }, { type: "null" }],
            description:
              "Optional per-rule load balancing and health checks for this path's upstreams",
          },
          accessListId: {
            type: ["integer", "null"],
            description:
              "This path's own access list instead of the host's. Omit to inherit the host's, or null for none.",
          },
        },
        required: ["path", "upstreams"],
      },
      PathAllowRule: {
        type: "object",
        description:
          "Allow a request path to bypass any matching Path Block and reach the upstream. Evaluated before blocks.",
        properties: {
          path: {
            type: "string",
            example: "/secret",
            description: "Caddy path pattern to allow through",
          },
        },
        required: ["path"],
      },
      PathBlockRule: {
        type: "object",
        description: "Block a request path with a static response (no proxying)",
        properties: {
          path: {
            type: "string",
            example: "/dns-query",
            description: "Caddy path pattern to match",
          },
          status: {
            type: "integer",
            enum: [400, 401, 403, 404, 410, 418, 451, 500, 502, 503],
            example: 403,
          },
          body: { type: "string", example: "Forbidden", description: "Optional response body" },
        },
        required: ["path", "status"],
      },
      PathRewriteRule: {
        type: "object",
        description: "Internally rewrite the request URI before proxying (client URL is unchanged)",
        properties: {
          from: {
            type: "string",
            example: "/secretpath",
            description: "Caddy path pattern to match",
          },
          to: { type: "string", example: "/dns-query", description: "Internal target URI" },
        },
        required: ["from", "to"],
      },

      // ── Main resource schemas ───────────────────────────────────
      CaddyCustomModule: {
        type: "object",
        required: ["modulePath"],
        properties: {
          name: {
            type: "string",
            maxLength: 80,
            description: "Optional label shown in the settings list; not part of the build",
          },
          modulePath: {
            type: "string",
            description: "Go module path, e.g. github.com/greenpau/caddy-security",
            example: "github.com/greenpau/caddy-security",
          },
          version: {
            type: "string",
            description: "Optional tag, branch, or commit passed as path@version",
          },
          enabled: { type: "boolean", default: true },
        },
      },
      CaddyModulesResponse: {
        type: "object",
        properties: {
          available: {
            type: "array",
            description: "Every module this app knows how to configure.",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                name: { type: "string" },
                modulePath: { type: "string" },
                description: { type: "string" },
                category: { type: "string", enum: ["proxy", "cache", "security", "dns"] },
                features: { type: "array", items: { type: "string" } },
              },
            },
          },
          selection: {
            type: "object",
            properties: {
              modules: { type: "object", additionalProperties: { type: "boolean" } },
              customModules: {
                type: "array",
                items: { $ref: "#/components/schemas/CaddyCustomModule" },
              },
            },
          },
          diff: {
            type: "object",
            description: "How the selection differs from the running image.",
            properties: {
              appliedSpecs: { type: "array", items: { type: "string" } },
              desiredSpecs: { type: "array", items: { type: "string" } },
              added: { type: "array", items: { type: "string" } },
              removed: { type: "array", items: { type: "string" } },
              needsRebuild: { type: "boolean" },
            },
          },
        },
      },
      ProxyHost: {
        type: "object",
        properties: {
          id: { type: "integer" },
          uuid: {
            type: "string",
            format: "uuid",
            description: "What URLs and paths name the host by",
          },
          name: { type: "string" },
          description: { type: ["string", "null"], description: "Free-text notes" },
          tags: {
            type: "array",
            items: { type: "string" },
            description:
              "Lowercase and sorted. Labels for finding hosts; never part of the Caddy config.",
          },
          domains: {
            type: "array",
            items: { type: "string" },
            example: ["example.com", "www.example.com"],
          },
          upstreams: { type: "array", items: { type: "string" }, example: ["localhost:8080"] },
          certificateId: { type: ["integer", "null"] },
          accessListId: { type: ["integer", "null"] },
          sslForced: { type: "boolean" },
          hstsEnabled: { type: "boolean" },
          hstsSubdomains: { type: "boolean" },
          allowWebsocket: { type: "boolean" },
          preserveHostHeader: { type: "boolean" },
          skipHttpsHostnameValidation: { type: "boolean" },
          enabled: { type: "boolean" },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
          customReverseProxyJson: {
            type: ["string", "null"],
            description: "Raw Caddy JSON for reverse_proxy handler",
          },
          customPreHandlersJson: {
            type: ["string", "null"],
            description: "Raw Caddy JSON for handlers before reverse_proxy",
          },
          customCaddyfile: {
            type: ["string", "null"],
            description:
              "Caddyfile directives for this host, adapted to JSON handlers and inserted before the reverse proxy. Rejected if the running Caddy cannot adapt them.",
          },
          authentik: {
            oneOf: [{ $ref: "#/components/schemas/AuthentikConfig" }, { type: "null" }],
          },
          loadBalancer: {
            oneOf: [{ $ref: "#/components/schemas/LoadBalancerConfig" }, { type: "null" }],
          },
          dnsResolver: {
            oneOf: [{ $ref: "#/components/schemas/DnsResolverConfig" }, { type: "null" }],
          },
          upstreamDnsResolution: {
            oneOf: [{ $ref: "#/components/schemas/UpstreamDnsResolutionConfig" }, { type: "null" }],
          },
          geoblock: { oneOf: [{ $ref: "#/components/schemas/GeoBlockConfig" }, { type: "null" }] },
          geoblockMode: {
            type: "string",
            enum: ["merge", "override"],
            description: "How per-host geoblock merges with global",
          },
          waf: { oneOf: [{ $ref: "#/components/schemas/WafConfig" }, { type: "null" }] },
          mtls: { oneOf: [{ $ref: "#/components/schemas/MtlsConfig" }, { type: "null" }] },
          forwardAuth: {
            oneOf: [{ $ref: "#/components/schemas/ForwardAuthConfig" }, { type: "null" }],
          },
          cpmForwardAuth: {
            oneOf: [{ $ref: "#/components/schemas/CpmForwardAuthConfig" }, { type: "null" }],
          },
          tailscale: {
            oneOf: [{ $ref: "#/components/schemas/TailscaleHostConfig" }, { type: "null" }],
          },
          redirects: { type: "array", items: { $ref: "#/components/schemas/RedirectRule" } },
          rewrite: { oneOf: [{ $ref: "#/components/schemas/RewriteConfig" }, { type: "null" }] },
          cache: { oneOf: [{ $ref: "#/components/schemas/HostCacheConfig" }, { type: "null" }] },
          compression: {
            type: "string",
            enum: ["inherit", "on", "off"],
            description: "Response compression; inherit follows the global compression setting",
          },
          crowdsec: {
            type: "boolean",
            description:
              "Check clients against CrowdSec's decisions when CrowdSec is set up. Defaults to true; false opts this host out",
          },
          discourageIndexing: {
            type: "boolean",
            description:
              "Send X-Robots-Tag: noindex, nofollow and a robots.txt disallowing everything",
          },
          skipAccessLog: {
            type: "boolean",
            description: "Leave this host's requests out of the access log",
          },
          maintenance: {
            oneOf: [{ $ref: "#/components/schemas/HostMaintenanceConfig" }, { type: "null" }],
          },
          upstreamTimeouts: {
            oneOf: [{ $ref: "#/components/schemas/HostUpstreamTimeoutsConfig" }, { type: "null" }],
          },
          rateLimit: {
            oneOf: [{ $ref: "#/components/schemas/HostRateLimitConfig" }, { type: "null" }],
          },
          anubis: {
            oneOf: [{ $ref: "#/components/schemas/HostAnubisConfig" }, { type: "null" }],
          },
          locationRules: {
            type: "array",
            items: { $ref: "#/components/schemas/LocationRule" },
            description: "Path-based routing rules (routes specific paths to different upstreams)",
          },
          pathAllows: {
            type: "array",
            items: { $ref: "#/components/schemas/PathAllowRule" },
            description:
              "Paths that bypass any matching Path Block and reach the upstream (evaluated first)",
          },
          pathBlocks: {
            type: "array",
            items: { $ref: "#/components/schemas/PathBlockRule" },
            description: "Paths blocked with a static response",
          },
          pathRewrites: {
            type: "array",
            items: { $ref: "#/components/schemas/PathRewriteRule" },
            description: "Internal URI rewrites applied before proxying",
          },
        },
        required: ["id", "name", "domains", "upstreams", "enabled", "createdAt", "updatedAt"],
      },
      ProxyHostInput: {
        type: "object",
        properties: {
          name: { type: "string", example: "My App" },
          description: {
            type: ["string", "null"],
            maxLength: 2000,
            description: "Free-text notes. Blank or null clears them.",
          },
          tags: {
            type: ["array", "null"],
            items: { type: "string", maxLength: 40 },
            maxItems: 16,
            description:
              "Lowercased, trimmed, deduplicated and sorted on save. Each starts with a letter or digit, then letters, digits and . _ : / -. Null or an empty list clears them.",
          },
          domains: { type: "array", items: { type: "string" }, example: ["app.example.com"] },
          upstreams: { type: "array", items: { type: "string" }, example: ["localhost:3000"] },
          certificateId: { type: ["integer", "null"] },
          accessListId: { type: ["integer", "null"] },
          sslForced: { type: "boolean" },
          hstsEnabled: { type: "boolean" },
          hstsSubdomains: { type: "boolean" },
          allowWebsocket: { type: "boolean" },
          preserveHostHeader: { type: "boolean" },
          skipHttpsHostnameValidation: { type: "boolean" },
          enabled: { type: "boolean" },
          customReverseProxyJson: { type: ["string", "null"] },
          customPreHandlersJson: { type: ["string", "null"] },
          customCaddyfile: { type: ["string", "null"] },
          authentik: {
            oneOf: [{ $ref: "#/components/schemas/AuthentikConfig" }, { type: "null" }],
          },
          loadBalancer: {
            oneOf: [{ $ref: "#/components/schemas/LoadBalancerConfig" }, { type: "null" }],
          },
          dnsResolver: {
            oneOf: [{ $ref: "#/components/schemas/DnsResolverConfig" }, { type: "null" }],
          },
          upstreamDnsResolution: {
            oneOf: [{ $ref: "#/components/schemas/UpstreamDnsResolutionConfig" }, { type: "null" }],
          },
          geoblock: { oneOf: [{ $ref: "#/components/schemas/GeoBlockConfig" }, { type: "null" }] },
          geoblockMode: { type: "string", enum: ["merge", "override"] },
          waf: { oneOf: [{ $ref: "#/components/schemas/WafConfig" }, { type: "null" }] },
          mtls: { oneOf: [{ $ref: "#/components/schemas/MtlsConfig" }, { type: "null" }] },
          forwardAuth: {
            oneOf: [{ $ref: "#/components/schemas/ForwardAuthConfig" }, { type: "null" }],
          },
          cpmForwardAuth: {
            oneOf: [{ $ref: "#/components/schemas/CpmForwardAuthConfig" }, { type: "null" }],
          },
          tailscale: {
            oneOf: [{ $ref: "#/components/schemas/TailscaleHostConfig" }, { type: "null" }],
          },
          redirects: { type: "array", items: { $ref: "#/components/schemas/RedirectRule" } },
          rewrite: { oneOf: [{ $ref: "#/components/schemas/RewriteConfig" }, { type: "null" }] },
          cache: { oneOf: [{ $ref: "#/components/schemas/HostCacheConfig" }, { type: "null" }] },
          compression: {
            type: "string",
            enum: ["inherit", "on", "off"],
            description: "Response compression; inherit follows the global compression setting",
          },
          crowdsec: {
            type: "boolean",
            description:
              "Check clients against CrowdSec's decisions when CrowdSec is set up. Defaults to true; false opts this host out",
          },
          discourageIndexing: {
            type: "boolean",
            description:
              "Send X-Robots-Tag: noindex, nofollow and a robots.txt disallowing everything",
          },
          maintenance: {
            oneOf: [{ $ref: "#/components/schemas/HostMaintenanceConfig" }, { type: "null" }],
          },
          upstreamTimeouts: {
            oneOf: [{ $ref: "#/components/schemas/HostUpstreamTimeoutsConfig" }, { type: "null" }],
          },
          rateLimit: {
            oneOf: [{ $ref: "#/components/schemas/HostRateLimitConfig" }, { type: "null" }],
          },
          anubis: {
            oneOf: [{ $ref: "#/components/schemas/HostAnubisConfig" }, { type: "null" }],
          },
          locationRules: {
            type: "array",
            items: { $ref: "#/components/schemas/LocationRule" },
            description: "Path-based routing rules (routes specific paths to different upstreams)",
          },
          pathAllows: {
            type: "array",
            items: { $ref: "#/components/schemas/PathAllowRule" },
            description:
              "Paths that bypass any matching Path Block and reach the upstream (evaluated first)",
          },
          pathBlocks: {
            type: "array",
            items: { $ref: "#/components/schemas/PathBlockRule" },
            description: "Paths blocked with a static response",
          },
          pathRewrites: {
            type: "array",
            items: { $ref: "#/components/schemas/PathRewriteRule" },
            description: "Internal URI rewrites applied before proxying",
          },
        },
        required: ["name", "domains", "upstreams"],
      },
      L4ProxyHost: {
        type: "object",
        properties: {
          id: { type: "integer" },
          uuid: {
            type: "string",
            format: "uuid",
            description: "What URLs and paths name the host by",
          },
          name: { type: "string" },
          description: { type: ["string", "null"], description: "Free-text notes" },
          tags: {
            type: "array",
            items: { type: "string" },
            description:
              "Lowercase and sorted. Labels for finding hosts; never part of the Caddy config.",
          },
          protocol: { type: "string", enum: ["tcp", "udp"] },
          listenAddress: {
            type: "string",
            example: ":5432",
            description:
              "Address to listen on: ':port', 'host:port', or '[ipv6]:port'. An IPv6 literal " +
              "must be bracketed - unbracketed, its last group is indistinguishable from a port. " +
              "The port may be a range 'A-B' of up to 1000 ports. " +
              "Ports 80, 443, 2019, 3000, 9090 and the enabled metrics port are reserved and rejected.",
          },
          upstreams: {
            type: "array",
            items: { type: "string" },
            example: ["db-server:5432"],
            description: "'host:port' each, or a bare host when upstreamPortMode is 'same'",
          },
          upstreamPortMode: {
            type: "string",
            enum: ["fixed", "same"],
            description:
              "same: each connection is dialled on the port it arrived on, for a listen range",
          },
          matcherType: { type: "string", enum: ["none", "tls_sni", "http_host", "proxy_protocol"] },
          matcherValue: {
            type: "array",
            items: { type: "string" },
            description: "Match values for tls_sni / http_host (empty otherwise)",
          },
          tlsTermination: { type: "boolean" },
          proxyProtocolVersion: { type: ["string", "null"], enum: ["v1", "v2", null] },
          proxyProtocolReceive: {
            type: "boolean",
            description: "Trust inbound PROXY protocol header from upstream LBs",
          },
          accessListId: {
            type: ["integer", "null"],
            description:
              "An access list whose IP rules close connections from the addresses they deny. Passwords do not apply at layer 4, so a list without IP rules is refused (400).",
          },
          enabled: { type: "boolean" },
          loadBalancer: {
            oneOf: [{ $ref: "#/components/schemas/L4LoadBalancerConfig" }, { type: "null" }],
          },
          dnsResolver: {
            oneOf: [{ $ref: "#/components/schemas/DnsResolverConfig" }, { type: "null" }],
          },
          upstreamDnsResolution: {
            oneOf: [{ $ref: "#/components/schemas/UpstreamDnsResolutionConfig" }, { type: "null" }],
          },
          geoblock: { oneOf: [{ $ref: "#/components/schemas/GeoBlockConfig" }, { type: "null" }] },
          geoblockMode: { type: "string", enum: ["merge", "override"] },
          crowdsec: {
            type: "boolean",
            description:
              "Check clients against CrowdSec's decisions when CrowdSec is set up. Defaults to true; false opts this host out",
          },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
        required: [
          "id",
          "name",
          "listenAddress",
          "upstreams",
          "protocol",
          "enabled",
          "createdAt",
          "updatedAt",
        ],
      },
      L4ProxyHostInput: {
        type: "object",
        properties: {
          name: { type: "string", example: "PostgreSQL Proxy" },
          description: {
            type: ["string", "null"],
            maxLength: 2000,
            description: "Free-text notes. Blank or null clears them.",
          },
          tags: {
            type: ["array", "null"],
            items: { type: "string", maxLength: 40 },
            maxItems: 16,
            description:
              "Lowercased, trimmed, deduplicated and sorted on save. Each starts with a letter or digit, then letters, digits and . _ : / -. Null or an empty list clears them.",
          },
          protocol: { type: "string", enum: ["tcp", "udp"] },
          listenAddress: {
            type: "string",
            example: ":5432",
            description:
              "':port', 'host:port', or '[ipv6]:port', where the port may be a range 'A-B' of up " +
              "to 1000 ports. Ports 80, 443, 2019, 3000, 9090 and the enabled metrics port are " +
              "reserved and rejected, as is a port another enabled host uses with a different " +
              "listen address (400). An agent publishes at most 2000 ports.",
          },
          upstreams: {
            type: "array",
            items: { type: "string" },
            example: ["db:5432"],
            description: "'host:port' each, or a bare host when upstreamPortMode is 'same'",
          },
          upstreamPortMode: {
            type: "string",
            enum: ["fixed", "same"],
            description:
              "same: each connection is dialled on the port it arrived on, so one host can forward a " +
              "listen range. Upstreams are then bare hosts, and an active health check is refused " +
              "(400). Omitted keeps the current mode; fixed on create",
          },
          matcherType: { type: "string", enum: ["none", "tls_sni", "http_host", "proxy_protocol"] },
          matcherValue: { type: "array", items: { type: "string" } },
          tlsTermination: { type: "boolean" },
          proxyProtocolVersion: { type: ["string", "null"], enum: ["v1", "v2", null] },
          proxyProtocolReceive: { type: "boolean" },
          accessListId: {
            type: ["integer", "null"],
            description:
              "An access list whose IP rules close connections from the addresses they deny. Passwords do not apply at layer 4, so a list without IP rules is refused (400).",
          },
          enabled: { type: "boolean" },
          loadBalancer: {
            oneOf: [{ $ref: "#/components/schemas/L4LoadBalancerConfig" }, { type: "null" }],
          },
          dnsResolver: {
            oneOf: [{ $ref: "#/components/schemas/DnsResolverConfig" }, { type: "null" }],
          },
          upstreamDnsResolution: {
            oneOf: [{ $ref: "#/components/schemas/UpstreamDnsResolutionConfig" }, { type: "null" }],
          },
          geoblock: { oneOf: [{ $ref: "#/components/schemas/GeoBlockConfig" }, { type: "null" }] },
          geoblockMode: { type: "string", enum: ["merge", "override"] },
          crowdsec: {
            type: "boolean",
            description:
              "Check clients against CrowdSec's decisions when CrowdSec is set up. Defaults to true; false opts this host out",
          },
        },
        required: ["name", "listenAddress", "upstreams", "protocol"],
      },
      Certificate: {
        type: "object",
        properties: {
          id: { type: "integer" },
          name: { type: "string" },
          type: { type: "string", enum: ["managed", "imported"] },
          domainNames: {
            type: "array",
            items: { type: "string" },
            example: ["example.com", "*.example.com"],
          },
          autoRenew: { type: "boolean" },
          providerOptions: {
            type: ["object", "null"],
            description:
              "Optional reference to a centrally configured DNS provider. Credential values are never returned here.",
            properties: { provider: { type: "string" } },
            required: ["provider"],
            additionalProperties: false,
          },
          certificatePem: {
            type: ["string", "null"],
            description: "PEM-encoded certificate (imported type only)",
          },
          hasPrivateKey: {
            type: "boolean",
            description: "Whether write-only private key material is stored",
          },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
          source: {
            type: "string",
            enum: ["upload", "agent-file"],
            description:
              "`agent-file`: read from files on one agent's host; its PEM and names are read-only.",
          },
          sourceAgentId: { type: ["integer", "null"] },
          sourceCertPath: { type: ["string", "null"] },
          sourceKeyPath: { type: ["string", "null"] },
          sourceReadAt: { type: ["string", "null"], format: "date-time" },
          sourceError: {
            type: ["string", "null"],
            description:
              "Why the last read failed, as a code. The last good certificate keeps serving.",
          },
        },
        required: ["id", "name", "type", "domainNames", "hasPrivateKey", "createdAt", "updatedAt"],
      },
      AgentFileCertificateInput: {
        type: "object",
        properties: {
          name: { type: "string" },
          source: { type: "string", enum: ["agent-file"] },
          sourceAgentId: { type: "integer", description: "The agent that reads the files" },
          sourceCertPath: {
            type: "string",
            description: "Relative to the agent's CERT_FILES_HOST_DIR",
            example: "live/example.com/fullchain.pem",
          },
          sourceKeyPath: { type: "string", example: "live/example.com/privkey.pem" },
        },
        required: ["name", "source", "sourceAgentId", "sourceCertPath", "sourceKeyPath"],
      },
      CertificateInput: {
        type: "object",
        properties: {
          name: { type: "string", example: "Wildcard Cert" },
          type: { type: "string", enum: ["managed", "imported"] },
          domainNames: { type: "array", items: { type: "string" } },
          autoRenew: { type: "boolean" },
          providerOptions: {
            type: ["object", "null"],
            properties: { provider: { type: "string" } },
            required: ["provider"],
            additionalProperties: false,
          },
          certificatePem: { type: ["string", "null"] },
          privateKeyPem: { type: ["string", "null"], writeOnly: true },
        },
        required: ["name", "type", "domainNames"],
      },
      CaCertificate: {
        type: "object",
        properties: {
          id: { type: "integer" },
          name: { type: "string" },
          certificatePem: { type: "string", description: "PEM-encoded CA certificate" },
          hasPrivateKey: {
            type: "boolean",
            description: "Whether a private key is stored (for issuing client certs)",
          },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
        required: ["id", "name", "certificatePem", "hasPrivateKey", "createdAt", "updatedAt"],
      },
      CaCertificateInput: {
        type: "object",
        properties: {
          name: { type: "string", example: "Internal CA" },
          certificatePem: { type: "string", description: "PEM-encoded CA certificate" },
          privateKeyPem: {
            type: "string",
            description: "PEM-encoded private key (optional, needed for issuing client certs)",
          },
        },
        required: ["name", "certificatePem"],
      },
      ClientCertificate: {
        type: "object",
        properties: {
          id: { type: "integer" },
          caCertificateId: { type: "integer" },
          commonName: { type: "string", example: "client-device-01" },
          serialNumber: { type: "string" },
          fingerprintSha256: { type: "string" },
          certificatePem: { type: "string" },
          validFrom: { type: "string", format: "date-time" },
          validTo: { type: "string", format: "date-time" },
          revokedAt: { type: ["string", "null"], format: "date-time" },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
        required: [
          "id",
          "caCertificateId",
          "commonName",
          "serialNumber",
          "fingerprintSha256",
          "certificatePem",
          "validFrom",
          "validTo",
          "createdAt",
          "updatedAt",
        ],
      },
      ClientCertificateInput: {
        type: "object",
        description:
          "Store a pre-issued client certificate. All PEM/serial/fingerprint/validity fields must be provided.",
        properties: {
          caCertificateId: {
            type: "integer",
            description: "ID of the CA certificate this cert was issued from",
          },
          commonName: { type: "string", example: "client-device-01" },
          serialNumber: { type: "string" },
          fingerprintSha256: { type: "string" },
          certificatePem: { type: "string" },
          validFrom: { type: "string", format: "date-time" },
          validTo: { type: "string", format: "date-time" },
        },
        required: [
          "caCertificateId",
          "commonName",
          "serialNumber",
          "fingerprintSha256",
          "certificatePem",
          "validFrom",
          "validTo",
        ],
      },
      AccessList: {
        type: "object",
        properties: {
          id: { type: "integer" },
          name: { type: "string" },
          description: { type: ["string", "null"] },
          entries: { type: "array", items: { $ref: "#/components/schemas/AccessListEntry" } },
          ipRules: {
            type: "array",
            description: "Checked in order; the first rule matching the client decides.",
            items: { $ref: "#/components/schemas/AccessListIpRule" },
          },
          ipDefault: {
            type: "string",
            enum: ["allow", "deny"],
            description:
              "What a request matching none of the IP rules gets. Only used while there are rules.",
          },
          satisfy: {
            type: "string",
            enum: ["all", "any"],
            description:
              "all: pass the IP rules and the password. any: an allowed address skips the password, and everyone else is asked for it.",
          },
          passAuth: {
            type: "boolean",
            description: "Forward the basic-auth Authorization header to the upstream.",
          },
          denyResponse: {
            oneOf: [{ $ref: "#/components/schemas/AccessListDenyResponse" }, { type: "null" }],
          },
          failClosed: {
            type: "boolean",
            description:
              "Refuse a request whose client cannot be told apart from a trusted proxy. Needs the Geo Blocking module.",
          },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
        required: [
          "id",
          "name",
          "entries",
          "ipRules",
          "ipDefault",
          "satisfy",
          "passAuth",
          "denyResponse",
          "failClosed",
          "createdAt",
          "updatedAt",
        ],
      },
      AccessListDenyResponse: {
        type: "object",
        description:
          "What a denied request gets. Null (or omitted on create) is 403 Access denied. A redirectUrl answers 302 and wins over status and body.",
        properties: {
          status: { type: "integer", minimum: 400, maximum: 599, example: 403 },
          body: { type: ["string", "null"], maxLength: 8192 },
          redirectUrl: {
            type: ["string", "null"],
            maxLength: 2048,
            description: "An absolute http or https URL, without spaces or braces",
          },
        },
      },
      AccessListIpRule: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["allow", "deny"] },
          cidr: {
            type: ["string", "null"],
            example: "192.168.1.0/24",
            description:
              "An IPv4 or IPv6 address or CIDR range. A bare address is stored as a /32 or /128. Exactly one of cidr, hostname, country, continent and asn.",
          },
          hostname: {
            type: ["string", "null"],
            example: "home.example.com",
            description:
              "A hostname the controller resolves (A and AAAA) and re-resolves as its TTL expires, clamped to 60 s-1 h. It stands for each IPv4 address as a /32 and each IPv6 address widened to its /64; end the name in /48 to /128 to set that prefix. Up to 16 addresses per name. On a failed lookup the last answer is kept for 24 h. A name with no answer stands for no addresses: an allow rule admits nobody, a deny rule denies nobody.",
          },
          country: {
            type: ["string", "null"],
            example: "DE",
            description:
              "An ISO 3166-1 alpha-2 code, looked up in GeoLite2-Country. Needs the Geo Blocking module.",
          },
          continent: {
            type: ["string", "null"],
            enum: ["AF", "AN", "AS", "EU", "NA", "OC", "SA", null],
            description: "Needs the Geo Blocking module.",
          },
          asn: {
            type: ["integer", "null"],
            minimum: 1,
            maximum: 4294967295,
            description:
              "An autonomous system number (AS13335 is accepted too), looked up in GeoLite2-ASN. Needs the Geo Blocking module.",
          },
          note: { type: ["string", "null"] },
          expiresAt: {
            type: ["string", "null"],
            format: "date-time",
            description: "Past it the rule no longer applies, and it is deleted within a minute.",
          },
          resolved: {
            type: "object",
            readOnly: true,
            description: "Hostname rules only: what the name currently stands for.",
            properties: {
              ranges: { type: "array", items: { type: "string" } },
              resolvedAt: { type: ["string", "null"], format: "date-time" },
              lastError: { type: ["string", "null"] },
              lastErrorAt: { type: ["string", "null"], format: "date-time" },
            },
            required: ["ranges", "resolvedAt", "lastError", "lastErrorAt"],
          },
        },
        required: ["action"],
      },
      AccessListInput: {
        type: "object",
        properties: {
          name: { type: "string", example: "Internal Users" },
          description: { type: ["string", "null"] },
          ipDefault: {
            type: "string",
            enum: ["allow", "deny"],
            description:
              "What a request matching none of the IP rules gets. Only used while there are rules.",
          },
          satisfy: {
            type: "string",
            enum: ["all", "any"],
            description:
              "all: pass the IP rules and the password. any: an allowed address skips the password, and everyone else is asked for it.",
          },
          passAuth: {
            type: "boolean",
            description: "Forward the basic-auth Authorization header to the upstream.",
          },
          denyResponse: {
            oneOf: [{ $ref: "#/components/schemas/AccessListDenyResponse" }, { type: "null" }],
            description:
              "On update, null restores 403 Access denied and an omitted field keeps it.",
          },
          failClosed: { type: "boolean" },
          users: {
            type: "array",
            description: "Seed members (only used during creation)",
            items: {
              type: "object",
              properties: {
                username: { type: "string" },
                password: { type: "string" },
              },
              required: ["username", "password"],
            },
          },
        },
        required: ["name"],
      },
      AccessListEntry: {
        type: "object",
        properties: {
          id: { type: "integer" },
          username: { type: "string" },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
        required: ["id", "username", "createdAt", "updatedAt"],
      },
      AccessListEntryInput: {
        type: "object",
        properties: {
          username: { type: "string", example: "admin" },
          password: { type: "string", example: "secret123" },
        },
        required: ["username", "password"],
      },

      // ── Settings schemas ────────────────────────────────────────
      GeneralSettings: {
        type: "object",
        properties: {
          defaultDomain: { type: "string", example: "example.com" },
          acmeEmail: { type: "string", format: "email", example: "admin@example.com" },
        },
        required: ["defaultDomain"],
      },
      CloudflareSettings: {
        type: "object",
        description:
          "Write-only legacy Cloudflare settings. The API token is accepted on update but never returned by GET.",
        properties: {
          apiToken: { type: "string", description: "Cloudflare API token", writeOnly: true },
          zoneId: { type: "string" },
          accountId: { type: "string" },
        },
        required: ["apiToken"],
      },
      CloudflareStatus: {
        type: "object",
        description: "Non-secret metadata for the legacy Cloudflare settings group.",
        properties: {
          hasApiToken: { type: "boolean" },
          zoneId: { type: "string" },
          accountId: { type: "string" },
        },
        required: ["hasApiToken"],
      },
      DnsProviderSettings: {
        type: "object",
        description:
          "Write-only DNS provider configuration for ACME DNS-01 challenges. Credential values are accepted on update but never returned by GET.",
        properties: {
          providers: {
            type: "object",
            additionalProperties: {
              type: "object",
              additionalProperties: { type: "string", writeOnly: true },
              description: "Credential key-value pairs for this provider",
            },
            description:
              "Configured providers keyed by name (e.g. { cloudflare: { api_token: '...' }, route53: { ... } })",
          },
          default: {
            type: "string",
            nullable: true,
            description:
              "Name of the default provider used for DNS-01 challenges (null = HTTP-01 only)",
          },
          delegations: {
            type: "array",
            maxItems: 256,
            items: { $ref: "#/components/schemas/DnsChallengeDelegation" },
            description:
              "Challenge delegations. Omitting the field on a PUT removes every delegation.",
          },
          acmeDnsAccounts: {
            type: "object",
            description:
              "acme-dns accounts keyed by the lowercase domain each was registered for. The password is encrypted at rest and never returned.",
            additionalProperties: {
              type: "object",
              properties: {
                username: { type: "string", writeOnly: true },
                password: { type: "string", writeOnly: true },
                subdomain: { type: "string", writeOnly: true },
                fulldomain: { type: "string", description: "The CNAME target" },
                server_url: { type: "string", format: "uri", writeOnly: true },
              },
              required: ["username", "password", "subdomain", "fulldomain", "server_url"],
            },
          },
        },
        required: ["providers", "default"],
      },
      DnsChallengeDelegation: {
        type: "object",
        description:
          "Sends DNS-01 challenges for a domain and every name under it (longest match wins) to override_domain, and optionally to another provider. At least one of target and provider is set.",
        properties: {
          domain: { type: "string", example: "example.com" },
          target: {
            type: ["string", "null"],
            description: "Where _acme-challenge.<name> is CNAMEd to; Caddy's override_domain",
            example: "_acme-challenge.example.com.validation.example.net",
          },
          provider: {
            type: ["string", "null"],
            description: "A configured provider; null uses the certificate's or the default",
          },
        },
        required: ["domain"],
      },
      DnsProviderStatus: {
        type: "object",
        description:
          "Non-secret metadata for configured DNS providers. Credential values are write-only.",
        properties: {
          providers: {
            type: "object",
            additionalProperties: {
              type: "object",
              properties: {
                configuredFields: {
                  type: "array",
                  items: { type: "string" },
                  description: "Credential field names which have a stored, non-empty value",
                },
              },
              required: ["configuredFields"],
            },
            description:
              "Configured providers keyed by provider name; values contain metadata only",
          },
          default: {
            type: ["string", "null"],
            description: "Name of the default provider used for DNS-01 challenges",
          },
          delegations: {
            type: "array",
            items: { $ref: "#/components/schemas/DnsChallengeDelegation" },
          },
          acmeDnsAccounts: {
            type: "object",
            description: "acme-dns accounts by domain; only the CNAME target is returned",
            additionalProperties: {
              type: "object",
              properties: { fulldomain: { type: "string" } },
              required: ["fulldomain"],
            },
          },
        },
        required: ["providers", "default", "delegations", "acmeDnsAccounts"],
      },
      AuthentikSettings: {
        type: "object",
        properties: {
          outpostDomain: { type: "string", example: "auth.example.com" },
          outpostUpstream: { type: "string", example: "http://authentik:9000" },
          authEndpoint: { type: "string" },
        },
        required: ["outpostDomain", "outpostUpstream"],
      },
      MetricsSettings: {
        type: "object",
        properties: {
          enabled: { type: "boolean" },
          port: { type: "integer", example: 9090, description: "Prometheus metrics port" },
        },
        required: ["enabled"],
      },
      LoggingSettings: {
        type: "object",
        properties: {
          enabled: { type: "boolean" },
          format: { type: "string", enum: ["json", "console"] },
        },
        required: ["enabled"],
      },
      DefaultResponseSettings: {
        type: "object",
        description: "Catch-all behavior for requests that do not match a configured proxy host.",
        properties: {
          mode: {
            type: "string",
            enum: ["caddy", "respond", "redirect", "abort"],
            description:
              "caddy preserves native routing/automatic-HTTPS behavior; abort closes the connection without a response.",
          },
          status: {
            type: "integer",
            minimum: 200,
            maximum: 599,
            description: "HTTP response status, or one of 301/302/303/307/308 for redirect mode.",
          },
          body: { type: "string", description: "Body used by respond mode." },
          headers: {
            type: "object",
            additionalProperties: { type: "string" },
            description: "Optional response headers. Values must not contain newlines.",
          },
          redirectUrl: { type: "string", description: "Target used by redirect mode." },
        },
        required: ["mode"],
      },
      DnsSettings: {
        type: "object",
        properties: {
          enabled: { type: "boolean" },
          resolvers: { type: "array", items: { type: "string" }, example: ["1.1.1.1", "9.9.9.9"] },
          fallbacks: { type: "array", items: { type: "string" } },
          timeout: { type: "string", example: "5s" },
        },
        required: ["enabled", "resolvers"],
      },
      UpstreamDnsSettings: {
        type: "object",
        properties: {
          enabled: { type: "boolean" },
          family: { type: "string", enum: ["ipv4", "ipv6", "both"] },
        },
        required: ["enabled", "family"],
      },
      WafSettings: {
        type: "object",
        description: "Global WAF settings",
        properties: {
          enabled: { type: "boolean" },
          mode: { type: "string", enum: ["Off", "On", "DetectionOnly"] },
          load_owasp_crs: { type: "boolean" },
          custom_directives: { type: "string" },
          strict_directives: {
            type: "boolean",
            description:
              "Refuse custom directives that read files, change the engine or set environment variables, instead of sending them with a warning. Directives Coraza cannot load are refused either way.",
          },
          excluded_rule_ids: {
            type: "array",
            items: { type: "integer" },
            description: "Deprecated: moved into WAF exclusions on the next start.",
          },
          paranoia_level: {
            type: "integer",
            minimum: 1,
            maximum: 4,
            description: "CRS paranoia level. Unset is 1.",
          },
          log_next_paranoia_level: {
            type: "boolean",
            description: "Also run the next level's rules, logging without blocking.",
          },
          inbound_anomaly_threshold: {
            type: "integer",
            minimum: 1,
            maximum: 10000,
            description: "Inbound anomaly score that blocks. Unset is 5.",
          },
          outbound_anomaly_threshold: {
            type: "integer",
            minimum: 1,
            maximum: 10000,
            description: "Outbound anomaly score that blocks. Unset is 4.",
          },
          preset_ids: {
            type: "array",
            items: { type: "integer" },
            description: "WAF preset ids, loaded ahead of the CRS rules on every host",
          },
          plugin_ids: {
            type: "array",
            items: { type: "integer" },
            description: "Installed CRS plugin ids, loaded on every host with the CRS on",
          },
          request_body_limit: {
            type: "integer",
            minimum: 1024,
            maximum: 1073741824,
            description:
              "SecRequestBodyLimit in bytes. Coraza rejects values above 1 GiB. Unset inherits Coraza's default (12.5 MiB when the OWASP CRS is loaded, else 128 MiB)",
          },
          request_body_in_memory_limit: {
            type: "integer",
            minimum: 1024,
            maximum: 1073741824,
            description: "SecRequestBodyInMemoryLimit in bytes; must not exceed request_body_limit",
          },
          request_body_limit_action: {
            type: "string",
            enum: ["Reject", "ProcessPartial"],
            description:
              "SecRequestBodyLimitAction - reject oversized bodies or inspect the buffered part and forward the rest",
          },
        },
        required: ["enabled", "mode", "load_owasp_crs", "custom_directives"],
      },

      // ── Groups & Roles ─────────────────────────────────────────
      Group: {
        type: "object",
        properties: {
          id: { type: "integer" },
          name: { type: "string" },
          description: { type: ["string", "null"] },
          members: { type: "array", items: { $ref: "#/components/schemas/GroupMember" } },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
        required: ["id", "name", "members", "createdAt", "updatedAt"],
      },
      GroupMember: {
        type: "object",
        properties: {
          userId: { type: "integer" },
          email: { type: "string" },
          name: { type: ["string", "null"] },
          createdAt: { type: "string", format: "date-time" },
        },
        required: ["userId", "email", "createdAt"],
      },
      WafPreset: {
        type: "object",
        properties: {
          id: { type: "integer" },
          name: { type: "string" },
          description: { type: ["string", "null"] },
          directives: { type: "string" },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
        required: ["id", "name", "directives", "createdAt", "updatedAt"],
      },
      CrsRegistrySettings: {
        type: "object",
        properties: {
          registries: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                name: { type: "string" },
                url: { type: "string", format: "uri" },
              },
            },
          },
          refreshIntervalHours: { type: "integer" },
          hasGithubToken: { type: "boolean" },
        },
      },
      CrsPlugin: {
        type: "object",
        properties: {
          id: { type: "integer" },
          name: { type: "string" },
          repository: { type: "string", format: "uri" },
          version: { type: "string", description: "Release tag, or commit for an untagged plugin" },
          description: { type: ["string", "null"] },
          ruleIdStart: { type: "integer" },
          ruleIdEnd: { type: "integer" },
          configRules: { type: "string" },
          beforeRules: { type: "string" },
          afterRules: { type: "string" },
          configOverride: { type: ["string", "null"] },
          fileNames: {
            type: "array",
            items: { type: "string" },
            description: "The plugins/ rule files the installed release shipped",
          },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
        required: ["id", "name", "repository", "version", "createdAt", "updatedAt"],
      },
      MtlsAccessRule: {
        type: "object",
        properties: {
          id: { type: "integer" },
          proxyHostId: { type: "integer" },
          pathPattern: { type: "string", description: "The request path, or a prefix ending in *" },
          allowedRoleIds: { type: "array", items: { type: "integer" } },
          allowedCertIds: { type: "array", items: { type: "integer" } },
          denyAll: { type: "boolean" },
          priority: { type: "integer" },
          description: { type: "string", nullable: true },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
      },
      MtlsAccessRuleInput: {
        type: "object",
        required: ["pathPattern"],
        properties: {
          pathPattern: { type: "string" },
          allowedRoleIds: { type: "array", items: { type: "integer" } },
          allowedCertIds: { type: "array", items: { type: "integer" } },
          denyAll: { type: "boolean" },
          priority: { type: "integer" },
          description: { type: "string", nullable: true },
        },
      },
      DnsProviderDefinition: {
        type: "object",
        properties: {
          name: { type: "string", description: "The Caddy module name, e.g. cloudflare" },
          displayName: { type: "string" },
          description: { type: "string" },
          docsUrl: { type: "string" },
          modulePath: { type: "string" },
          fields: {
            type: "array",
            items: {
              type: "object",
              properties: {
                key: { type: "string" },
                label: { type: "string" },
                type: { type: "string", enum: ["string", "password", "duration"] },
                placeholder: { type: "string" },
                description: { type: "string" },
                required: { type: "boolean" },
              },
            },
          },
        },
      },
      MtlsRole: {
        type: "object",
        properties: {
          id: { type: "integer" },
          name: { type: "string" },
          description: { type: ["string", "null"] },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
        required: ["id", "name", "createdAt", "updatedAt"],
      },

      // ── Other resources ─────────────────────────────────────────
      OauthProvider: {
        type: "object",
        description:
          "OAuth/OIDC provider. clientId is masked; the clientSecret is never exposed. callbackUrl is the exact redirect URI to register at the identity provider.",
        properties: {
          id: { type: "string", example: "authino" },
          name: { type: "string", example: "Authino" },
          type: { type: "string", enum: ["oidc", "oauth2"] },
          clientId: { type: "string", readOnly: true, example: "••••41ee" },
          hasClientSecret: { type: "boolean", readOnly: true },
          issuer: { type: ["string", "null"] },
          authorizationUrl: { type: ["string", "null"] },
          tokenUrl: { type: ["string", "null"] },
          userinfoUrl: { type: ["string", "null"] },
          scopes: { type: "string", example: "openid email profile" },
          autoLink: { type: "boolean" },
          enabled: { type: "boolean" },
          source: { type: "string", enum: ["env", "ui"], readOnly: true },
          callbackUrl: {
            type: "string",
            readOnly: true,
            example: "https://cpm.example.com/api/auth/callback/authino",
            description: "Register this URI as the redirect URI in the identity provider",
          },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
        required: [
          "id",
          "name",
          "type",
          "clientId",
          "hasClientSecret",
          "scopes",
          "autoLink",
          "enabled",
          "source",
          "callbackUrl",
          "createdAt",
          "updatedAt",
        ],
      },
      OauthProviderInput: {
        type: "object",
        properties: {
          name: { type: "string", example: "Keycloak" },
          type: { type: "string", enum: ["oidc", "oauth2"], default: "oidc" },
          clientId: { type: "string" },
          clientSecret: { type: "string" },
          issuer: { type: "string", example: "https://sso.example.com/realms/main" },
          authorizationUrl: { type: "string" },
          tokenUrl: { type: "string" },
          userinfoUrl: { type: "string" },
          scopes: { type: "string", default: "openid email profile" },
          autoLink: { type: "boolean", default: false },
          enabled: { type: "boolean", default: true },
        },
        required: ["name", "clientId", "clientSecret"],
      },
      OauthProviderUpdate: {
        type: "object",
        description: "All fields optional. Omitting clientSecret preserves the stored secret.",
        properties: {
          name: { type: "string" },
          type: { type: "string", enum: ["oidc", "oauth2"] },
          clientId: { type: "string" },
          clientSecret: { type: "string" },
          issuer: { type: ["string", "null"] },
          authorizationUrl: { type: ["string", "null"] },
          tokenUrl: { type: ["string", "null"] },
          userinfoUrl: { type: ["string", "null"] },
          scopes: { type: "string" },
          autoLink: { type: "boolean" },
          enabled: { type: "boolean" },
        },
      },
      User: {
        type: "object",
        description: "User account (passwordHash is never exposed)",
        properties: {
          id: { type: "integer" },
          email: { type: "string" },
          username: {
            type: ["string", "null"],
            description:
              "Username for the login page, which signs in by username only, ignoring case; null " +
              "when the account has none. CPM stores only the account's own email address, " +
              "lowercased, when it qualifies and no other account holds it, or one an administrator " +
              "sets (POST /api/v1/users, PUT /api/v1/users/{id})",
          },
          name: { type: ["string", "null"] },
          role: { type: "string", enum: [...APP_ROLES] },
          provider: { type: "string", example: "credentials" },
          subject: { type: "string" },
          avatarUrl: { type: ["string", "null"] },
          status: { type: "string", enum: [...USER_STATUSES] },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
        required: [
          "id",
          "email",
          "role",
          "provider",
          "subject",
          "status",
          "createdAt",
          "updatedAt",
        ],
      },
      AuditLogEvent: {
        type: "object",
        properties: {
          id: { type: "integer" },
          userId: { type: ["integer", "null"] },
          action: { type: "string", example: "proxy_host_created" },
          entityType: { type: "string", example: "proxy_host" },
          entityId: { type: ["integer", "null"] },
          summary: { type: ["string", "null"] },
          createdAt: { type: "string", format: "date-time" },
        },
        required: ["id", "action", "entityType", "createdAt"],
      },
      AuditLogResponse: {
        type: "object",
        properties: {
          events: { type: "array", items: { $ref: "#/components/schemas/AuditLogEvent" } },
          total: { type: "integer" },
          page: { type: "integer" },
          perPage: { type: "integer" },
        },
        required: ["events", "total", "page", "perPage"],
      },
    },
  },
};

/** The writes a change approval policy can hold, each of which may answer 202 instead. */
const APPROVAL_COVERED = [
  /^\/api\/v1\/proxy-hosts(\/\{id\}(\/(forward-auth-access|mtls-access-rules(\/\{ruleId\})?))?|\/bulk)?$/,
  /^\/api\/v1\/l4-proxy-hosts(\/\{id\}|\/bulk)?$/,
  /^\/api\/v1\/access-lists(\/\{id\}(\/(ip-rules|entries(\/\{entryId\})?))?)?$/,
  /^\/api\/v1\/waf-presets(\/\{id\})?$/,
  /^\/api\/v1\/crs-plugins(\/\{id\}(\/update)?)?$/,
  /^\/api\/v1\/settings\/\{group\}$/,
];
for (const [path, operations] of Object.entries(spec.paths)) {
  if (!APPROVAL_COVERED.some((pattern) => pattern.test(path))) continue;
  for (const [method, operation] of Object.entries(operations as Record<string, unknown>)) {
    if (method === "get") continue;
    const responses = (operation as { responses: Record<string, unknown> }).responses;
    responses["202"] = { $ref: "#/components/responses/PendingApproval" };
  }
}

// Serialized once: the document never changes, and stringifying it was the whole cost of a GET.
const SPEC_JSON = JSON.stringify(spec);

export async function GET(request: NextRequest) {
  try {
    await requireApiUser(request);
  } catch (error) {
    return apiErrorResponse(error);
  }
  return new NextResponse(SPEC_JSON, {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "private, max-age=3600",
    },
  });
}
