# Stage 7 Report: Critic Review

**Target Document**: `docs/designs/mception.md` (Lines 1..287, `FeatureRange`)  
**Reviewers**: Design Critic (`egm-design`), Document Architect (`egm-structural`), Technical Copy Editor (`egm-style`)  
**Standard**: `feature-spec-standard.md`  
**Status**: FAILED (Critical security vulnerabilities, protocol flaws, and missing mandatory sections identified)

---

## Executive Summary

The Feature Specification proposes an OAuth 2.1 translation proxy between Gemini Spark and upstream MCP servers. While the architectural concept addresses a clear ecosystem incompatibility, the critic review identified severe design vulnerabilities:
1. **Unauthenticated authorization code issuance & session gating gap**: No session authentication or tenant boundary verification during OAuth authorize/consent handshakes.
2. **Broken MCP SSE transport handling**: Failure to rewrite the upstream `endpoint` SSE event and misunderstanding of JSON-RPC return paths over SSE.
3. **Missing mandatory "Risks & Mitigations" section**: Non-compliance with the Feature Specification Standard regarding operational and failure mode analysis.
4. **SSRF protection bypasses**: Lack of HTTP redirect validation and TLS SNI pinning failure.
5. **Hyperbolic copy and tone issues**: Subjective idioms and promotional phrasing in the problem and alternatives sections.

---

## Prioritized Findings

### 1. Blocker Findings

#### 1.1 Unauthenticated Authorization Code Issuance & Session Gating Gap (Auth Bypass Risk)
* **Reviewer Lens**: `egm-design`
* **Affected Scope**: Lines 113–119, Lines 167–176
* **Discrepancy Description**: The specification describes the OAuth 2.1 flow via `GET /{user_slug}/{identifier}/oauth/authorize` and `GET/POST .../oauth/consent`, but does not define how the resource owner is authenticated when redirected to this endpoint. If a user is not logged in, or if an anonymous attacker triggers the flow targeting a victim's slug (`/{victim_slug}/{identifier}/oauth/authorize`), there is no session verification against `users.id`.
* **Rationale & Recommendation**: Explicitly specify that `GET /{user_slug}/{identifier}/oauth/authorize` and `oauth/consent` require an authenticated session cookie. If no session is present, redirect to Google Login with a secure `return_to` state parameter before displaying the consent screen. Enforce that the authenticated user's ID matches the `user_slug` tenant boundary.

#### 1.2 Incompatible MCP SSE Protocol Handling & Session Routing
* **Reviewer Lens**: `egm-design`
* **Affected Scope**: Lines 209–227
* **Discrepancy Description**: Line 224 asserts: *"MCeption forwards the payload to `<upstream_url>/messages?sessionId=...` and streams the upstream response directly back to Gemini."* In the MCP SSE specification:
  1. `POST /messages?sessionId=...` returns HTTP 202 Accepted (or empty 200 OK); responses are emitted asynchronously over the SSE stream, not in the POST response body.
  2. The upstream server emits an `endpoint` event containing its message URL (e.g., `data: /messages?sessionId=upstream_sid`). Forwarding this unmodified causes Gemini Spark to attempt sending messages directly to the upstream server or to an invalid path.
* **Rationale & Recommendation**:
  1. Specify that MCeption intercepts and rewrites the upstream `endpoint` event so that Gemini Spark receives a message URL pointing back to MCeption (`/{user_slug}/{identifier}/messages?sessionId=<mapped_session_id>`).
  2. Maintain bidirectional session mapping between Gemini Spark's client session ID and the upstream session ID, forwarding JSON-RPC POST requests to upstream and streaming upstream SSE responses back down to Gemini.

#### 1.3 Missing Mandatory "Risks & Mitigations" Section
* **Reviewer Lens**: `egm-design`, `egm-structural`
* **Affected Scope**: Lines 1–287
* **Discrepancy Description**: The Feature Specification Standard mandates an explicit evaluation of constraints, failure modes, security implications, and scalability limits. While security attributes are mentioned in the NFR section, the document lacks a dedicated `## Risks & Mitigations` section analyzing runtime failure modes (upstream server outages, socket exhaustion, master key rotation/loss, and SQLite concurrent write contention).
* **Rationale & Recommendation**: Add a dedicated `## Risks & Mitigations` section providing structured failure mode analysis and concrete technical mitigations.

---

### 2. Major Findings

#### 2.1 Undefined OAuth Client Registration & Open Redirect Vulnerability
* **Reviewer Lens**: `egm-design`
* **Affected Scope**: Lines 113–118, Lines 160–165
* **Discrepancy Description**: The data model introduces an `oauth_clients` table, but client registration and validation are undefined. Without strict exact-string match validation for `redirect_uri` against pre-seeded client records, MCeption is vulnerable to open redirect and auth code theft.
* **Rationale & Recommendation**: Define the client provisioning model. If Gemini Spark uses known fixed redirect URIs, specify default pre-seeded configurations in migrations and enforce exact-match validation during `/oauth/authorize`.

#### 2.2 SSRF Protection Bypass via HTTP 3xx Redirects & Broken TLS SNI
* **Reviewer Lens**: `egm-design`
* **Affected Scope**: Lines 196–208
* **Discrepancy Description**:
  1. The socket-level DNS verification checks the initial hostname, but if an upstream service responds with an HTTP 301/302 redirecting to `169.254.169.254` or `127.0.0.1`, standard HTTP clients follow the redirect without re-validating the destination IP.
  2. Pinning an `https.Agent` directly to an IP address causes TLS certificate validation failures unless the TLS `servername` option is explicitly set to the original hostname.
* **Rationale & Recommendation**: Disable automatic redirect following (`maxRedirects: 0`) or force redirected URLs through pre-flight DNS validation. Explicitly require setting `servername: parsedUrl.hostname` in TLS socket configuration.

#### 2.3 Unbacked Upstream Token Refresh Claims
* **Reviewer Lens**: `egm-design`
* **Affected Scope**: Lines 150–158, Line 225
* **Discrepancy Description**: Line 225 claims MCeption checks if refresh capabilities exist for upstream on HTTP 401, but the `credentials` table only supports static payloads (`none`, `bearer`, `api_key_header`, `api_key_query`, `basic`, `custom_headers`). There are no fields or flows for upstream OAuth client credentials or token refresh.
* **Rationale & Recommendation**: Remove claims of upstream token refresh capabilities and specify that upstream 401 returns an explicit JSON-RPC error `-32001`.

#### 2.4 Lack of Master Key Versioning
* **Reviewer Lens**: `egm-design`
* **Affected Scope**: Lines 188–195
* **Discrepancy Description**: The `credentials` table lacks a `key_version` or `key_id` column. If `MCEPTION_MASTER_KEY` is rotated, all existing credentials become permanently undecryptable. Furthermore, auto-generating an ephemeral key in development mode without persistence causes decryption failures on every container restart.
* **Rationale & Recommendation**: Add `key_version INTEGER NOT NULL DEFAULT 1` to `credentials`. In development mode, persist any generated key to `/data/.dev_master_key`.

#### 2.5 Hyperbolic and Colloquial Phrasing in Alternatives & Problem Sections
* **Reviewer Lens**: `egm-style`
* **Affected Scope**: Lines 19, 238, 240, 250, 258, 260, 262
* **Discrepancy Description**: Several descriptions rely on melodramatic or informal expressions: "Catastrophic Credential Exposure" (L238), "ballooning container image size and risking dependency hell" (L250), "destroying single-container deployability" (L260), "battle-tested" (L258), and "locks out the vast majority of existing tools" (L19).
* **Rationale & Recommendation**: Replace with objective, factual engineering phrasing (e.g., "Plaintext Credential Exposure", "package dependency conflicts", "incompatible with the single-container deployment model", "standards-compliant").

---

### 3. Nit Findings

#### 3.1 Structural Heading Deviations
* **Reviewer Lens**: `egm-structural`
* **Affected Scope**: Lines 15, 25–42, 64
* **Discrepancy Description**: Standard template headings are slightly modified (`## The Problem` instead of `## Problem Statement`, `## Goals` and `## Non-Goals` split across separate H2s rather than grouped under `## Goals & Non-Goals`, and `## Technical Plan (Architecture)` instead of `## Proposed Architecture`).
* **Rationale & Recommendation**: Harmonize heading names with the standard blueprint for uniform cross-document indexing.

#### 3.2 Unlinked External Standard References
* **Reviewer Lens**: `egm-structural`
* **Affected Scope**: Lines 27, 103, 114, 198, 202
* **Discrepancy Description**: References to RFC 6749, RFC 7636, RFC 8414, and RFC 1918 are plain text without markdown hyperlinks.
* **Rationale & Recommendation**: Add formal markdown links to standard IETF RFC specifications.

#### 3.3 Synonym Redundancy and Subjective Modifiers
* **Reviewer Lens**: `egm-style`
* **Affected Scope**: Lines 13, 17, 21, 23, 32, 34, 46, 68, 214
* **Discrepancy Description**: Phrasing contains redundant doublets ("reverse proxy and gateway service", "bidirectional translation and proxy gateway"), unquantified modifiers ("trusted translation proxy", "low-footprint", "responsive visual interface"), and conversational spatial metaphors ("down to Gemini Spark").
* **Rationale & Recommendation**: Streamline descriptions to direct, factual prose.
