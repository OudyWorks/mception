# Stage 8 Report: Intermediate Zoom Out Review

**Target Document**: `docs/designs/mception.md` (Full file, Lines 1..481)  
**Reviewer Persona**: Skeptical Architect (`egm-zoom-out`)  
**Standard**: `zoom-out-standard.md`  
**Status**: FAILED (Critical complexity traps, YAGNI over-engineering, and mitigation bloat identified)

---

## Executive Summary

As the design progressed through Stages 5, 6, and 7, downstream reviews uncovered critical implementation omissions—namely, undefined session management, unauthenticated consent flows, ambiguous client registration, and missing Google OAuth endpoints. 

However, instead of questioning the root premises that caused these omissions, the previous reviews proposed **piling on additional architectural layers**: adding full Google OAuth login flows, JWT session cookies, dynamic client registration (RFC 7591), user-slug collision engines, and complex state preservation during interactive consent screens.

This intermediate audit evaluates the cumulative architecture from a high altitude. If we accept the proposed mitigations, MCeption ceases to be a lightweight, single-container developer gateway and mutates into a full-blown multi-tenant identity provider. 

To achieve architectural viability before implementation readiness, we must **prune speculative scope** rather than patching it with more code:
1. **Prune Multi-Tenancy**: Drop the `users` table, `{user_slug}` routing, and Google OAuth requirement in favor of a single-tenant or team-scoped gateway secured via administrative API keys/tokens.
2. **Decouple Credential Entry from OAuth Handshake**: Collect upstream credentials at endpoint creation time in the Web Dashboard, making the OAuth 2.1 authorization endpoint a clean, deterministic redirect.
3. **Cut the Redundant Root MCP**: Eliminate the secondary `@modelcontextprotocol/sdk` management server in v1.
4. **Prune `oauth_clients` Table**: Validate Gemini Spark's public client PKCE handshake against configured redirect domains without dynamic client registration.

---

## Detailed Findings

### 1. Blocker: The "Fix Bloat" Complexity Trap — Patching Speculative Multi-Tenancy Instead of Cutting It
* **Severity**: Blocker
* **Affected Scope**: Lines 28, 129–136, 105–123, 271, 316, 366–380; Comprehension Finding 1.1, 2.2; Critic Finding 1.1
* **Simplicity Rationale**:
  * Downstream reviews correctly identified that the document lacked Google OAuth endpoints (`/auth/google/login`, `/auth/google/callback`), session management, and user provisioning, and that anyone could trigger an OAuth flow against `/{victim_slug}/{identifier}/oauth/authorize` without session authentication.
  * The proposed fix across previous reports was to build a full authentication suite: add `google-auth-library` or `jose`, implement user-slug generation/collision logic, persist session cookies, and enforce tenant boundary middleware.
  * **This is a severe YAGNI violation and complexity trap.** MCeption is explicitly positioned as a lightweight, single-container developer tool for *"individual developers and self-hosted teams"* (lines 34, 39).
  * Forcing an individual developer to set up a Google Cloud Console project, configure OAuth consent screens, and manage client secrets just to run a local proxy gateway introduces immense setup friction.
  * **Architectural Fix**: Cut the speculative multi-tenancy entirely. 
    1. Eliminate the `users` table, `google_sub`, and `{user_slug}` from routes. Virtual endpoints become simply `/{identifier}/sse`, `/{identifier}/messages`, `/{identifier}/oauth/authorize`, etc.
    2. Protect management routes (`/api/mcps` and Web Dashboard) via a simple administrative API key or local dashboard bearer token (`ADMIN_API_KEY`).
    3. This eliminates Google OAuth dependencies, session cookie machinery, user slug collision handlers, and cross-tenant authorization bypass risks at zero cost.

---

### 2. Blocker: Capturing Upstream Credentials During OAuth Handshake is an Architectural Anti-Pattern
* **Severity**: Blocker
* **Affected Scope**: Lines 116–117, 374–380; Comprehension Finding 1.2; Critic Finding 1.1
* **Simplicity Rationale**:
  * The design defers upstream credential entry (API keys, Basic auth) to a custom HTML form rendered *midway through the OAuth 2.1 authorization redirect* (`GET /{user_slug}/{identifier}/oauth/consent`).
  * As noted in Stages 6 and 7, this requires MCeption to pause the OAuth handshake, stash transient OAuth query parameters (`client_id`, `redirect_uri`, `state`, `code_challenge`, `code_challenge_method`), handle form rendering and validation errors, and resume the flow without losing `state`.
  * **Simplicity Rationale**: The user is already in the MCeption Web Dashboard to create the endpoint. Forcing credential capture into the OAuth consent screen creates an unnecessary distributed transaction between Gemini's browser redirect and MCeption's credential store.
  * **Architectural Fix**: Capture and encrypt upstream credentials directly when the user registers the endpoint in the Web Dashboard (`POST /api/mcps`). The OAuth 2.1 `/oauth/authorize` endpoint then becomes a standard, instantaneous redirect: it validates the PKCE challenge, generates the authorization code, and redirects immediately to Gemini's `redirect_uri` with `state`. This completely eliminates `src/oauth/consent.ts` and transient OAuth form state machines.

---

### 3. Major: Redundant Dual Control Plane (Root MCP vs. Web Dashboard)
* **Severity**: Major
* **Affected Scope**: Lines 30–33, 77–81, 110–111, 400–406; Comprehension Finding 1.1, 2.4; Zoom Out Finding 4
* **Simplicity Rationale**:
  * The proposal introduces a secondary MCP server stack (`@modelcontextprotocol/sdk`, `/root/sse`, `/root/messages`) inside MCeption to support conversational management (`register_mcp`, `list_mcps`, `remove_mcp`) alongside a Web Dashboard.
  * However, conversational registration cannot complete the connection loop inside Gemini Spark: Gemini Spark requires the user to open its graphical "Connected Apps" settings, manually paste the URL, and trigger OAuth authorization. 
  * Maintaining an MCP SDK server stack, its independent authentication, and tool execution lifecycles to perform 3 database CRUD operations that the Web Dashboard already handles is premature abstraction and double maintenance overhead.
  * **Architectural Fix**: Cut the Root Management MCP from v1. Standardize on the lightweight Web Dashboard for creating endpoints, managing credentials, and copying Connected App URLs.

---

### 4. Major: Speculative `oauth_clients` Table and RFC 7591 Dynamic Client Registration
* **Severity**: Major
* **Affected Scope**: Lines 160–165, 369–371; Comprehension Finding 1.2; Critic Finding 2.1
* **Simplicity Rationale**:
  * Critic and Comprehension reports recommended adding RFC 7591 Dynamic Client Registration or pre-seeding `oauth_clients` in database migrations to prevent open redirects.
  * In OAuth 2.1 with PKCE, Gemini Spark operates as a public client. Introducing client registration machinery, pre-shared client secrets, or client database tables into a single-container proxy gateway violates YAGNI.
  * **Architectural Fix**: Drop the `oauth_clients` table. Validate Gemini Spark's authorization requests by verifying that the `redirect_uri` matches an allowed pattern (e.g. Gemini Spark's known redirect URI or an environment-configured `ALLOWED_REDIRECT_URI`) and that PKCE `code_challenge_method=S256` is present.

---

### 5. Major: SSRF Default Configuration Inversion
* **Severity**: Major
* **Affected Scope**: Lines 196–207, 359–365; Zoom Out Finding 2; Critic Finding 2.2
* **Simplicity Rationale**:
  * The design blocks private IP ranges (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `127.0.0.1`) *by default*.
  * MCeption's core target audience is developers connecting Gemini Spark to local tools running in containers (Docker networks use `172.16.0.0/12`) or local host ports (`127.0.0.1`).
  * Enforcing enterprise multi-tenant cloud egress restrictions by default ensures that 90%+ of developer connections will fail immediately upon installation.
  * Furthermore, building custom Node.js `http.Agent` / `https.Agent` socket wrappers with manual DNS pinning and custom redirect loops introduces high maintenance overhead.
  * **Architectural Fix**: 
    1. By default, block only cloud metadata services (`169.254.169.254`, `fe80::/10`) to prevent credential exfiltration.
    2. Allow local and private network connections by default, providing an explicit `BLOCK_PRIVATE_NETWORKS=true` toggle for public cloud deployments.
    3. Enforce `maxRedirects: 0` on outbound proxy calls to prevent redirect-based SSRF bypasses simply and cleanly without complex socket interception.

---

### 6. Nit: Native Addon Dependencies in Single-Container Image
* **Severity**: Nit
* **Affected Scope**: Lines 294, 305, 330–337
* **Simplicity Rationale**:
  * Using `better-sqlite3` requires compiling C++ native addons (`python`, `make`, `g++`) inside the Alpine Docker build stage, inflating build times and container complexity.
  * Node.js 22 LTS includes native `node:sqlite` out of the box, or lightweight pure JS SQLite drivers can be used to keep Docker builds fast, small, and toolchain-free.

---

## Conclusion & Architectural Recommendation

The core concept of MCeption—an OAuth 2.1 PKCE bridge that injects static credentials into MCP streams—is sound and addresses a real need. However, the design currently suffers from an identity crisis: it tries to be both a simple single-container developer proxy and a multi-tenant enterprise SaaS gateway.

Before proceeding to Stage 9 (Detailed Implementation Readiness Test), the architecture should be simplified:
1. **Strip multi-tenancy, Google OAuth, and user slugs** -> Single-tenant / team gateway with admin key.
2. **Collect credentials at endpoint registration in Dashboard** -> Clean, instant OAuth 2.1 redirect.
3. **Drop Root MCP** -> Single Web Dashboard interface.
4. **Prune `oauth_clients` table** -> Config/pattern-based redirect URI validation with PKCE S256.
5. **Invert SSRF defaults** -> Block cloud metadata by default; allow local/private networks out-of-the-box.
