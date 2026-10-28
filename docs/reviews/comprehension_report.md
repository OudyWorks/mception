# Stage 6 Report: Comprehension Test

**Target Document**: `docs/designs/mception.md` (Lines 1..480)  
**Reviewer Persona**: Naive Reader (`egm-comprehension`)  
**Standard**: `re-implementation-standard.md`  
**Status**: FAILED (Critical specification gaps and ambiguities prevent independent implementation)

---

## Executive Summary

The document establishes the high-level concept of bridging Gemini Spark's OAuth 2.1 PKCE requirements to static upstream MCP credentials. However, from the perspective of an engineer or AI session tasked with implementing the codebase with zero unstated assumptions, critical architectural contracts and lifecycles are undefined.

Most notably, the authentication subsystem for both management surfaces (Root MCP and Web Dashboard) is completely omitted, the OAuth 2.1 client lifecycle and state preservation during credential capture are missing, stored credential schemas are undefined, and core MCP SSE transport contracts (such as dynamic `endpoint` event rewriting) are not specified.

---

## Detailed Findings

### 1. Blocker Issues

#### 1.1 Undefined Authentication Architecture for Root Management MCP and Web Dashboard
* **Severity**: Blocker
* **Affected Scope**: Lines 31–32, 74–75, 105–112, 294, 400–415 (Sections: *Goals*, *Architectural Overview*, *Route Topology*, *Detailed Implementation Plan*)
* **Discrepancy Description & Rationale**:
  * The document asserts that the Root Management MCP and Web Dashboard are "connected to Gemini Spark via Google OAuth" (lines 31, 75, 404). However, no Google OAuth endpoints (`/auth/google/login`, `/auth/google/callback`, etc.) or session management endpoints exist in the route topology (lines 101–123).
  * Gemini Spark enforces OAuth 2.1 with PKCE for all remote MCP tool integrations (line 11). The document fails to explain how Gemini Spark authenticates to `/root/sse` and `/root/messages`: does the Root MCP run its own OAuth 2.1 server, or does Gemini Spark transmit Google OAuth tokens directly in headers? If the latter, what headers and scopes are expected?
  * `package.json` (line 294) specifies no Google OAuth verification library (such as `google-auth-library`), nor any JWT decoding/validation library (e.g., `jose` or `jsonwebtoken`).
  * For the Web Dashboard, the mechanism by which `GET /api/mcps` authenticates the caller to identify the active `user_id` (cookies, bearer tokens, session storage) is completely unstated. A fresh implementer cannot build either interface without guessing the entire authentication subsystem.

#### 1.2 Undefined OAuth 2.1 Client Lifecycle & Missing Handshake State Management
* **Severity**: Blocker
* **Affected Scope**: Lines 113–118, 160–165, 366–379 (Sections: *Route Topology*, *Data Model*, *Detailed Implementation Plan: `oauth/server.ts` & `oauth/consent.ts`*)
* **Discrepancy Description & Rationale**:
  * The database specifies an `oauth_clients` table (lines 160–165), but the document never defines how client records are provisioned or registered. Does MCeption implement RFC 7591 Dynamic Client Registration, rely on pre-seeded records, or dynamically accept arbitrary `client_id`s from Gemini Spark? If `oauth_clients` must be pre-populated, the required client ID, secrets, and redirect URIs for Gemini Spark are not documented.
  * During the authorization code flow, if credentials do not exist, the user is redirected to `GET /{user_slug}/{identifier}/oauth/consent`. However, the OAuth parameters (`client_id`, `redirect_uri`, `state`, `code_challenge`, `code_challenge_method`) are not persisted in any session store or database table, nor does the `auth_codes` table schema (lines 167–176) store `state`. Without preserving `state`, the subsequent redirect back to Gemini Spark's `redirect_uri` cannot supply the mandatory `state` parameter, causing Gemini Spark to reject the handshake.

#### 1.3 Missing Plaintext/Ciphertext Payload Schemas for Stored Credentials
* **Severity**: Blocker
* **Affected Scope**: Lines 149–158, 218–223, 349–353, 377 (Sections: *Data Model*, *Transport & Proxy Subsystem*, *Detailed Implementation Plan: `encryption.ts` & `consent.ts`*)
* **Discrepancy Description & Rationale**:
  * The `credentials` table defines `encrypted_payload BLOB NOT NULL` with supported `auth_type`s: `none`, `bearer`, `api_key_header`, `api_key_query`, `basic`, and `custom_headers`.
  * The document never defines the JSON object schema expected for each `auth_type` before encryption / after decryption. For example, it is unspecified whether `api_key_header` expects `{ "header": string, "key": string }` or `{ "header_name": string, "value": string }`, whether `basic` expects `{ "username": string, "password": string }`, or how `custom_headers` encodes header dictionaries. An implementer cannot construct the consent form parser, encryption serializer, or proxy header injector without guessing these property schemas.

---

### 2. Major Issues

#### 2.1 Missing MCP SSE `endpoint` Event Rewriting and Target Routing Contract
* **Severity**: Major
* **Affected Scope**: Lines 40, 120–123, 213–224, 381–398 (Sections: *Non-Goals*, *Route Topology*, *Transport & Proxy Subsystem*, *Detailed Implementation Plan: `sse.ts` & `messages.ts`*)
* **Discrepancy Description & Rationale**:
  * Under the MCP SSE transport specification, an upstream MCP server sends an initial `endpoint` event containing the target URI for JSON-RPC POST requests (e.g., `event: endpoint\ndata: /messages?sessionId=...` or a full URL).
  * If MCeption pipes upstream SSE events directly down to Gemini Spark without rewriting this URI, Gemini Spark will attempt to send JSON-RPC calls either directly to the upstream server (bypassing the proxy) or to an invalid base path. MCeption must rewrite the `endpoint` URI to point to `/{user_slug}/{identifier}/messages?sessionId=...`.
  * The document does not describe this translation and contradicts it in *Non-Goals* (line 40: "MCeption does not rewrite JSON-RPC payloads... functions strictly as an authentication and transport proxy").
  * Furthermore, line 224 hardcodes upstream forwarding to `<upstream_url>/messages?sessionId=...`, which will break any upstream server whose `endpoint` event advertises a custom path (e.g., `/message`, `/rpc`, or `/jsonrpc`).

#### 2.2 Undefined User Provisioning and `user_slug` Generation Rules
* **Severity**: Major
* **Affected Scope**: Lines 129–136, 271 (Sections: *Data Model and Storage*, *Non-Functional Requirements: Security & Privacy*)
* **Discrepancy Description & Rationale**:
  * The `users` table requires `google_sub`, `email`, and `user_slug` (`UNIQUE NOT NULL`).
  * The document never defines when or how a user record is inserted, nor the deterministic algorithm for generating `user_slug` (e.g., character sanitization, lowercase conversion, collision handling for identical email prefixes).
  * Routing middleware relies on `{user_slug}` to enforce tenant boundaries, but behavior when `{user_slug}` is unknown (404 vs 401) is unstated.

#### 2.3 Unresolved Token Lifetimes, Refresh Grant Omission, and Token Schema
* **Severity**: Major
* **Affected Scope**: Lines 46–47, 118, 178–185, 272, 371 (Sections: *Open Questions*, *Data Model*, *Non-Functional Requirements*, *Detailed Implementation Plan: `oauth/server.ts`*)
* **Discrepancy Description & Rationale**:
  * Question 2 in *Open Questions* explicitly leaves token lifetimes unresolved ("What is the ideal session lifetime for ephemeral authorization codes and virtual OAuth refresh tokens before requiring complete re-authorization?"). While authorization codes are given a 60s expiration in line 272, the TTLs for access tokens and refresh tokens are completely omitted.
  * The `tokens` table includes `token_type CHECK(token_type IN ('access', 'refresh'))`, but the OAuth server specification (lines 118, 371) does not specify whether `POST /oauth/token` supports `grant_type=refresh_token`, nor how refresh token rotation or expiration is handled.
  * The JSON response schema for `POST /oauth/token` (e.g. RFC 6749 fields `access_token`, `token_type`, `expires_in`, `refresh_token`) is not defined.

#### 2.4 Missing Parameter & Return Schemas for Root MCP Tools and Dashboard REST API
* **Severity**: Major
* **Affected Scope**: Lines 106–112, 401–415 (Sections: *Route Topology*, *Detailed Implementation Plan: `root-mcp/server.ts` & `web/routes.ts`*)
* **Discrepancy Description & Rationale**:
  * The Root MCP tools (`register_mcp`, `list_mcps`, `remove_mcp`) lack parameter schemas (e.g., regex constraints on `identifier`, URL protocol validation on `upstream_url`) and return output structures.
  * The Web Dashboard REST endpoints (`GET /api/mcps`, `POST /api/mcps`, `DELETE /api/mcps/:identifier`) lack request body schemas, response payloads, and HTTP status code definitions (200, 201, 400, 404, 409).
  * Neither interface provides a route or tool to update credentials for an existing MCP, contradicting line 226 ("Please update credentials via MCeption dashboard").

#### 2.5 Ambiguous "Upstream Refresh Capabilities" Mechanism
* **Severity**: Major
* **Affected Scope**: Lines 225–227 (Section: *Transport & Proxy Subsystem: Error Propagation & Token Refresh*)
* **Discrepancy Description & Rationale**:
  * Line 226 states: "If upstream returns HTTP 401, MCeption checks if refresh capabilities exist for upstream. If not, MCeption returns an explicit JSON-RPC error response...".
  * MCeption only captures static upstream credentials (static tokens, API keys, basic auth); it does not act as an OAuth client to upstream services. The document never defines what "refresh capabilities" means or how MCeption could refresh upstream credentials.

---

### 3. Nit Issues

#### 3.1 Missing `/healthz` Route in Route Topology
* **Severity**: Nit
* **Affected Scope**: Lines 101–123 vs Line 306 (Sections: *Route Topology and Namespacing* vs *Detailed Implementation Plan: `Dockerfile`*)
* **Discrepancy Description & Rationale**:
  * The Dockerfile configures a container healthcheck against `/healthz`, but `/healthz` is omitted from the Route Topology and Namespacing specification.

#### 3.2 Unspecified Timestamp Precision in SQLite Schema
* **Severity**: Nit
* **Affected Scope**: Lines 128–186 (Section: *Data Model and Storage*)
* **Discrepancy Description & Rationale**:
  * All timestamp columns (`created_at`, `updated_at`, `expires_at`, `used_at`, `revoked_at`) are typed as `INTEGER NOT NULL`. The document does not specify whether values should be stored as Unix epoch seconds or milliseconds.

#### 3.3 Inconsistent Master Key Encoding Specification
* **Severity**: Nit
* **Affected Scope**: Line 190 vs Line 326 (Sections: *Credential Encryption Subsystem* vs *Detailed Implementation Plan: `config.ts`*)
* **Discrepancy Description & Rationale**:
  * Line 190 specifies that `MCEPTION_MASTER_KEY` is "(hex or base64 encoded)", whereas line 326 states that `src/config.ts` enforces that it is "(hex or raw)".
