# MCeption: OAuth 2.1 Reverse Proxy and Hub for Gemini Spark MCPs

*   **Author:** @oudmane
*   **Status:** Approved
*   **Date:** 2026-10-28

--------------------------------------------------------------------------------

## Overview

Gemini Spark enforces OAuth 2.1 authentication (Authorization Code flow with mandatory PKCE) for all remote Model Context Protocol (MCP) tool integrations. In contrast, existing MCP servers predominantly rely on static authorization schemes: pre-shared API keys, static HTTP Bearer tokens, HTTP Basic authentication, or custom HTTP headers. Because standard MCP servers lack an OAuth 2.1 authorization server, Gemini Spark cannot connect to them directly.

MCeption is an open-source reverse proxy deployable as a single Docker container. It resolves this protocol mismatch by serving as an OAuth 2.1 bridge between Gemini Spark and upstream MCP servers. Operators register upstream MCP endpoints and their corresponding static credentials through a lightweight Web Dashboard. When Gemini Spark connects to an endpoint, MCeption executes the OAuth 2.1 authorization handshake, issues local access and refresh tokens, intercepts outbound Server-Sent Events (SSE) streams to rewrite the message routing endpoint, and injects decrypted credentials into outbound SSE connections and JSON-RPC HTTP POST requests. Upstream credentials remain excluded from LLM context windows while satisfying Gemini Spark's OAuth 2.1 requirements.

## Problem Statement

Gemini Spark's security model mandates OAuth 2.1 with PKCE for all third-party remote tools. This architecture guarantees user authorization consent and standard token lifecycle handling. However, it introduces three operational challenges:

1.  **Incompatibility with Ecosystem MCP Servers**: Standard community and enterprise MCP servers rarely implement OAuth 2.1 authorization servers. Requiring upstream maintainers to implement OAuth 2.1, database state management, and user consent pages precludes integration with existing tools.
2.  **Credential Leakage Risks in LLM Context**: Attempting to bypass auth mismatches by instructing the LLM to pass API keys or secrets via tool arguments exposes credentials to prompt injection attacks, context logs, and provider LLM training pipelines.
3.  **Fragmented Configuration Overhead**: Managing multiple MCP tools across Gemini Spark requires a centralized management and routing interface rather than disparate per-tool infrastructure.

MCeption bridges these protocols: Gemini Spark connects via OAuth 2.1, while MCeption translates requests and manages upstream authentication.

## Goals & Non-Goals

### Goals

*   **Compliant OAuth 2.1 Bridge**: Implement RFC 6749 and OAuth 2.1 specifications (Authorization Code grant with mandatory PKCE `S256` verification) to satisfy Gemini Spark client requirements.
*   **Clean Virtual Endpoints**: Provide dynamic route namespaces (`/{identifier}`) that isolate MCP target configurations, OAuth tokens, and upstream sessions per tool.
*   **Secure Credential Injection**: Collect upstream authentication schemes (Bearer tokens, API keys in headers/query params, Basic Auth, custom headers) in the Web Dashboard and encrypt them at rest using AES-256-GCM.
*   **Single Web Dashboard Control Plane**: Provide a web interface for registering upstream endpoints, configuring credentials, inspecting connection status, and copying Gemini Connected App URLs.
*   **Developer-Friendly Network Defaults**: Allow private subnet (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`) and loopback (`127.0.0.0/8`) upstream connections by default to support local Docker and development workflows, while blocking cloud metadata endpoints (`169.254.169.254`, `fe80::/10`). Provide a `BLOCK_PRIVATE_NETWORKS=true` toggle for public cloud deployments.
*   **Single-Container Deployment**: Package the entire proxy, management dashboard, and SQLite database with Write-Ahead Logging (WAL) into a single Docker image.

### Non-Goals

*   **Multi-Tenant SaaS Billing and User Hierarchies**: MCeption is designed for individual developers and self-hosted engineering teams; subscription billing, organization hierarchies, and multi-tenant user account provisioning are out of scope. Management is secured via an administrative bearer token (`ADMIN_API_KEY`).
*   **Local Stdio Subprocess Execution**: MCeption will not spawn or manage local subprocesses (e.g., `npx -y @modelcontextprotocol/server-...` or local Python scripts). All upstream MCP servers must run as HTTP/SSE network services.
*   **Modifying Upstream Tool Schemas**: MCeption does not rewrite JSON-RPC method payloads, sanitize tool arguments, or alter tool schema outputs. It operates strictly as an authentication and transport proxy (with necessary transport-level SSE `endpoint` URI rewriting).
*   **Arbitrary Protocol Translation**: Support is restricted to HTTP SSE and HTTP POST JSON-RPC transports defined in the Model Context Protocol specification. WebSockets and gRPC transports are not supported.

## Critical User Journeys (CUJs)

### CUJ 1: Register Upstream MCP and Connect to Gemini Spark

*   **Given**: An upstream remote MCP server requiring a static API key header (`X-API-Key: secret123`), and a running MCeption container.
*   **When**: The user opens the MCeption dashboard, enters the admin API key, registers an upstream URL `http://weather-service:8080/sse` with identifier `weather`, inputs the `X-API-Key: secret123` header credential, and pastes the resulting virtual URL (`https://mception.example.com/weather`) into Gemini Spark's Connected Apps configuration.
*   **Then**: Gemini initiates the OAuth 2.1 PKCE handshake. MCeption validates the request, issues an authorization code, exchanges it for an access token, and completes the handshake without prompting for credentials again. Subsequent tool calls from Gemini have the `X-API-Key` header automatically injected by MCeption.

### CUJ 2: Endpoint Management and Revocation via Web Dashboard

*   **Given**: A previously registered virtual endpoint `jira` associated with an active Gemini Spark integration.
*   **When**: The user opens the MCeption dashboard and clicks "Delete" on the `jira` endpoint.
*   **Then**: MCeption revokes issued access and refresh tokens, deletes the encrypted credential record and endpoint configuration from SQLite, and rejects any subsequent tool requests with HTTP 404.

--------------------------------------------------------------------------------

## Proposed Architecture

### Architectural Overview

MCeption acts as an intermediary reverse proxy between the Gemini Spark client and remote upstream Model Context Protocol (MCP) servers. The architecture separates management operations from runtime proxying, while persisting endpoint metadata and encrypted credentials in a local SQLite database configured with Write-Ahead Logging (WAL).

```text
+--------------------------------------------------------------------+
|                         Gemini Spark                               |
+--------------------------------------------------------------------+
                   |                                  |
                   | 1. OAuth 2.1 (PKCE S256)         | 2. MCP Tool Requests
                   |    Authorization & Token Flow    |    (SSE / POST)
                   v                                  v
+--------------------------------------------------------------------+
|                             MCeption                               |
|                                                                    |
|  +---------------------------+    +-----------------------------+  |
|  | Web Dashboard & Admin API |    | Virtual Endpoint Subsystem  |  |
|  | (GET /, /api/mcps)        |    | /{identifier}/...           |  |
|  | Protected by ADMIN_API_KEY|    | - OAuth 2.1 Server          |  |
|  +---------------------------+    | - SSE Endpoint Rewriter     |  |
|                |                  | - Credential Injector       |  |
|                v                  +-----------------------------+  |
|  +-----------------------------------------------+       |         |
|  |             SQLite (WAL Mode)                 |<------+         |
|  |  - Registered Endpoints                       |                 |
|  |  - Encrypted Credentials (AES-256-GCM)        |                 |
|  |  - OAuth Authorization Codes & Tokens         |                 |
|  +-----------------------------------------------+                 |
|                                                          |         |
|                                  Outbound Request Filter |         |
|                                  (SSRF Guard Active)     |         |
+----------------------------------------------------------|---------+
                                                           |
                                                           v
                                            +-----------------------------+
                                            | Upstream MCP Server         |
                                            | (Remote HTTP SSE / POST)    |
                                            +-----------------------------+
```

### Route Topology and Namespacing

MCeption exposes two primary route categories under its base URL:

1.  **Management Dashboard & Admin API**:
    *   `GET /`: Serves the static Web Dashboard UI.
    *   `GET /healthz`: Healthcheck endpoint returning HTTP 200 `{ "status": "ok" }`.
    *   `GET /api/mcps`: REST endpoint returning all registered endpoints (requires `Authorization: Bearer <ADMIN_API_KEY>`).
    *   `POST /api/mcps`: REST endpoint creating a new upstream endpoint along with its encrypted credential payload.
    *   `PUT /api/mcps/:identifier`: REST endpoint updating an endpoint URL or credentials.
    *   `DELETE /api/mcps/:identifier`: REST endpoint deleting an endpoint and revoking all associated tokens.

2.  **Virtual Endpoint Subsystem (`/{identifier}/...`)**:
    *   `GET /{identifier}/.well-known/oauth-authorization-server`: RFC 8414 metadata endpoint returning authorization and token endpoints, scopes (`["mcp"]`), and supported PKCE methods (`["S256"]`).
    *   `GET /{identifier}/oauth/authorize`: Validates `client_id`, `redirect_uri`, `response_type=code`, `code_challenge`, and `code_challenge_method=S256`. Generates an ephemeral authorization code (60-second TTL), records the hashed code, and redirects immediately to `redirect_uri` with `code` and `state`.
    *   `POST /{identifier}/oauth/token`: Exchanges authorization code and `code_verifier` for an access token (1-hour TTL) and refresh token (30-day TTL). Supports `grant_type=authorization_code` and `grant_type=refresh_token`.
    *   `GET /{identifier}/sse`: Authenticated SSE endpoint. Validates Bearer token, connects to upstream SSE, rewrites the incoming `endpoint` event to point back to MCeption's message route, and pipes events to Gemini Spark.
    *   `POST /{identifier}/messages`: Authenticated JSON-RPC endpoint. Validates Bearer token, maps the incoming proxy session ID to the upstream session ID, decrypts credentials, injects them into outbound headers/query parameters, and forwards the JSON-RPC payload to upstream.

### Data Model and Storage (SQLite + WAL)

MCeption stores configuration, cryptographic state, and session tokens in a local SQLite file (`/data/mception.db`). WAL mode (`PRAGMA journal_mode = WAL;`) and busy timeouts (`PRAGMA busy_timeout = 5000;`) ensure non-blocking reads during concurrent proxy requests.

```sql
CREATE TABLE registered_mcps (
    id TEXT PRIMARY KEY,
    identifier TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    upstream_url TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE credentials (
    id TEXT PRIMARY KEY,
    mcp_id TEXT UNIQUE NOT NULL REFERENCES registered_mcps(id) ON DELETE CASCADE,
    auth_type TEXT NOT NULL CHECK(auth_type IN ('none', 'bearer', 'api_key_header', 'api_key_query', 'basic', 'custom_headers')),
    encrypted_payload BLOB NOT NULL,
    iv BLOB NOT NULL,
    tag BLOB NOT NULL,
    key_version INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE auth_codes (
    code_hash TEXT PRIMARY KEY,
    mcp_id TEXT NOT NULL REFERENCES registered_mcps(id) ON DELETE CASCADE,
    code_challenge TEXT NOT NULL,
    code_challenge_method TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER
);

CREATE TABLE tokens (
    token_hash TEXT PRIMARY KEY,
    token_type TEXT NOT NULL CHECK(token_type IN ('access', 'refresh')),
    mcp_id TEXT NOT NULL REFERENCES registered_mcps(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    revoked_at INTEGER
);

CREATE INDEX idx_registered_mcps_identifier ON registered_mcps(identifier);
CREATE INDEX idx_tokens_token_hash ON tokens(token_hash);
CREATE INDEX idx_tokens_mcp_id ON tokens(mcp_id);
CREATE INDEX idx_auth_codes_code_hash ON auth_codes(code_hash);
```

### Credential Encryption Subsystem

1.  **Key Management**: The server reads a 32-byte master key from `MCEPTION_MASTER_KEY` (hex or base64 encoded). In development mode, if absent, a persistent key is generated and saved to `/data/.dev_master_key` with permissions `0600` so container restarts preserve decryption capability.
2.  **Cipher & Parameters**: AES-256-GCM.
    *   **Initialization Vector (IV)**: 12 cryptographically random bytes generated via `crypto.randomBytes(12)` per write.
    *   **Authentication Tag**: 16 bytes generated upon finalization and stored alongside ciphertext.
    *   **Key Versioning**: `key_version` column enables future key rotation without data loss.
3.  **Credential Payload Contract**: Plaintext credentials are typed as a strict TypeScript discriminated union before encryption and after decryption:

```typescript
export type CredentialPayload =
  | { type: 'none' }
  | { type: 'bearer'; token: string }
  | { type: 'api_key_header'; headerName: string; apiKey: string }
  | { type: 'api_key_query'; paramName: string; apiKey: string }
  | { type: 'basic'; username: string; password: string }
  | { type: 'custom_headers'; headers: Record<string, string> };
```

4.  **In-Memory Lifecycle**: Plaintext credentials exist only during the lifetime of an outbound HTTP dispatch or SSE connection setup. Plaintext values are never written to disk, context objects, or log statements.

### SSRF Protection Engine

Before dispatching outbound requests to upstream MCP servers, MCeption performs address verification:

1.  Resolve hostname via `dns.promises.lookup` with `all: true`.
2.  Inspect all resolved IPv4 and IPv6 addresses against blocked ranges:
    *   **Always Blocked**: Link-local / Cloud metadata endpoint `169.254.169.254`, IPv6 link-local `fe80::/10`.
    *   **Conditional**: RFC 1918 private subnets (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`) and loopback (`127.0.0.0/8`, `::1/128`) are **allowed by default** to support local containers and localhost development. If `BLOCK_PRIVATE_NETWORKS=true` is set, these ranges are blocked.
3.  **Redirect Prevention**: Outbound HTTP requests disable automatic redirect following (`maxRedirects: 0`). Any HTTP 3xx response from upstream is treated as an upstream error or forwarded explicitly without following, preventing redirect-based SSRF bypasses.
4.  **TLS SNI**: When connecting via HTTPS, TLS socket configuration sets `servername` to the target hostname to prevent TLS verification failures when pinning socket destinations.

### Transport & Proxy Subsystem

1.  **SSE Streaming & Endpoint Rewriting (`GET /{identifier}/sse`)**:
    *   Gemini connects with `Authorization: Bearer <token>`.
    *   MCeption validates token validity, finds the registered upstream URL and decrypted credentials, and connects to upstream `GET <upstream_url>`.
    *   **Endpoint Rewriting**: In the MCP SSE protocol, upstream immediately sends an `endpoint` event containing its message URL (e.g. `event: endpoint\ndata: /messages?sessionId=upstream_sid`). MCeption intercepts this event, generates a local proxy session ID `proxy_sid`, stores the mapping `sessionMap.set(proxy_sid, { upstreamUrl, upstreamSessionId: upstream_sid, mcpId })`, and emits the rewritten event down to Gemini:
        ```text
        event: endpoint
        data: /<identifier>/messages?sessionId=<proxy_sid>
        ```
    *   Pipes subsequent SSE `message` events from upstream to Gemini Spark.
    *   Maintains keep-alive comments (`: ping\n\n`) every 15 seconds.
2.  **JSON-RPC Message Relay (`POST /{identifier}/messages?sessionId=<proxy_sid>`)**:
    *   Gemini posts JSON-RPC messages with the active `sessionId=<proxy_sid>`.
    *   MCeption resolves the session mapping to obtain the upstream target URL and `upstreamSessionId`.
    *   Decrypts upstream credentials and applies them according to the configured scheme:
        *   `bearer`: Injects `Authorization: Bearer <token>`.
        *   `api_key_header`: Injects `<headerName>: <apiKey>`.
        *   `api_key_query`: Appends `?<paramName>=<apiKey>` to upstream URL.
        *   `basic`: Injects `Authorization: Basic base64(<username>:<password>)`.
        *   `custom_headers`: Injects specified header key-value pairs.
    *   Forwards the JSON-RPC payload to `<upstream_url>?sessionId=<upstreamSessionId>`.
    *   Returns HTTP 202 Accepted to Gemini. Asynchronous JSON-RPC responses emitted by upstream flow back down to Gemini via the open SSE stream.
3.  **Error Handling**:
    *   If upstream returns HTTP 401 Unauthorized, MCeption emits an explicit JSON-RPC error down the SSE stream:
        ```json
        {
          "jsonrpc": "2.0",
          "error": {
            "code": -32001,
            "message": "Upstream authentication failed. Please update credentials in the MCeption dashboard."
          },
          "id": null
        }
        ```

--------------------------------------------------------------------------------

## Risks & Mitigations

### 1. Upstream SSE Stream Disconnection
*   **Risk**: Upstream MCP servers may drop long-lived SSE connections due to network timeouts, container restarts, or reverse proxy idle cutoffs.
*   **Mitigation**: MCeption monitors upstream stream closures. When an upstream stream drops, MCeption cleans up the corresponding session mapping and closes Gemini's downstream SSE connection, prompting Gemini Spark's MCP client to reconnect and establish a fresh session. MCeption sends `: ping` keep-alives every 15 seconds to prevent intermediate proxy disconnects.

### 2. Master Key Loss or Rotation
*   **Risk**: If `MCEPTION_MASTER_KEY` is lost, all stored upstream credentials become permanently undecryptable. If the key is changed without a migration path, existing endpoints fail.
*   **Mitigation**: Every credential record stores a `key_version`. In development mode, auto-generated keys are persisted to `/data/.dev_master_key` so restarts do not invalidate stored credentials. In production, startup checks verify that `MCEPTION_MASTER_KEY` can decrypt existing credentials; if not, startup aborts immediately with an actionable configuration error rather than serving failing proxy requests.

### 3. SQLite Concurrency Contention
*   **Risk**: Under high concurrent load with multiple active SSE streams and frequent token updates, SQLite write locks could block read operations.
*   **Mitigation**: Database connection initialization enforces `PRAGMA journal_mode = WAL;` and `PRAGMA busy_timeout = 5000;`. WAL mode permits concurrent readers alongside an active writer, and the 5-second busy timeout prevents lock errors under transient write bursts.

### 4. Open Redirect Risks via OAuth Clients
*   **Risk**: In OAuth 2.1 PKCE flows, an attacker could supply an arbitrary `redirect_uri` to steal authorization codes.
*   **Mitigation**: MCeption validates that the `redirect_uri` in `/oauth/authorize` matches an allowed pattern (Google/Gemini Connected Apps domains or an explicit `ALLOWED_REDIRECT_URIS` environment variable). Ephemeral authorization codes expire in 60 seconds and are single-use (`used_at` timestamp check).

--------------------------------------------------------------------------------

## Alternatives Considered

### Alternative A: LLM-Mediated Credential Injection
*   **Description**: Instruct Gemini Spark in system prompts or tool schemas to pass API keys directly as tool call arguments.
*   **Pros**: Requires no intermediary reverse proxy or token translation layer.
*   **Cons**: Exposes plaintext secrets in chat logs, LLM context windows, and model training pipelines. Fails because Gemini Spark mandates OAuth 2.1 PKCE verification before connecting remote MCP tools.
*   **Reason for Rejection**: Violates basic credential security principles and fails Gemini Spark connection prerequisites.

### Alternative B: Local Subprocess Spawning (`stdio` Bridge)
*   **Description**: Run MCP packages (e.g. `npx @modelcontextprotocol/server-...`) as local child processes inside the MCeption container and bridge `stdio` to HTTP.
*   **Pros**: Supports single-user local MCP CLI packages without separate hosting.
*   **Cons**: Introduces container breakout risks, requires bundling heavy Python and Node runtimes, and risks zombie processes.
*   **Reason for Rejection**: Incompatible with a lightweight, secure network reverse proxy. Users should host upstream MCP servers independently in isolated containers.

### Alternative C: External Dedicated OAuth Server (Keycloak / Ory Hydra)
*   **Description**: Delegate OAuth 2.1 issuance to Keycloak or Ory Hydra, using MCeption purely as a resource server.
*   **Pros**: Reuses standards-compliant OAuth 2.1 reference implementations.
*   **Cons**: Requires a secondary database (PostgreSQL) and significant container footprint, destroying single-container deployability.
*   **Reason for Rejection**: Exceeds targeted operational complexity requirements and conflicts with single-container deployment constraints.

--------------------------------------------------------------------------------

## Non-Functional Requirements

### Security & Privacy
*   **Zero-Plaintext at Rest**: Upstream secrets are encrypted using AES-256-GCM before writing to SQLite. Master key is supplied via environment variable or persisted dev file with `0600` permissions.
*   **Admin API Security**: Management endpoints (`/api/mcps`, dashboard mutation routes) require a pre-shared `ADMIN_API_KEY`.
*   **Ephemeral Code Expiration**: OAuth authorization codes expire in 60 seconds and are strictly single-use. Tokens are revocable on demand.
*   **SSRF Hardening**: Pre-flight DNS resolution blocks cloud metadata (`169.254.169.254`) by default. Automatic 3xx redirect following is disabled (`maxRedirects: 0`).

### Performance & Latency
*   **Proxy Overhead**: Added processing latency must remain under 15ms p95 (excluding upstream network round-trips) for standard JSON-RPC tool dispatches.
*   **Memory Footprint**: Container memory usage remains below 128MB under steady-state operation with up to 50 active SSE streams.
*   **Non-Blocking IO**: SQLite write operations (token updates) do not block concurrent read proxying via WAL mode.

--------------------------------------------------------------------------------

## Detailed Implementation Plan

The implementation is partitioned into five sequential, verifiable phases. Each phase leaves the codebase in a stable, buildable, and testable state.

### Phase 1: Scaffolding, Core Storage & Cryptography

#### 1. `package.json`
*   **Scope**: Project Manifest & Dependencies
*   **Details**: Define `fastify`, `@fastify/cors`, `@fastify/static`, `better-sqlite3`, `kysely`, `zod`, `pino`. Dev dependencies: `typescript`, `@types/node`, `@types/better-sqlite3`, `vitest`, `tsx`. Scripts: `build`, `start`, `dev`, `test`, `lint`.

#### 2. `tsconfig.json`
*   **Scope**: TypeScript Compiler Configuration
*   **Details**: Target `ES2023`, module `NodeNext`, strict mode enabled, source maps enabled.

#### 3. `src/config.ts`
*   **Scope**: Runtime Configuration Validator
*   **Details**: Zod schema validating `process.env`:
    *   `PORT`: `z.coerce.number().default(3000)`
    *   `LOG_LEVEL`: `z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info')`
    *   `MCEPTION_PUBLIC_URL`: `z.string().url().transform(url => url.replace(/\/$/, ''))`
    *   `MCEPTION_MASTER_KEY`: `z.string().min(32).optional()`
    *   `ADMIN_API_KEY`: `z.string().min(8)`
    *   `BLOCK_PRIVATE_NETWORKS`: `z.coerce.boolean().default(false)`
    *   `ALLOWED_REDIRECT_URIS`: `z.string().optional()`
    *   `DATABASE_PATH`: `z.string().default('/data/mception.db')`

#### 4. `src/db/connection.ts` & `src/db/types.ts`
*   **Scope**: SQLite Driver & Database Schema Types
*   **Details**: Initializes `better-sqlite3` instance with PRAGMAs (`journal_mode = WAL`, `busy_timeout = 5000`, `foreign_keys = ON`, `synchronous = NORMAL`). Wraps in Kysely instance. Exports TypeScript interfaces for `RegisteredMcpTable`, `CredentialTable`, `AuthCodeTable`, and `TokenTable`.

#### 5. `src/db/migrations.ts`
*   **Scope**: Automated Migration Runner
*   **Details**: Checks `PRAGMA user_version`. Version 1 executes DDL statements creating `registered_mcps`, `credentials`, `auth_codes`, and `tokens` tables and indexes, updating `PRAGMA user_version = 1`.

#### 6. `src/crypto/encryption.ts`
*   **Scope**: AES-256-GCM Encryption Utility
*   **Details**: Implements `encryptCredential(payload: CredentialPayload, masterKey: Buffer): { ciphertext: Buffer, iv: Buffer, tag: Buffer }` and `decryptCredential(ciphertext: Buffer, iv: Buffer, tag: Buffer, masterKey: Buffer): CredentialPayload`. Implements master key resolution (reading from config or creating persistent `/data/.dev_master_key`).

#### 7. `src/crypto/pkce.ts`
*   **Scope**: OAuth 2.1 PKCE Verification
*   **Details**: Implements `verifyPkce(verifier: string, challenge: string, method: string): boolean`. Generates SHA-256 hash of `verifier`, converts to Base64URL, checks buffer length equality, and uses `crypto.timingSafeEqual` against `challenge`. Rejects methods other than `S256`.

#### 8. `tests/unit/crypto.test.ts` & `tests/helpers/test-db.ts`
*   **Scope**: Foundation Unit Tests & DB Harness
*   **Details**: Tests encryption/decryption roundtrips across all `CredentialPayload` types, tampered tag verification, PKCE S256 verification, and SQLite in-memory migration initialization.
*   **Verification Gate**: `npm run test:unit` passes 100%.

---

### Phase 2: Security & Network Guard

#### 9. `src/security/ssrf.ts`
*   **Scope**: Outbound Address & Redirect Validator
*   **Details**:
    *   `isIpAllowed(ip: string, blockPrivate: boolean): boolean`: Blocks `169.254.169.254`, `fe80::/10`. Blocks RFC 1918 and loopback only if `blockPrivate` is true.
    *   `validateTargetUrl(urlStr: string, blockPrivate: boolean): Promise<string>`: Resolves DNS and validates all IP addresses before connection.
    *   Configures HTTP/HTTPS fetch options with `redirect: 'manual'` (`maxRedirects: 0`).

#### 10. `tests/unit/ssrf.test.ts`
*   **Scope**: Network Security Unit Tests
*   **Details**: Asserts `169.254.169.254` is blocked in all modes. Asserts `127.0.0.1` and `172.17.0.2` are allowed by default and blocked when `blockPrivate=true`. Asserts public IPs (`8.8.8.8`) are allowed.
*   **Verification Gate**: `npm run test:unit` passes with SSRF coverage.

---

### Phase 3: OAuth 2.1 Engine

#### 11. `src/oauth/server.ts`
*   **Scope**: OAuth 2.1 Discovery & Token Handshake Routes
*   **Details**: Registers Fastify routes under `/{identifier}/`:
    *   `GET /.well-known/oauth-authorization-server`: Returns metadata per RFC 8414.
    *   `GET /oauth/authorize`: Validates parameters (`response_type=code`, `code_challenge_method=S256`, `redirect_uri`). Generates random authorization code, hashes into `auth_codes` table with 60-second TTL, and returns HTTP 302 redirect to `redirect_uri?code=...&state=...`.
    *   `POST /oauth/token`: Handles `grant_type=authorization_code` (validates PKCE, marks code used, returns access and refresh tokens) and `grant_type=refresh_token` (rotates refresh token, issues new access token). Returns RFC 6749 JSON response: `{ access_token, token_type: "Bearer", expires_in: 3600, refresh_token }`.

#### 12. `tests/integration/oauth.test.ts` & `tests/helpers/test-app.ts`
*   **Scope**: OAuth Integration Tests & Fastify Test App Harness
*   **Details**: Spawns test Fastify instance. Verifies discovery endpoint, authorization code issuance, PKCE validation on token exchange, rejection of reused authorization codes, and refresh token rotation.
*   **Verification Gate**: `npm run test:integration` passes OAuth lifecycle test suite.

---

### Phase 4: MCP Reverse Proxy Subsystem

#### 13. `src/proxy/sse.ts`
*   **Scope**: SSE Connection & Endpoint Rewriting Gateway
*   **Details**: Handles `GET /{identifier}/sse`:
    *   Validates `Authorization: Bearer <token>` against `tokens` table.
    *   Retrieves upstream URL and decrypted credentials.
    *   Opens upstream SSE stream using SSRF-validated client.
    *   Intercepts initial `endpoint` event, records session mapping in memory (`proxySessionId` -> `upstreamSessionId`), and rewrites event data to `/{identifier}/messages?sessionId=<proxySessionId>`.
    *   Streams subsequent message events down to Gemini Spark, maintaining `: ping` heartbeats every 15s.

#### 14. `src/proxy/messages.ts`
*   **Scope**: JSON-RPC Relay & Credential Decorator
*   **Details**: Handles `POST /{identifier}/messages?sessionId=<proxySessionId>`:
    *   Resolves active session mapping.
    *   Injects decrypted credentials into outbound headers or query parameters according to `auth_type`.
    *   Dispatches payload to upstream message URL.
    *   Returns HTTP 202 Accepted. Propagates upstream 401s as JSON-RPC error code `-32001`.

#### 15. `tests/integration/proxy.test.ts` & `tests/helpers/mock-upstream.ts`
*   **Scope**: Proxy Integration Tests & Mock Upstream MCP Server
*   **Details**: Mock server exposes `/sse` (emitting `endpoint` and `message` events) and `/messages`. Tests end-to-end tool call flow, verifying that credentials (Bearer, API Key header, Basic) are correctly received upstream and that Gemini receives the rewritten endpoint URI.
*   **Verification Gate**: `npm run test:integration` passes proxy test suite.

---

### Phase 5: Web Dashboard, Assembly & Packaging

#### 16. `src/web/routes.ts` & `src/web/public/index.html`
*   **Scope**: Management API & UI
*   **Details**:
    *   `GET /healthz`: Returns `{ "status": "ok" }`.
    *   `GET /api/mcps`, `POST /api/mcps`, `DELETE /api/mcps/:identifier`: REST CRUD endpoints protected by `ADMIN_API_KEY`.
    *   Single-page dashboard (HTML + vanilla JS) displaying registered MCPs, connection URLs (`{MCEPTION_PUBLIC_URL}/{identifier}`), credential configuration modal, and status indicators.

#### 17. `src/index.ts`
*   **Scope**: Application Lifecycle & Bootstrapper
*   **Details**: Validates config, runs SQLite migrations, starts Fastify server on `PORT`, and registers graceful shutdown hooks (`SIGTERM`, `SIGINT`) to close database connection cleanly.

#### 18. `Dockerfile`, `docker-compose.yml`, `.env.example`, `README.md`
*   **Scope**: Deployment Assets & Documentation
*   **Details**:
    *   Multi-stage Dockerfile based on `node:22-alpine`, installs build tools for `better-sqlite3`, emits compiled JS to `dist/`, runs as non-root user `mception`.
    *   `docker-compose.yml` mounts named volume `mception_data:/data`.
    *   `.env.example` documents `PORT`, `MCEPTION_PUBLIC_URL`, `ADMIN_API_KEY`, `MCEPTION_MASTER_KEY`, `BLOCK_PRIVATE_NETWORKS`, `DATABASE_PATH`.
    *   `README.md` documents deployment and Gemini Spark Connected Apps connection steps.

---

## Verification Plan

*   **Compilation / Build**:
    *   `npm run build`: Executes `tsc -p tsconfig.json` and emits compiled JavaScript to `dist/`.
*   **Unit Tests**:
    *   `npm run test:unit`: Vitest suite covering cryptography, PKCE buffer verification, and SSRF address policies. Target: 100% branch coverage on security modules.
*   **Integration Tests**:
    *   `npm run test:integration`: Vitest suite covering OAuth 2.1 PKCE discovery/token lifecycle and end-to-end MCP SSE proxying with mock upstream servers.
*   **Container Build Verification**:
    *   `docker build -t mception:test .`: Verifies multi-stage compilation, non-root user setup, volume persistence, and healthcheck functionality.
