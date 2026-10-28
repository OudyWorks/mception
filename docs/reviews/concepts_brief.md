# MCeption: OAuth 2.1 Reverse Proxy and Hub for Gemini Spark MCPs

* **Author:** @oudmane
* **Date:** 2026-10-28

## Overview

Gemini Spark requires all remote Model Context Protocol (MCP) integrations to use OAuth 2.1 (Authorization Code flow with PKCE). However, many existing MCP servers rely on static credentials such as API keys, static Bearer tokens, HTTP Basic authentication, or custom headers, without implementing an OAuth 2.1 authorization server.

MCeption is an open-source, Docker-deployable TypeScript reverse proxy and gateway that bridges this gap. It provides:
1. A **Root Management MCP** connected to Gemini Spark via Google OAuth, exposing tools (`register_mcp`, `list_mcps`, `remove_mcp`) to manage upstream remote MCPs conversationally.
2. A **Standalone Web Dashboard** providing a visual alternative to chat commands for viewing registered tools, adding upstream endpoints, and copying ready-to-paste Gemini Connected App URLs.
3. **Virtual Per-User Endpoints** (`{MCEPTION_PUBLIC_URL}/{user_slug}/{identifier}`) that act as compliant OAuth 2.1 servers towards Gemini Spark.
4. A **Consent & Credential Capture Web Flow** during the Gemini OAuth handshake, where the user selects the upstream authentication type and enters required credentials in the browser. Credentials are encrypted and stored in SQLite, then injected into proxied SSE and HTTP requests without exposing secrets to the LLM context.

## Analysis

### Core Technical Mechanisms

1. **UX & Onboarding Flow**:
   - Two-step connection: User adds the Root Manager MCP to Gemini Spark (or accesses the standalone web dashboard), registers the upstream MCP target to receive `{MCEPTION_PUBLIC_URL}/{user_slug}/{identifier}`, and adds that virtual endpoint to Gemini Connected Apps.
   - Dual management interface: Full feature parity between Gemini chat tools and the lightweight web dashboard.

2. **Protocol & Transports**:
   - The MCP specification uses Server-Sent Events (SSE) for server-to-client notifications and HTTP POST for client-to-server JSON-RPC messages.
   - MCeption maintains streaming SSE connections and proxies JSON-RPC messages while preserving message IDs and session identifiers (`sessionId`).
   - Built on Node.js 22 LTS with Fastify or Hono and `@modelcontextprotocol/sdk`.

3. **Multi-Tenancy & Tenant Isolation**:
   - User identity is verified via Google OAuth (`sub` claim). Public paths use an immutable `user_slug` derived from the account.
   - Endpoints are strictly partitioned: an OAuth token issued for `user_a` cannot access routes under `/{user_b}/...`.
   - SQLite manages state using Write-Ahead Logging (WAL) mode across tables: `users`, `registered_mcps`, `credentials`, `oauth_clients`, `auth_codes`, and `tokens`.

4. **Security & Threat Model**:
   - **SSRF Defense**: Strict IP resolution checks at socket connect time block private IP spaces (RFC 1918, loopback `127.0.0.0/8`, link-local `169.254.0.0/16`) by default. An optional environment variable `ALLOW_PRIVATE_NETWORKS=true` allows bridging to local Docker containers if explicitly configured.
   - **Credential Protection**: Upstream secrets are encrypted at rest in SQLite using AES-256-GCM keyed via `MCEPTION_MASTER_KEY`.
   - **OAuth 2.1 Compliance**: Enforces PKCE (`S256`), exact redirect URI validation, single-use authorization codes with a 60-second expiration, and token revocation.

5. **Upstream Credential Lifecycle & Token Refresh**:
   - If an upstream request fails with HTTP 401, MCeption attempts automatic refresh if an upstream refresh token is stored.
   - If refresh fails or static credentials are invalid, MCeption returns an explicit MCP tool error instructing the user to disconnect and re-add the app inside Gemini Connected Apps.

## Goals vs. Non-Goals

### In-Scope Goals
* **Root Management MCP**: Provide tools (`register_mcp`, `list_mcps`, `delete_mcp`) for conversational endpoint setup within Gemini.
* **Standalone Web Dashboard**: Provide a responsive web UI for managing MCP endpoints and copying Gemini connection links.
* **Per-User Virtual Endpoints**: Dynamic routes (`/{user_slug}/{identifier}`) implementing OAuth 2.1 authorization and token endpoints.
* **Upstream Credential Injection**: Browser-based credential input supporting None, Bearer tokens, API Keys (custom headers), Basic Auth, query parameters, and refresh-capable tokens.
* **SSRF Guard**: Socket-level DNS/IP validation blocking internal networks by default.
* **Docker Packaging**: Single-container deployment with mounted volume for SQLite (`/data/mception.db`).

### Out-of-Scope Non-Goals
* **Stdio / Local Process Spawning**: Running local CLI commands (`npx`, Python scripts) inside the container is excluded. Only remote SSE/HTTP MCP services are supported.
* **Full Multi-Tenant SaaS Billing / Quotas**: No billing or multi-organization tenancy models; scoped for self-hosted instances.

## Key Decisions & Staging for Next Steps

1. **Routing Pattern**: Adopt `{MCEPTION_PUBLIC_URL}/{user_slug}/{identifier}` for clean per-user namespacing.
2. **Runtime Stack**: TypeScript with Fastify/Hono and `@modelcontextprotocol/sdk`.
3. **Database**: SQLite with WAL mode via Kysely or Drizzle ORM.
4. **Security Defaults**: AES-256-GCM credential encryption and SSRF blocking active by default.
5. **Next Step**: Proceed to formal design drafting (`/egm-draft`) to specify exact database schemas, route structures, and Docker configurations.
