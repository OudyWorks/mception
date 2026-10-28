# Goldfish Annotated Review Report

**Status:** resolved (Design revisions applied to docs/designs/mception.md)  
**Target:** `docs/designs/mception.md` (`full file`)

## Prioritized Findings & AI Suggestions

### 1. Speculative Multi-Tenancy & Google OAuth Dependency [`egm-zoom-out`] - Severity: High
*   **Affected Scope:** [Lines 28, 31, 74–75, 105–123, 129–136, 271, 316](docs/designs/mception.md#L28-L136) (Goals, Route Topology, Data Model, NFRs)
*   **Discrepancy Description:** The design attempts to implement full SaaS multi-tenancy (Google OAuth integration, user slugs in routes, tenant boundary isolation) on a single-container developer tool, while omitting authentication routes, session cookies, and user registration logic.
*   **Rationale:** Imposing Google Cloud project creation, OAuth consent setup, and multi-tenant URL namespaces on a self-hosted developer tool violates YAGNI and creates major setup friction and unauthenticated attack surfaces.
*   **AI Suggestion:** PROPOSE FIX
*   **Justification:** Simplify to a single-tenant or team-scoped gateway. Protect management endpoints (`/api/mcps` and Web Dashboard) with an administrative token (`ADMIN_API_KEY`). Replace `/{user_slug}/{identifier}` routes with clean, deterministic `/{identifier}` namespaces. Remove the `users` table and Google OAuth configuration.
*   **Proposed Edit:**
    *   Location: `## Goals`, `## Technical Plan (Architecture)`, `## Route Topology`, `## Data Model`, `## Target Files`
    *   Change: Remove `users` table and `google_sub` references. Update route paths from `/{user_slug}/{identifier}/...` to `/{identifier}/...`. Replace Google OAuth env vars with `ADMIN_API_KEY`.

---

### 2. Broken MCP SSE `endpoint` Event Rewriting & Session Mapping [`egm-design`, `egm-codebase-details`, `egm-zoom-out`] - Severity: High
*   **Affected Scope:** [Lines 40–41, 120–123, 211–224, 381–399](docs/designs/mception.md#L40-L224) (Non-Goals, Transport & Proxy Subsystem, Target Files)
*   **Discrepancy Description:** Line 40 claims MCeption does not rewrite payloads, and line 214 states it blindly forwards SSE events. In the MCP SSE protocol, upstream emits an `endpoint` event containing its message URL (e.g., `data: /messages?sessionId=...`). Blindly piping this causes Gemini Spark to POST directly to upstream or to unmapped paths. Furthermore, MCP POST responses are empty/202, not JSON-RPC response bodies.
*   **Rationale:** Without intercepting and rewriting the `endpoint` SSE event, Gemini Spark cannot route JSON-RPC message calls back through MCeption.
*   **AI Suggestion:** PROPOSE FIX
*   **Justification:** Clarify that MCeption rewrites the SSE `endpoint` event to point to `/{identifier}/messages?sessionId=<mapped_session_id>` and maintains bidirectional session tracking between Gemini and upstream.
*   **Proposed Edit:**
    *   Location: `## Non-Goals`, `### Transport & Proxy Subsystem`, `#### 16. src/proxy/sse.ts`, `#### 17. src/proxy/messages.ts`
    *   Change: Explicitly specify that `src/proxy/sse.ts` intercepts the upstream `endpoint` event, replaces the URL with `/{identifier}/messages?sessionId=<proxy_sid>`, and maps `<proxy_sid>` to `<upstream_sid>`. Document that JSON-RPC responses flow asynchronously over SSE.

---

### 3. Redundant Dual Control Plane (Root MCP vs. Web Dashboard) [`egm-zoom-out`, `egm-comprehension`] - Severity: High
*   **Affected Scope:** [Lines 30–33, 77–81, 105–112, 400–406](docs/designs/mception.md#L30-L112) (Goals, Route Topology, Detailed Plan)
*   **Discrepancy Description:** The design introduces a secondary "Root Management MCP" server inside MCeption alongside a Web Dashboard. However, Gemini Spark Connected Apps requires users to manually copy and paste the virtual MCP URL in the graphical settings anyway.
*   **Rationale:** Maintaining a secondary `@modelcontextprotocol/sdk` server stack with separate authentication to perform 3 database CRUD operations that the Web Dashboard already handles is unnecessary complexity.
*   **AI Suggestion:** PROPOSE FIX
*   **Justification:** Cut the Root Management MCP from v1. Standardize on the lightweight Web Dashboard for creating endpoints, managing credentials, and copying Connected App URLs.
*   **Proposed Edit:**
    *   Location: `## Goals`, `### Route Topology and Namespacing`, `#### 18. src/root-mcp/server.ts`
    *   Change: Remove Root MCP tools and endpoints (`/root/sse`, `/root/messages`). Delete `src/root-mcp/server.ts` from target files. Focus management exclusively on the Web Dashboard and REST API.

---

### 4. Fragmented Credential Capture via OAuth Consent Screen [`egm-zoom-out`, `egm-comprehension`, `egm-design`] - Severity: High
*   **Affected Scope:** [Lines 115–118, 374–380](docs/designs/mception.md#L115-L118) (Route Topology, Target Files)
*   **Discrepancy Description:** The design defers upstream credential entry (API keys, Basic auth) to a custom HTML form rendered midway through the OAuth 2.1 authorization redirect (`GET /{user_slug}/{identifier}/oauth/consent`), requiring complex state preservation of OAuth parameters.
*   **Rationale:** The user is already in the Web Dashboard when creating the endpoint. Collecting credentials at registration keeps the OAuth 2.1 `/oauth/authorize` flow clean, standard, and instantaneous.
*   **AI Suggestion:** PROPOSE FIX
*   **Justification:** Collect and encrypt upstream credentials directly when the user registers the endpoint in the Web Dashboard (`POST /api/mcps`). The OAuth 2.1 authorize endpoint immediately validates PKCE and issues the authorization code redirect to Gemini Spark.
*   **Proposed Edit:**
    *   Location: `### Route Topology and Namespacing`, `#### 15. src/oauth/consent.ts`
    *   Change: Remove `GET/POST /oauth/consent`. Specify credential capture fields directly in the Web Dashboard endpoint creation modal and `POST /api/mcps`.

---

### 5. SSRF Default Configuration Incompatible with Local Containers [`egm-zoom-out`, `egm-design`] - Severity: High
*   **Affected Scope:** [Lines 33, 196–207, 359–365](docs/designs/mception.md#L33-L207) (Goals, SSRF Protection Engine, Target Files)
*   **Discrepancy Description:** The design blocks RFC 1918 private subnets and loopback addresses by default. This immediately breaks local Docker container networks (`172.16.0.0/12`) and localhost MCP servers. Furthermore, standard HTTP clients follow 3xx redirects without re-checking DNS, bypassing socket-level filters.
*   **Rationale:** Out of the box, MCeption must support local and containerized MCP servers while strictly blocking cloud metadata services (`169.254.169.254`, `fe80::/10`).
*   **AI Suggestion:** PROPOSE FIX
*   **Justification:** Invert SSRF defaults: block cloud metadata by default, allow private/local networks by default, provide an explicit `BLOCK_PRIVATE_NETWORKS=true` toggle, and set `maxRedirects: 0` on outbound requests.
*   **Proposed Edit:**
    *   Location: `## Goals`, `### SSRF Protection Engine`, `#### 13. src/security/ssrf.ts`
    *   Change: Update default policy to permit RFC 1918/loopback and block cloud metadata. Add `BLOCK_PRIVATE_NETWORKS` toggle. Document disabling automatic redirect following.

---

### 6. Missing Mandatory "Risks & Mitigations" Section [`egm-design`, `egm-structural`] - Severity: High
*   **Affected Scope:** [Lines 1–287](docs/designs/mception.md#L1-L287) (Feature Specification)
*   **Discrepancy Description:** The Feature Specification Standard mandates an explicit evaluation of constraints, failure modes, security implications, and scalability limits. The document lacks a dedicated `## Risks & Mitigations` section.
*   **Rationale:** Operational failure modes (upstream outages, socket exhaustion, master key loss, SQLite concurrency) must be documented with explicit technical mitigations.
*   **AI Suggestion:** PROPOSE FIX
*   **Justification:** Add a dedicated `## Risks & Mitigations` section covering upstream unreachability, connection drop recovery, key rotation/loss, and SQLite concurrency limits.
*   **Proposed Edit:**
    *   Location: Insert before `## Detailed Implementation Plan`
    *   Change: Add `## Risks & Mitigations` section with concrete technical mitigations.

---

### 7. Speculative `oauth_clients` Table and Undefined Client Lifecycle [`egm-zoom-out`, `egm-comprehension`, `egm-design`] - Severity: Medium
*   **Affected Scope:** [Lines 160–165, 369–371](docs/designs/mception.md#L160-L165) (Data Model, Target Files)
*   **Discrepancy Description:** The schema specifies an `oauth_clients` table without any registration or provisioning mechanisms. In OAuth 2.1 with PKCE, Gemini Spark operates as a public client.
*   **Rationale:** A static database table for dynamic OAuth clients is an unmanaged dead-end.
*   **AI Suggestion:** PROPOSE FIX
*   **Justification:** Remove `oauth_clients` table. Validate client authorization requests by verifying that `redirect_uri` matches configured allowed patterns and that PKCE S256 is present.
*   **Proposed Edit:**
    *   Location: `### Data Model and Storage`, `#### 14. src/oauth/server.ts`
    *   Change: Delete `CREATE TABLE oauth_clients`. Specify redirect URI pattern validation in `src/oauth/server.ts`.

---

### 8. Undefined Credential Payload Schemas [`egm-comprehension`, `egm-implementation-readiness`] - Severity: Medium
*   **Affected Scope:** [Lines 149–158, 349–353](docs/designs/mception.md#L149-L353) (Data Model, Target Files)
*   **Discrepancy Description:** Stored credentials use `auth_type` strings and an encrypted blob, but the explicit JSON/TypeScript payload schema per auth type is omitted.
*   **Rationale:** The Zero-Decision Rule requires an explicit TypeScript discriminated union so the implementer does not invent field names.
*   **AI Suggestion:** PROPOSE FIX
*   **Justification:** Document the explicit `CredentialPayload` discriminated union in the technical plan.
*   **Proposed Edit:**
    *   Location: `### Data Model and Storage`, `#### 11. src/crypto/encryption.ts`
    *   Change: Add code block with `CredentialPayload` union type covering `none`, `bearer`, `api_key_header`, `api_key_query`, `basic`, and `custom_headers`.

---

### 9. Lack of Execution Phasing in Implementation Plan [`egm-implementation-readiness`, `egm-codebase-details`] - Severity: High
*   **Affected Scope:** [Lines 288–464](docs/designs/mception.md#L288-L464) (Detailed Implementation Plan)
*   **Discrepancy Description:** The implementation plan presents a flat list of files without execution sequence, dependency graph, or phased verification checkpoints.
*   **Rationale:** The Implementation Readiness Standard explicitly mandates partitioning work into logical, incremental phases leaving the codebase buildable and testable at each phase.
*   **AI Suggestion:** PROPOSE FIX
*   **Justification:** Partition the 20+ target files into 5 sequential, verifiable phases.
*   **Proposed Edit:**
    *   Location: `## Detailed Implementation Plan`
    *   Change: Group file deliverables into Phase 1 (Scaffolding & Core Crypto/DB), Phase 2 (Security & Network Agent), Phase 3 (OAuth 2.1 Engine), Phase 4 (MCP Reverse Proxy Subsystem), Phase 5 (Web Dashboard & Packaging).

---

### 10. Heavy Native Addons (`better-sqlite3`) vs. Node 22 Built-in SQLite [`egm-zoom-out`, `egm-codebase-details`] - Severity: Low
*   **Affected Scope:** [Lines 294, 305, 330–337](docs/designs/mception.md#L294-L337) (Target Files)
*   **Discrepancy Description:** Specifying `better-sqlite3` requires compiling C++ native addons (`python3`, `make`, `g++`) inside the Alpine Docker build stage. Node 22 includes built-in `node:sqlite`.
*   **Rationale:** While Node 22 built-in `node:sqlite` avoids native build toolchains, `better-sqlite3` is currently required for Kysely's typed query builder.
*   **AI Suggestion:** CONTEST
*   **Justification:** Retaining `better-sqlite3` with Kysely provides type-safe SQL queries and compile-time schema checking that raw `node:sqlite` currently lacks without a dedicated adapter. Keep `better-sqlite3`, but lock explicit Alpine build dependencies (`python3 make g++`) in the multi-stage Dockerfile.
*   **Proposed Edit:** N/A (Keep `better-sqlite3` and Kysely; clarify Alpine build packages in Dockerfile).

---

### 11. Factual Contradictions and Style Fixes [`egm-style`] - Severity: Medium
*   **Affected Scope:** [Lines 19, 238, 250, 258, 260, 262, 312, 352, 372, 379, 424, 468, 480](docs/designs/mception.md#L19-L480)
*   **Discrepancy Description:** Line 468 states `npm run build: Executes tsc --noEmit and emits JavaScript to dist/.` which is factually impossible (`--noEmit` prevents emitting files). Multiple instances of marketing fluff ("turn-key", "seamlessly", "destroying single-container deployability") and trailing process watermark `*Drafted with EGM*`.
*   **Rationale:** Technical documentation must be objective, factually accurate, and free of promotional jargon.
*   **AI Suggestion:** PROPOSE FIX
*   **Justification:** Correct build commands, replace melodramatic idioms with neutral engineering terms, and delete the process watermark.
*   **Proposed Edit:**
    *   Location: Verification Plan, Alternatives, and throughout text
    *   Change: Update line 468 to `tsc -p tsconfig.json`, replace buzzwords, remove line 480.
