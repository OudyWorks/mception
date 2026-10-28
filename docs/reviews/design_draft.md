# MCeption: OAuth 2.1 Reverse Proxy and Hub for Gemini Spark MCPs

*   **Author:** @oudmane
*   **Status:** Draft
*   **Date:** 2026-10-28

--------------------------------------------------------------------------------

## Overview

Gemini Spark enforces strict OAuth 2.1 authentication (Authorization Code flow with PKCE) for all remote Model Context Protocol (MCP) tool integrations. In contrast, the wider ecosystem of MCP servers predominantly uses static authorization schemes: pre-shared API keys, static HTTP Bearer tokens, HTTP Basic authentication, or custom HTTP headers. Because these existing MCP servers lack an OAuth 2.1 authorization server, Gemini Spark cannot connect to them directly.

MCeption is an open-source reverse proxy and gateway service deployable as a single Docker container. It resolves this protocol mismatch by serving as an OAuth 2.1 bridge between Gemini Spark and upstream MCP servers. MCeption exposes a Root Management MCP (and an accompanying lightweight Web Dashboard) through which users register upstream MCP endpoints. During connection to Gemini Spark, MCeption intercepts the OAuth authorization handshake, presents an in-browser credential capture interface where the user supplies the required upstream credentials, encrypts these credentials at rest, and subsequently injects them into outbound SSE streams and JSON-RPC HTTP POST requests. Upstream credentials remain shielded from LLM context windows while fully satisfying Gemini Spark's OAuth 2.1 requirements.

## The Problem

Gemini Spark's security model mandates OAuth 2.1 with PKCE for all third-party remote tools. This architecture guarantees user authorization consent and standard token lifecycle handling. However, it introduces three major operational bottlenecks:

1.  **Incompatibility with Ecosystem MCP Servers**: Standard community and enterprise MCP servers rarely implement OAuth 2.1 authorization servers. Requiring each upstream maintainer to implement OAuth 2.1, state management, and user consent pages before integrating with Gemini Spark locks out the vast majority of existing tools.
2.  **Credential Leakage Risks in LLM Context**: Attempting to bypass auth mismatches by instructing the LLM to pass API keys or secrets via tool arguments exposes sensitive credentials to prompt injection attacks, context logs, and provider LLM training pipelines.
3.  **Fragmented Configuration Overhead**: End-users who run multiple MCP tools need a uniform interface to manage, authenticate, inspect, and route connections into Gemini Spark without maintaining separate infrastructure stacks for each tool.

MCeption solves these issues by acting as a trusted translation proxy: Gemini Spark connects via OAuth 2.1, while MCeption translates requests and transparently handles the upstream authentication protocol.

## Goals

*   **Compliant OAuth 2.1 Bridge**: Implement RFC 6749 and OAuth 2.1 draft specifications (Authorization Code grant with mandatory PKCE `S256` verification) to satisfy Gemini Spark client requirements.
*   **Per-User Virtual Endpoints**: Provide dynamic route namespaces (`/{user_slug}/{identifier}`) that isolate MCP target configurations, OAuth tokens, and upstream sessions per tenant.
*   **Secure Credential Injection**: Provide a browser-based consent flow that collects upstream authentication schemes (Bearer tokens, API keys in headers/query params, Basic Auth) and encrypts them at rest using AES-256-GCM.
*   **Dual Management Interfaces**:
    *   **Root Management MCP**: Provide conversational MCP tools (`register_mcp`, `list_mcps`, `remove_mcp`) connected to Gemini Spark via Google OAuth.
    *   **Standalone Web Dashboard**: Provide a responsive visual interface offering full parity with the Root MCP for creating endpoints, managing credentials, and copying Gemini Connected App URLs.
*   **SSRF Protection by Default**: Restrict upstream proxy targets at the socket level to block private, loopback, and cloud metadata IP ranges unless explicitly opted out via configuration.
*   **Low-Footprint Single-Container Deployment**: Package the entire proxy, management interfaces, and SQLite database with Write-Ahead Logging (WAL) into a single Docker image.

## Non-Goals

*   **Local Stdio Process Execution**: MCeption will not spawn or manage local subprocesses (e.g., `npx -y @modelcontextprotocol/server-...` or local Python processes). All upstream MCP servers must run as remote HTTP/SSE services.
*   **Multi-Organization SaaS Billing and Quotas**: MCeption is designed for individual developers and self-hosted teams; enterprise subscription billing, organization hierarchies, and rate metering tiers are out of scope.
*   **Direct Modification of Upstream Protocols**: MCeption does not rewrite JSON-RPC payloads, sanitize tool arguments, or validate tool schema outputs. It functions strictly as an authentication and transport proxy.
*   **Arbitrary Protocol Translation**: Support is restricted to HTTP SSE and HTTP POST JSON-RPC transports defined in the Model Context Protocol specification. WebSockets or gRPC transports are not supported.

## Open Questions

*   **Question 1**: Should upstream 401 Unauthorized responses trigger an automatic interactive re-authentication prompt in Gemini Spark, or should MCeption return a standard MCP tool error directing the user to reconnect the app in Gemini Connected Apps?
*   **Question 2**: What is the ideal session lifetime for ephemeral authorization codes and virtual OAuth refresh tokens before requiring complete re-authorization?

## Critical User Journeys (CUJs)

### CUJ 1: Register Upstream MCP and Connect to Gemini Spark

*   **Given**: An upstream remote MCP server requiring a static API key header (`X-API-Key: secret123`), and a running MCeption container.
*   **When**: The user opens the MCeption dashboard (or uses the Root Management MCP in Gemini), registers the upstream URL with identifier `weather`, and pastes the resulting virtual URL into Gemini Spark's Connected Apps.
*   **Then**: Gemini initiates the OAuth 2.1 flow. MCeption presents the consent page, where the user enters `X-API-Key: secret123`. MCeption encrypts the key, completes the OAuth handshake with Gemini, and proxies all subsequent MCP tool calls with the injected header.

### CUJ 2: Conversational Endpoint Removal via Root MCP

*   **Given**: A previously registered virtual endpoint `jira` associated with the user's account.
*   **When**: The user prompts Gemini Spark: "Remove my Jira MCP integration." Gemini calls MCeption's Root MCP tool `remove_mcp(identifier='jira')`.
*   **Then**: MCeption revokes issued tokens, removes the endpoint mapping and encrypted credentials from SQLite, and returns a confirmation to Gemini.


--------------------------------------------------------------------------------

## Technical Plan (Architecture)

### Architectural Overview

MCeption acts as a bidirectional translation and proxy gateway situated between the Gemini Spark client and remote upstream Model Context Protocol (MCP) servers. The architecture separates management operations from runtime proxying, while unifying tenant data within a single SQLite database backed by Write-Ahead Logging (WAL).

```text
+--------------------------------------------------------------------+
|                         Gemini Spark / Web                         |
+--------------------------------------------------------------------+
         |                                           |
         | Google OAuth                              | OAuth 2.1 (PKCE)
         v                                           v
+-----------------------+              +-----------------------------+
|  Root Management MCP  |              | Virtual Per-User Endpoint   |
| (or Web Dashboard)    |              | /{user_slug}/{identifier}   |
+-----------------------+              +-----------------------------+
         |                                           |
         | Register / Remove                         | 1. Intercept Auth Code & PKCE
         v                                           | 2. Capture & Decrypt Creds
+------------------------------------+               | 3. Inject Auth into SSE / POST
|       SQLite (WAL Mode)            |<--------------+
|  - Users                           |
|  - Registered Endpoints            |
|  - Encrypted Credentials (AES-GCM) |
|  - OAuth Codes & Tokens            |
+------------------------------------+
                                                     |
                                                     | Validated Outbound Call
                                                     | (SSRF Guard Active)
                                                     v
                                       +-----------------------------+
                                       | Upstream MCP Server         |
                                       | (Remote HTTP SSE / POST)    |
                                       +-----------------------------+
```

### Route Topology and Namespacing

MCeption exposes three distinct route categories under its public base URL (`MCEPTION_PUBLIC_URL`):

1.  **Root Management MCP & Web Dashboard**:
    *   `GET /`: Serves the static Web Dashboard UI.
    *   `GET /api/mcps`: REST endpoint returning registered endpoints for the authenticated user.
    *   `POST /api/mcps`: REST endpoint registering a new upstream endpoint.
    *   `DELETE /api/mcps/:identifier`: REST endpoint deleting an endpoint.
    *   `GET /root/sse`: Root MCP SSE stream for Gemini Spark chat management.
    *   `POST /root/messages`: Root MCP JSON-RPC handler processing `register_mcp`, `list_mcps`, and `remove_mcp`.

2.  **Virtual Per-User OAuth 2.1 Server**:
    *   `GET /{user_slug}/{identifier}/.well-known/oauth-authorization-server`: RFC 8414 metadata endpoint returning endpoints and supported PKCE methods (`["S256"]`).
    *   `GET /{user_slug}/{identifier}/oauth/authorize`: Initiates the Authorization Code flow with PKCE parameters (`response_type=code`, `client_id`, `redirect_uri`, `scope`, `state`, `code_challenge`, `code_challenge_method=S256`).
    *   `GET /{user_slug}/{identifier}/oauth/consent`: Web form rendered if credentials have not been saved or require re-entry.
    *   `POST /{user_slug}/{identifier}/oauth/consent`: Receives submitted upstream credentials, validates them, encrypts them, issues an ephemeral auth code, and redirects back to Gemini's `redirect_uri`.
    *   `POST /{user_slug}/{identifier}/oauth/token`: Exchanges authorization code and `code_verifier` for a local OAuth access token and refresh token.

3.  **Virtual Per-User MCP Proxy**:
    *   `GET /{user_slug}/{identifier}/sse`: Authenticated SSE connection endpoint. Validates the Bearer token issued by MCeption, looks up the decrypted upstream credentials, connects to the upstream SSE stream, and streams SSE events back to Gemini Spark.
    *   `POST /{user_slug}/{identifier}/messages`: Authenticated JSON-RPC endpoint. Validates the Bearer token, decorates headers/query parameters with upstream credentials, and forwards payloads upstream.

### Data Model and Storage (SQLite + WAL)

MCeption stores all configuration, cryptographic state, and session tokens in a local SQLite file (default `/data/mception.db`). WAL mode (`PRAGMA journal_mode = WAL;`) and busy timeouts (`PRAGMA busy_timeout = 5000;`) ensure non-blocking read operations during concurrent proxy requests.

```sql
CREATE TABLE users (
    id TEXT PRIMARY KEY,
    google_sub TEXT UNIQUE NOT NULL,
    email TEXT NOT NULL,
    user_slug TEXT UNIQUE NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE registered_mcps (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    identifier TEXT NOT NULL,
    name TEXT NOT NULL,
    upstream_url TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(user_id, identifier)
);

CREATE TABLE credentials (
    id TEXT PRIMARY KEY,
    mcp_id TEXT UNIQUE NOT NULL REFERENCES registered_mcps(id) ON DELETE CASCADE,
    auth_type TEXT NOT NULL CHECK(auth_type IN ('none', 'bearer', 'api_key_header', 'api_key_query', 'basic', 'custom_headers')),
    encrypted_payload BLOB NOT NULL,
    iv BLOB NOT NULL,
    tag BLOB NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE oauth_clients (
    id TEXT PRIMARY KEY,
    client_id TEXT UNIQUE NOT NULL,
    client_secret_hash TEXT,
    redirect_uris TEXT NOT NULL -- JSON array of allowed URIs
);

CREATE TABLE auth_codes (
    code_hash TEXT PRIMARY KEY,
    mcp_id TEXT NOT NULL REFERENCES registered_mcps(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
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
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    revoked_at INTEGER
);
```

### Credential Encryption Subsystem

1.  **Key Management**: The server reads a 32-byte master key from the environment variable `MCEPTION_MASTER_KEY` (hex or base64 encoded). If absent in development mode, a temporary key is generated and logged with a security warning.
2.  **Cipher & Parameters**: AES-256-GCM.
    *   **Initialization Vector (IV)**: 12 cryptographically random bytes generated via `crypto.randomBytes(12)` per write.
    *   **Authentication Tag**: 16 bytes generated upon finalization and stored alongside ciphertext.
3.  **In-Memory Scope**: Plaintext credentials exist in memory only during the life of a specific outbound HTTP request or connection establishment. Plaintext credentials are never written to disk, context objects, or log statements.

### SSRF Protection Engine

Before dispatching any outbound connection to an upstream MCP URL, MCeption executes a socket-level pre-flight DNS resolution and address verification step:

1.  Resolve the hostname using `dns.promises.lookup` with `all: true`.
2.  Inspect all resolved IPv4 and IPv6 addresses against blocked subnet masks:
    *   `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` (Private networks)
    *   `127.0.0.0/8` (Loopback)
    *   `169.254.0.0/16` (Link-local / Cloud metadata endpoint `169.254.169.254`)
    *   `::1/128`, `fc00::/7`, `fe80::/10` (IPv6 loopback, unique local, link-local)
3.  If any resolved IP falls into a blocked range and `ALLOW_PRIVATE_NETWORKS` is not set to `true`, the connection is immediately aborted with a `403 Forbidden: Target address disallowed by SSRF policy`.
4.  To prevent DNS rebinding attacks between check time and connection time, MCeption binds a custom Node.js `http.Agent` / `https.Agent` that pins the socket connection directly to the validated IP address while preserving the original `Host` header.

### Transport & Proxy Subsystem

1.  **SSE Streaming (`GET /{user_slug}/{identifier}/sse`)**:
    *   Gemini connects with `Authorization: Bearer <token>`.
    *   MCeption validates token validity, finds the registered upstream URL and decrypted credentials, and connects to upstream `GET <upstream_url>/sse`.
    *   MCeption forwards all incoming `endpoint` and message events from upstream down to Gemini Spark, appending or preserving session tracking query parameters.
    *   Maintains keep-alive pings (`: ping\n\n`) every 15 seconds to prevent intermediate proxy timeout.
2.  **JSON-RPC Message Relay (`POST /{user_slug}/{identifier}/messages`)**:
    *   Gemini posts JSON-RPC messages with the active `sessionId`.
    *   MCeption decrypts upstream credentials and applies them according to the configured scheme:
        *   `bearer`: Injects `Authorization: Bearer <decrypted_token>`.
        *   `api_key_header`: Injects `<Header-Name>: <decrypted_key>`.
        *   `api_key_query`: Appends `?<param_name>=<decrypted_key>` to upstream target URI.
        *   `basic`: Injects `Authorization: Basic base64(<user>:<pass>)`.
        *   `custom_headers`: Injects specified header key-value pairs.
    *   MCeption forwards the payload to `<upstream_url>/messages?sessionId=...` and streams the upstream response directly back to Gemini.
3.  **Error Propagation & Token Refresh**:
    *   If upstream returns HTTP 401, MCeption checks if refresh capabilities exist for upstream. If not, MCeption returns an explicit JSON-RPC error response: `{"code": -32001, "message": "Upstream authentication failed. Please update credentials via MCeption dashboard or reconnect Connected App."}`.


--------------------------------------------------------------------------------

## Alternatives Considered

### Alternative A: LLM-Mediated Credential Injection (Prompt-Level Keys)

*   **Description**: Instruct Gemini Spark in system instructions or tool definitions to pass API keys and authentication tokens directly as arguments to MCP tool calls.
*   **Pros**:
    *   Requires no intermediary reverse proxy or token translation layer.
*   **Cons**:
    *   **Catastrophic Credential Exposure**: Plaintext secrets are exposed in chat histories, LLM training datasets, and system log collectors.
    *   **Prompt Injection Risk**: Adversarial inputs or untrusted tool responses can trick the model into revealing stored secrets.
    *   **Handshake Failure**: Fails fundamentally because Gemini Spark enforces OAuth 2.1 PKCE validation before any MCP tools can be listed or connected.
*   **Reason for Rejection**: Violates basic credential security standards and fails to satisfy Gemini Spark's connection prerequisites.

### Alternative B: Local Subprocess Spawning (`stdio` Transport Bridge)

*   **Description**: Allow users to run local CLI packages (e.g., `npx -y @modelcontextprotocol/server-github`) spawned directly inside the MCeption Docker container, bridging their `stdio` streams to remote SSE/HTTP.
*   **Pros**:
    *   Enables running standard single-user MCP servers without requiring a separate hosting environment.
*   **Cons**:
    *   **Arbitrary Code Execution**: Spawning unvetted npm or Python packages inside the container creates privilege escalation and container escape vulnerabilities.
    *   **Resource Bloat & Dependency Conflicts**: Requires bundling complete Node.js, Python, and system library runtimes, ballooning container image size and risking dependency hell.
    *   **Process Lifespan & Zombie Risks**: Managing multiple long-lived subprocesses across multi-tenant contexts introduces memory leaks and zombie process hazards.
*   **Reason for Rejection**: Contradicts the design goal of a lightweight, secure network reverse proxy. Users should host their upstream MCP servers independently in isolated containers.

### Alternative C: External Dedicated OAuth Server (Keycloak / Ory Hydra)

*   **Description**: Delegate OAuth 2.1 issuance and PKCE validation to a dedicated external authorization server like Keycloak or Ory Hydra, with MCeption functioning strictly as a resource server.
*   **Pros**:
    *   Reuses battle-tested, certified OAuth 2.1 and OpenID Connect reference implementations.
*   **Cons**:
    *   **Operational Footprint**: Requires a secondary relational database (e.g., PostgreSQL) and multi-gigabyte container footprint, destroying single-container deployability.
    *   **Consent Flow Friction**: Keycloak/Hydra cannot dynamically collect, encrypt, and associate upstream third-party credentials (API keys, Basic auth) during the OAuth authorization screen without complex custom SPI extensions.
*   **Reason for Rejection**: Introduces unacceptable infrastructure complexity and conflicts with the requirement for self-contained, lightweight deployment.

--------------------------------------------------------------------------------

## Non-Functional Requirements

### Security & Privacy

*   **Zero-Plaintext at Rest**: Upstream secrets must be encrypted using AES-256-GCM before writing to SQLite. Master key is supplied via environment variable and never committed or persisted in database files.
*   **Tenant Boundary Enforcement**: Routing middleware enforces that a token issued for `{user_slug_a}` cannot query or proxy through routes under `/{user_slug_b}/...`.
*   **Ephemeral Code Expiration**: OAuth authorization codes expire in 60 seconds and are single-use. Tokens are revocable on demand.
*   **SSRF Hardening**: Pre-flight DNS resolution checks socket destination IP addresses against RFC 1918, loopback, link-local, and cloud metadata (`169.254.169.254`) ranges by default.

### Performance & Latency

*   **Proxy Overhead**: MCeption must introduce less than 15ms of added p95 processing latency (excluding upstream network round-trips) for standard JSON-RPC tool invocations.
*   **Memory Footprint**: Base container memory usage must remain below 128MB under steady-state operation with up to 50 active SSE connections.
*   **Non-Blocking IO**: SQLite write operations (token updates, credential modifications) must not block concurrent read proxying, achieved via WAL mode and connection pooling.

### Rollout & Reliability

*   **Single-Container Docker Image**: Packaged with minimal base image (`node:22-alpine` or distroless), exposing port 3000 and mounting `/data` for SQLite persistence.
*   **Zero-Downtime Schema Migrations**: Embedded database migrations run automatically on startup, verifying table structures before opening HTTP listener ports.


--------------------------------------------------------------------------------

## Detailed Implementation Plan

### Target Files to Create/Modify

#### 1. `package.json` (Create)
*   **Type / Scope**: Project Manifest & Dependency Configuration
*   **Proposed Changes**: Define project dependencies (`fastify`, `@fastify/static`, `@fastify/cors`, `@fastify/cookie`, `@fastify/formbody`, `@modelcontextprotocol/sdk`, `better-sqlite3`, `kysely`, `zod`, `pino`), devDependencies (`typescript`, `@types/node`, `@types/better-sqlite3`, `vitest`, `tsx`, `eslint`, `prettier`), and build/test scripts (`build`, `start`, `dev`, `test`, `lint`).
*   **Rationale**: Configures the Node.js 22 LTS runtime environment and locks explicit versions for MCP SDK, database, and HTTP server modules.

#### 2. `tsconfig.json` (Create)
*   **Type / Scope**: TypeScript Compiler Configuration
*   **Proposed Changes**: Configure TypeScript with `NodeNext` module resolution, `ES2023` target, strict mode enabled, declaration map emission, and source maps for production debugging.
*   **Rationale**: Ensures type safety across cryptographic, database, and MCP protocol boundaries.

#### 3. `Dockerfile` (Create)
*   **Type / Scope**: Container Packaging
*   **Proposed Changes**: Multi-stage build based on `node:22-alpine`:
    *   Build stage: Installs build dependencies (Python, make, g++ for `better-sqlite3`), compiles TypeScript to `dist/`.
    *   Runner stage: Minimal production image, creates non-root user `mception`, prepares persistent volume directory `/data` owned by `mception`, exposes port `3000`, and sets healthcheck on `/healthz`.
*   **Rationale**: Enables single-container deployment with minimal attack surface and secure persistence for SQLite files.

#### 4. `docker-compose.yml` (Create)
*   **Type / Scope**: Local Orchestration Configuration
*   **Proposed Changes**: Declares `mception` service mapping port `3000:3000`, mounting named volume `mception_data:/data`, and passing environment variables.
*   **Rationale**: Provides a turn-key deployment command (`docker compose up -d`) for self-hosted instances.

#### 5. `.env.example` (Create)
*   **Type / Scope**: Environment Configuration Template
*   **Proposed Changes**: Documents all supported environment variables: `PORT`, `MCEPTION_PUBLIC_URL`, `MCEPTION_MASTER_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `ALLOW_PRIVATE_NETWORKS`, `LOG_LEVEL`.
*   **Rationale**: Gives operators clear guidance on mandatory keys, specifically the 32-byte encryption master key.

#### 6. `.gitignore` (Create)
*   **Type / Scope**: Version Control Hygiene
*   **Proposed Changes**: Ignores `node_modules/`, `dist/`, `.env`, `/data/*.db*`, `.coverage/`, and OS temp files.
*   **Rationale**: Prevents accidental leakage of local SQLite databases containing encrypted secrets or local `.env` files.

#### 7. `src/config.ts` (Create)
*   **Type / Scope**: Runtime Configuration Validator
*   **Proposed Changes**: Implements Zod schema to parse and validate `process.env`. Enforces that `MCEPTION_MASTER_KEY` is exactly 32 bytes (hex or raw), parses boolean flags (`ALLOW_PRIVATE_NETWORKS`), and provides default fallbacks for ports and logging levels.
*   **Rationale**: Fails fast at startup if critical encryption or URL configuration is missing or malformed.

#### 8. `src/db/connection.ts` (Create)
*   **Type / Scope**: Database Connection Manager
*   **Proposed Changes**: Initializes `better-sqlite3` instance targeting `/data/mception.db` (or custom path from config). Executes initial PRAGMAs:
    *   `PRAGMA journal_mode = WAL;`
    *   `PRAGMA busy_timeout = 5000;`
    *   `PRAGMA foreign_keys = ON;`
    *   `PRAGMA synchronous = NORMAL;`
    Initializes Kysely instance wrapping the SQLite driver.
*   **Rationale**: Configures SQLite for high concurrency and transactional integrity under concurrent SSE and JSON-RPC proxy loads.

#### 9. `src/db/types.ts` (Create)
*   **Type / Scope**: TypeScript Database Models
*   **Proposed Changes**: Defines TypeScript interfaces matching the database schema: `UserTable`, `RegisteredMcpTable`, `CredentialTable`, `OAuthClientTable`, `AuthCodeTable`, and `TokenTable`.
*   **Rationale**: Guarantees compile-time type checking for all database queries and transactions.

#### 10. `src/db/migrations.ts` (Create)
*   **Type / Scope**: Schema Migration Engine
*   **Proposed Changes**: Provides an automated migration runner executed at application boot. Checks database version via `PRAGMA user_version` and creates tables, indexes, and cascades (`users`, `registered_mcps`, `credentials`, `oauth_clients`, `auth_codes`, `tokens`).
*   **Rationale**: Eliminates external migration CLI tools; enables single-container startup without manual database provisioning.

#### 11. `src/crypto/encryption.ts` (Create)
*   **Type / Scope**: Cryptographic Subsystem
*   **Proposed Changes**: Implements `encryptCredential(payload: object, masterKey: Buffer): { ciphertext: Buffer, iv: Buffer, tag: Buffer }` and `decryptCredential(ciphertext: Buffer, iv: Buffer, tag: Buffer, masterKey: Buffer): object` using Node's `crypto.createCipheriv('aes-256-gcm', masterKey, iv)`.
*   **Rationale**: Guarantees zero plaintext secret exposure at rest in SQLite; includes authenticated tag verification to prevent cipher tampering.

#### 12. `src/crypto/pkce.ts` (Create)
*   **Type / Scope**: OAuth 2.1 PKCE Validator
*   **Proposed Changes**: Implements `verifyPkce(verifier: string, challenge: string, method: string): boolean`. Generates SHA-256 hash of `code_verifier`, converts to Base64URL encoding, and performs constant-time comparison against `challenge`. Rejects any method other than `S256`.
*   **Rationale**: Enforces mandatory OAuth 2.1 PKCE requirements per RFC 7636.

#### 13. `src/security/ssrf.ts` (Create)
*   **Type / Scope**: SSRF Guard & Outbound Socket Agent
*   **Proposed Changes**:
    *   Exports `isIpAllowed(ip: string, allowPrivate: boolean): boolean` checking IP addresses against private (RFC 1918), loopback, link-local, cloud metadata (`169.254.169.254`), and IPv6 ranges.
    *   Provides custom `http.Agent` and `https.Agent` that hooks `createConnection`, resolves hostnames via DNS lookup, validates resolved IPs, and binds the socket to the validated IP to prevent DNS rebinding.
*   **Rationale**: Prevents malicious or misconfigured upstream MCP registrations from scanning internal network services or accessing cloud instance metadata.

#### 14. `src/oauth/server.ts` (Create)
*   **Type / Scope**: OAuth 2.1 Protocol Endpoints
*   **Proposed Changes**: Implements Fastify route handlers under `/{user_slug}/{identifier}/`:
    *   `GET /.well-known/oauth-authorization-server`: Returns authorization endpoint, token endpoint, scopes, and `code_challenge_methods_supported: ["S256"]`.
    *   `GET /oauth/authorize`: Validates parameters (`client_id`, `redirect_uri`, `response_type=code`, `code_challenge`, `code_challenge_method=S256`). Checks if upstream credentials already exist; if not, redirects to `/oauth/consent`. If valid, generates a secure random authorization code, hashes it into `auth_codes` with 60s TTL, and redirects to Gemini's `redirect_uri`.
    *   `POST /oauth/token`: Validates authorization code, executes PKCE verification, marks code as used, and issues access token and refresh token into `tokens` table.
*   **Rationale**: Provides a fully compliant OAuth 2.1 authorization server dedicated to Gemini Spark's Connected Apps client.

#### 15. `src/oauth/consent.ts` (Create)
*   **Type / Scope**: Consent & Credential Capture Controller
*   **Proposed Changes**:
    *   `GET /{user_slug}/{identifier}/oauth/consent`: Renders an HTML form allowing the user to select upstream auth type (`none`, `bearer`, `api_key_header`, `api_key_query`, `basic`, `custom_headers`) and enter the credential values.
    *   `POST /{user_slug}/{identifier}/oauth/consent`: Validates form inputs, encrypts the credentials via `src/crypto/encryption.ts`, saves to `credentials` table, and resumes the OAuth authorization redirect to Gemini Spark.
*   **Rationale**: Seamlessly captures upstream credentials in the browser during the Gemini OAuth handshake, avoiding exposing secrets to LLM context.

#### 16. `src/proxy/sse.ts` (Create)
*   **Type / Scope**: MCP SSE Streaming Gateway
*   **Proposed Changes**: Implements `GET /{user_slug}/{identifier}/sse`:
    *   Authenticates incoming request via `Authorization: Bearer <token>`, resolving `user_slug` and `identifier`.
    *   Retrieves and decrypts upstream credentials from database.
    *   Establishes outbound SSE connection to `upstream_url/sse` using SSRF-safe agent, injecting upstream credentials.
    *   Pipes upstream SSE stream down to client response, maintaining heartbeat comments (`: ping`) every 15 seconds.
    *   Handles connection disconnects and cleans up upstream streams.
*   **Rationale**: Sustains long-lived server-sent event connections required by the MCP protocol while maintaining credential isolation.

#### 17. `src/proxy/messages.ts` (Create)
*   **Type / Scope**: MCP JSON-RPC Message Proxy
*   **Proposed Changes**: Implements `POST /{user_slug}/{identifier}/messages`:
    *   Authenticates Bearer token and verifies active session.
    *   Injects decrypted upstream credentials (headers or query parameters).
    *   Forwards JSON-RPC payload to `upstream_url/messages?sessionId=...`.
    *   Catches upstream HTTP 401 errors and returns structured MCP JSON-RPC errors.
*   **Rationale**: Forwards tool calls and resource reads between Gemini Spark and upstream MCP servers.

#### 18. `src/root-mcp/server.ts` (Create)
*   **Type / Scope**: Root Management MCP Server
*   **Proposed Changes**: Implements an MCP server using `@modelcontextprotocol/sdk`:
    *   Defines tools: `register_mcp(identifier, upstream_url, name)`, `list_mcps()`, and `remove_mcp(identifier)`.
    *   Exposes endpoints `/root/sse` and `/root/messages` authenticated via Google OAuth.
    *   Updates SQLite database when tools are executed.
*   **Rationale**: Allows users to manage their registered MCP endpoints conversationally within Gemini Spark.

#### 19. `src/web/routes.ts` (Create)
*   **Type / Scope**: Web Dashboard Controller
*   **Proposed Changes**: Registers Fastify routes for the management UI:
    *   Serves static dashboard files from `src/web/public/`.
    *   `GET /api/mcps`: Returns JSON list of registered MCPs for the authenticated user.
    *   `POST /api/mcps`: Registers a new upstream MCP endpoint.
    *   `DELETE /api/mcps/:identifier`: Deletes an endpoint and associated credentials.
*   **Rationale**: Provides a visual browser interface for users who prefer a dashboard over conversational tool commands.

#### 20. `src/web/public/index.html` (Create)
*   **Type / Scope**: Web Dashboard Frontend
*   **Proposed Changes**: Single-page application (HTML/Tailwind/Vanilla JS):
    *   Displays cards for all registered MCP endpoints.
    *   Provides "Add MCP" modal with form fields for identifier, name, and upstream URL.
    *   Displays copyable Gemini Connected App URLs: `{MCEPTION_PUBLIC_URL}/{user_slug}/{identifier}`.
    *   Shows connection status badges and deletion triggers.
*   **Rationale**: Lightweight, dependency-free UI that loads instantly and requires no separate frontend build step.

#### 21. `src/index.ts` (Create)
*   **Type / Scope**: Application Bootstrap & Lifecycle Manager
*   **Proposed Changes**:
    *   Loads and validates config via `src/config.ts`.
    *   Initializes SQLite connection and runs migrations via `src/db/migrations.ts`.
    *   Initializes Fastify server, registers CORS, static serving, and route plugins.
    *   Hooks OS signals (`SIGTERM`, `SIGINT`) to close HTTP listeners and database connection cleanly.
*   **Rationale**: Orchestrates startup sequence and ensures graceful shutdown without database corruption.

#### 22. `README.md` (Modify)
*   **Type / Scope**: Documentation
*   **Proposed Changes**: Replace stub README with complete operational documentation:
    *   Architecture diagram and component overview.
    *   Step-by-step onboarding guide for Gemini Spark Connected Apps.
    *   Docker run and Docker Compose deployment instructions.
    *   Environment variable reference table.
    *   Upstream authentication type guide.
*   **Rationale**: Provides clear setup and operational instructions for end users.

#### 23. `tests/unit/crypto.test.ts` (Create)
*   **Type / Scope**: Unit Test Suite
*   **Proposed Changes**: Tests AES-256-GCM encryption/decryption roundtrips, verifies unique IVs per operation, ensures corrupted ciphertexts or tampered tags throw errors, and validates PKCE `S256` verification.
*   **Rationale**: Confirms cryptographic security and integrity before runtime usage.

#### 24. `tests/unit/ssrf.test.ts` (Create)
*   **Type / Scope**: Unit Test Suite
*   **Proposed Changes**: Tests IP filtering for `127.0.0.1`, `10.0.0.1`, `172.16.0.1`, `192.168.1.1`, `169.254.169.254`, `::1`, and public IPs. Verifies behavior when `ALLOW_PRIVATE_NETWORKS` is toggled.
*   **Rationale**: Prevents regression in SSRF defenses.

#### 25. `tests/integration/oauth.test.ts` (Create)
*   **Type / Scope**: Integration Test Suite
*   **Proposed Changes**: Tests complete OAuth 2.1 lifecycle: discovery endpoint, authorization code creation with PKCE challenge, code redemption with verifier, and token issuance. Tests rejection of reused or expired codes.
*   **Rationale**: Guarantees compatibility with Gemini Spark's OAuth client.

#### 26. `tests/integration/proxy.test.ts` (Create)
*   **Type / Scope**: Integration Test Suite
*   **Proposed Changes**: Spins up a mock upstream MCP server. Verifies that MCeption connects via SSE, injects configured credentials (Bearer, API Key, Basic), forwards JSON-RPC messages, and propagates errors.
*   **Rationale**: Validates end-to-end transport fidelity and credential decoration.

### Verification Plan

*   **Compilation / Build**:
    *   `npm run build`: Executes `tsc --noEmit` and emits JavaScript to `dist/`.
*   **Unit Tests**:
    *   `npm run test:unit`: Runs Vitest across `tests/unit/*.test.ts` covering cryptography, PKCE, and SSRF logic. Target: 100% branch coverage on cryptographic and security modules.
*   **Integration Tests**:
    *   `npm run test:integration`: Runs Vitest across `tests/integration/*.test.ts` against in-memory SQLite and mock upstream MCP servers. Target: Complete OAuth 2.1 handshake and SSE proxy verification.
*   **Static Analysis & Linting**:
    *   `npm run lint`: Executes ESLint and Prettier checks across all TypeScript files.
*   **Container Build Verification**:
    *   `docker build -t mception:test .`: Verifies multi-stage build, binary compilation for `better-sqlite3`, and non-root user permissions.
