# Stage 5 Report: Initial Zoom Out Review

**Target Document**: `docs/designs/mception.md`  
**Reviewer Persona**: Skeptical Architect (`egm-zoom-out`)  
**Standard**: `zoom-out-standard.md`  
**Status**: FAILED (Requires simplification and architectural corrections)

---

## Executive Summary

The MCeption proposal addresses a genuine and well-defined ecosystem friction point: Gemini Spark mandates OAuth 2.1 with PKCE for remote MCP tools, whereas community MCP servers use static authorization schemes. 

However, from an architectural altitude, the design suffers from **scope divergence**, **speculative multi-tenancy (YAGNI)**, **operational dead-ends**, and **low-level implementation weeds**. It simultaneously positions itself as a lightweight single-container developer tool while introducing enterprise multi-tenant constructs (Google OAuth integration, user slugs, tenant isolation middleware), a redundant conversational management control plane, and an SSRF default policy that directly breaks the primary developer workflow (connecting to local/containerized MCPs).

---

## Detailed Findings

### 1. Blocker: Broken MCP SSE Transport Data Flow vs. Non-Goal
* **Severity**: Blocker
* **Affected Scope**: Section "Non-Goals" (lines 40–41), Section "Transport & Proxy Subsystem" (lines 211–215, 224)
* **Simplicity Rationale**:
  * In the MCP HTTP/SSE specification, when a client connects to `GET /sse`, the server immediately emits an `endpoint` event containing the URI where JSON-RPC messages must be POSTed (e.g., `event: endpoint\ndata: /messages?sessionId=...` or a full URL).
  * Line 40 explicitly declares as a Non-Goal: *"MCeption does not rewrite JSON-RPC payloads, sanitize tool arguments... It functions strictly as an authentication and transport proxy."* Line 214 further states: *"MCeption forwards all incoming `endpoint` and message events from upstream down to Gemini Spark..."*
  * If MCeption blindly forwards the upstream `endpoint` event, Gemini Spark will attempt to POST messages directly to the upstream server (which it cannot reach or lacks credentials for) or to an unqualified `/messages` route on MCeption that lacks `{user_slug}/{identifier}` context.
  * **Architectural Fix**: MCeption must intercept and rewrite the SSE `endpoint` event to point back to MCeption's own virtual proxy route (`/{user_slug}/{identifier}/messages?sessionId=...`). The Non-Goal must be clarified, and the transport mechanics must explicitly document this required route transformation.

---

### 2. Blocker: SSRF Default Configuration Incompatible with Primary Developer Use Case
* **Severity**: Blocker
* **Affected Scope**: Section "SSRF Protection Engine" (lines 196–207), Section "Target Files: `src/security/ssrf.ts`" (lines 359–365)
* **Simplicity Rationale**:
  * The design blocks RFC 1918 private subnets (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`) and loopback (`127.0.0.0/8`) *by default*.
  * MCeption is designed for individual developers and self-hosted deployments running MCP servers in local containers, docker-compose networks (which use `172.16.0.0/12`), or local host ports (`127.0.0.1`).
  * Enforcing multi-tenant public-cloud egress restrictions by default ensures that out-of-the-box, 90%+ of developer upstream connections will fail with `403 Forbidden: Target address disallowed by SSRF policy`.
  * **Architectural Fix**: SSRF protection must target cloud instance metadata endpoints (`169.254.169.254`, `fe80::/10`) by default to prevent credential exfiltration on cloud VMs, while allowing private and local network routing by default for local/self-hosted gateway usage (or controlled via an explicit `BLOCK_PRIVATE_NETWORKS` toggle rather than forcing developers to discover why their local setup failed).

---

### 3. Major: Speculative Multi-Tenancy & Google OAuth Dependency (YAGNI)
* **Severity**: Major
* **Affected Scope**: Section "Goals" (lines 28, 31), Section "Technical Plan: Data Model" (lines 129–136), Section "Target Files: `.env.example`" (line 316)
* **Simplicity Rationale**:
  * The proposal explicitly defines MCeption as a tool for *"individual developers and self-hosted teams"* (line 39) deployed as a *"single Docker container"* (line 34).
  * Despite this, it designs a multi-tenant user model: a `users` table keyed on `google_sub`, mandatory user slugs in every proxy URL (`/{user_slug}/{identifier}`), tenant boundary isolation middleware (line 271), and a hard dependency on Google OAuth (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`).
  * Requiring an individual developer to set up a Google Cloud Console project, configure OAuth consent screens, and supply Google client credentials simply to run a local proxy gateway introduces massive friction and violates YAGNI.
  * **Architectural Fix**: Simplify to a single-tenant or team-scoped gateway. Endpoints should simply be `/{identifier}/sse` and `/{identifier}/messages`. Protect management operations via a simple administrative API key / dashboard bearer token or basic session auth. Drop the `users` table, `google_sub`, and user slug routing until true multi-tenant SaaS requirements exist.

---

### 4. Major: Redundant Dual Control Plane (Root MCP vs. Web Dashboard)
* **Severity**: Major
* **Affected Scope**: Section "Goals" (lines 30–33), Section "Technical Plan: Architectural Overview" (lines 77–81), Section "Target Files: `src/root-mcp/server.ts`" (lines 400–406)
* **Simplicity Rationale**:
  * The design introduces a "Root Management MCP" inside Gemini Spark so users can run tools like `register_mcp`, alongside a full Web Dashboard.
  * However, registering an MCP inevitably requires manual interaction: the user must copy the resulting virtual URL and paste it into the Gemini Spark "Connected Apps" configuration UI, and they must provide upstream API keys. Conversational registration cannot complete the connection loop inside Gemini Spark.
  * Introducing a secondary MCP server stack (`@modelcontextprotocol/sdk`, `/root/sse`, `/root/messages`, separate Google OAuth flow) just to perform 3 database CRUD operations that the Web Dashboard already handles is premature abstraction and double maintenance overhead.
  * **Architectural Fix**: Cut the Root Management MCP from v1. Standardize on the lightweight Web Dashboard for creating endpoints, managing keys, and copying Connected App URLs.

---

### 5. Major: Fragmented Credential Capture via OAuth Consent Screen
* **Severity**: Major
* **Affected Scope**: Section "Route Topology" (lines 115–118), Section "Target Files: `src/oauth/consent.ts`" (lines 374–380)
* **Simplicity Rationale**:
  * The design splits endpoint creation: the user creates the endpoint via Dashboard/MCP, but enters their upstream credentials (API key, Bearer token, Basic Auth) later via a custom form rendered during the OAuth authorization consent screen redirect.
  * This over-engineers the OAuth 2.1 state machine: MCeption must preserve transient OAuth authorization state (`code_challenge`, `redirect_uri`, `state`) across interactive form submissions, session cookies, and validation errors.
  * If the user is already in the Web Dashboard registering the MCP endpoint, they should provide the upstream credentials directly during registration. The OAuth authorize flow then becomes a standard, instantaneous authorization code redirect back to Gemini (or a clean 1-click consent).
  * **Architectural Fix**: Collect upstream credentials at endpoint creation time in the Web Dashboard. Keep the OAuth 2.1 authorization endpoint clean, predictable, and decoupled from dynamic credential input.

---

### 6. Major: Undefined `oauth_clients` Management and Dead-End
* **Severity**: Major
* **Affected Scope**: Section "Technical Plan: Data Model" (lines 160–165), Section "Target Files: `src/oauth/server.ts`" (lines 369–371)
* **Simplicity Rationale**:
  * The database schema includes a dedicated table `oauth_clients (client_id, client_secret_hash, redirect_uris)`.
  * Nowhere in the document (endpoints, CLI, dashboard, or migrations) is there any mechanism to seed, register, or manage OAuth clients.
  * In OAuth 2.1 with PKCE, public clients (such as Gemini Connected Apps) use PKCE verification rather than pre-shared client secrets.
  * **Architectural Fix**: Remove the `oauth_clients` table. Define how MCeption validates Gemini Spark's client ID and redirect URIs (e.g., validate against an allowed redirect URI pattern or environment-configured client ID). Do not create unmanaged database tables.

---

### 7. Nit: Low-Altitude Weeds in Technical Plan
* **Severity**: Nit
* **Affected Scope**: Section "Detailed Implementation Plan" (lines 288–464)
* **Simplicity Rationale**:
  * The plan drops into excessive code-level detail across 26 granular files, prescribing exact function signatures (`encryptCredential(payload, masterKey)`, `verifyPkce(...)`), internal variable names, Fastify plugin names, and PRAGMA settings.
  * Meanwhile, critical architectural interfaces (SSE endpoint rewriting, local container network resolution) were glossed over.
  * **Architectural Fix**: Elevate the technical plan to focus on system boundaries, protocol flows, and core architectural components rather than stubbing out individual helper function signatures.

---

### 8. Nit: Heavy Database Native Addon Dependencies
* **Severity**: Nit
* **Affected Scope**: Section "Detailed Implementation Plan" (lines 294, 305, 330–336)
* **Simplicity Rationale**:
  * The stack specifies `better-sqlite3` and `kysely` for a database with only 3–4 simple lookup tables. `better-sqlite3` requires compiling C++ native addons (`python`, `make`, `g++`) in Alpine Docker.
  * Node 22 (the specified runtime) contains native `node:sqlite`, and standard lightweight drivers avoid native build toolchain bloat in minimal container images.
