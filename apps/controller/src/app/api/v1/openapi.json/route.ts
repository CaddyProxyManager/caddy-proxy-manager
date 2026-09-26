import { type NextRequest, NextResponse } from "next/server";
import { requireApiAdmin, apiErrorResponse } from "@/src/lib/api-auth";
import { APP_VERSION } from "@/src/lib/app-version";

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
        parameters: [{ $ref: "#/components/parameters/IdPath" }],
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
        parameters: [{ $ref: "#/components/parameters/IdPath" }],
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
        parameters: [{ $ref: "#/components/parameters/IdPath" }],
        responses: {
          "200": { $ref: "#/components/responses/Ok" },
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
        parameters: [{ $ref: "#/components/parameters/IdPath" }],
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
        parameters: [{ $ref: "#/components/parameters/IdPath" }],
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
        parameters: [{ $ref: "#/components/parameters/IdPath" }],
        responses: {
          "200": { $ref: "#/components/responses/Ok" },
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
        operationId: "createCertificate",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/CertificateInput" },
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
        operationId: "deleteCertificate",
        parameters: [{ $ref: "#/components/parameters/IdPath" }],
        responses: {
          "200": { $ref: "#/components/responses/Ok" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" },
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
        operationId: "deleteAccessList",
        parameters: [{ $ref: "#/components/parameters/IdPath" }],
        responses: {
          "200": { $ref: "#/components/responses/Ok" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" },
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
          "The array sent becomes the whole set, in its order. An empty array removes every rule.",
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
              enum: [
                "general",
                "acme",
                "cloudflare",
                "dns-provider",
                "authentik",
                "forward-auth",
                "metrics",
                "logging",
                "dns",
                "upstream-dns",
                "geoblock",
                "waf",
                "error-pages",
                "default-response",
                "tailscale",
              ],
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
              enum: [
                "general",
                "acme",
                "cloudflare",
                "dns-provider",
                "authentik",
                "forward-auth",
                "metrics",
                "logging",
                "dns",
                "upstream-dns",
                "geoblock",
                "waf",
                "error-pages",
                "default-response",
                "tailscale",
              ],
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
                  email: { type: "string" },
                  role: { type: "string", enum: ["admin", "user"] },
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
        parameters: [{ $ref: "#/components/parameters/IdPath" }],
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
        parameters: [{ $ref: "#/components/parameters/IdPath" }],
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
          "Saves which plugins the Caddy image should be built with. Does not rebuild - plugins are compiled in, so the running container keeps its current set until a rebuild is triggered.",
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
      IdPath: {
        name: "id",
        in: "path",
        required: true,
        schema: { type: "integer" },
        description: "Resource ID",
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
      Token: {
        type: "object",
        properties: {
          id: { type: "integer" },
          name: { type: "string" },
          createdBy: { type: "integer" },
          createdAt: { type: "string", format: "date-time" },
          lastUsedAt: { type: ["string", "null"], format: "date-time" },
          expiresAt: { type: ["string", "null"], format: "date-time" },
        },
        required: ["id", "name", "createdBy", "createdAt"],
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
            enum: ["random", "round_robin", "least_conn", "ip_hash", "first"],
          },
          tryDuration: { type: ["string", "null"] },
          tryInterval: { type: ["string", "null"] },
          retries: { type: ["integer", "null"] },
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
              unhealthyLatency: { type: ["string", "null"] },
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
          timeout: { type: ["string", "null"], example: "5s" },
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
          mode: { type: "string", enum: ["Off", "On"] },
          load_owasp_crs: { type: "boolean", description: "Load OWASP Core Rule Set" },
          custom_directives: { type: "string", description: "Custom WAF directives" },
          excluded_rule_ids: {
            type: "array",
            items: { type: "integer" },
            description: "Rule IDs to exclude",
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
        },
        required: ["enabled"],
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
                category: { type: "string", enum: ["proxy", "security", "dns"] },
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
          name: { type: "string" },
          description: { type: ["string", "null"], description: "Free-text notes" },
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
          name: { type: "string" },
          description: { type: ["string", "null"], description: "Free-text notes" },
          protocol: { type: "string", enum: ["tcp", "udp"] },
          listenAddress: {
            type: "string",
            example: ":5432",
            description:
              "Address to listen on: ':port', 'host:port', or '[ipv6]:port'. An IPv6 literal " +
              "must be bracketed - unbracketed, its last group is indistinguishable from a port. " +
              "Ports 80, 443, 2019, 3000, 9090 and the enabled metrics port are reserved and rejected.",
          },
          upstreams: { type: "array", items: { type: "string" }, example: ["db-server:5432"] },
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
          protocol: { type: "string", enum: ["tcp", "udp"] },
          listenAddress: {
            type: "string",
            example: ":5432",
            description:
              "':port', 'host:port', or '[ipv6]:port'. Ports 80, 443, 2019, 3000, 9090 and the " +
              "enabled metrics port are reserved and rejected.",
          },
          upstreams: { type: "array", items: { type: "string" }, example: ["db:5432"] },
          matcherType: { type: "string", enum: ["none", "tls_sni", "http_host", "proxy_protocol"] },
          matcherValue: { type: "array", items: { type: "string" } },
          tlsTermination: { type: "boolean" },
          proxyProtocolVersion: { type: ["string", "null"], enum: ["v1", "v2", null] },
          proxyProtocolReceive: { type: "boolean" },
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
        },
        required: ["id", "name", "type", "domainNames", "hasPrivateKey", "createdAt", "updatedAt"],
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
          "createdAt",
          "updatedAt",
        ],
      },
      AccessListIpRule: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["allow", "deny"] },
          cidr: {
            type: "string",
            example: "192.168.1.0/24",
            description:
              "An IPv4 or IPv6 address or CIDR range. A bare address is stored as a /32 or /128.",
          },
          note: { type: ["string", "null"] },
        },
        required: ["action", "cidr"],
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
        },
        required: ["providers", "default"],
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
        },
        required: ["providers", "default"],
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
          mode: { type: "string", enum: ["Off", "On"] },
          load_owasp_crs: { type: "boolean" },
          custom_directives: { type: "string" },
          excluded_rule_ids: { type: "array", items: { type: "integer" } },
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
          name: { type: ["string", "null"] },
          role: { type: "string", enum: ["admin", "user", "viewer"] },
          provider: { type: "string", example: "credentials" },
          subject: { type: "string" },
          avatarUrl: { type: ["string", "null"] },
          status: { type: "string", enum: ["active", "inactive"] },
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

// Serialized once: the document never changes, and stringifying it was the whole cost of a GET.
const SPEC_JSON = JSON.stringify(spec);

export async function GET(request: NextRequest) {
  try {
    await requireApiAdmin(request);
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
