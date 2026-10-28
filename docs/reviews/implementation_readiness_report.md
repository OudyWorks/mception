# Stage 9 Report: Implementation Readiness Test

**Target Document**: `docs/designs/mception.md` (Lines 288..480, `DetailedRange`)  
**Reviewers**: Pragmatic Tech Lead (`egm-implementation-readiness`), Technical Quality Auditor (`egm-codebase-details`), Technical Copy Editor (`egm-style`)  
**Standard**: `implementation-readiness-standard.md` (Zero-Decision Rule)  
**Status**: FAILED (Critical actionability gaps, protocol oversights, and missing execution phasing)

---

## Executive Summary

The Detailed Implementation Plan provides an itemized inventory of 26 target files, but currently fails the **Implementation Readiness Standard** and the **Zero-Decision Rule**. 

An engineer or autonomous AI session cannot build the codebase from this plan without making major architectural and security design choices:
1. **Total absence of phasing and checkpoints**: The plan presents a flat file list without an execution sequence, dependency ordering, or intermediate buildable/testable milestones.
2. **Fatal MCP SSE protocol oversight**: The proxy subsystem naively pipes SSE bytes without parsing or rewriting the upstream `endpoint` event, which will break all downstream JSON-RPC message routing from Gemini Spark.
3. **Missing authentication & session architecture**: The plan references Google OAuth for `/root/sse` and `/api/mcps`, but defines zero authentication endpoints, session middleware, token storage mechanisms, or client dependencies.
4. **Transport agent incompatibility**: Custom Node `http.Agent` / `https.Agent` socket wrapping fails to protect native `fetch` / Undici calls used in modern runtimes and the MCP SDK.
5. **Technical copy contradictions and hyperbole**: Build commands contain factual contradictions (`tsc --noEmit` emitting files), accompanied by unprovable claims and marketing buzzwords.

---

## Detailed Findings

### 1. Blocker Findings

#### 1.1 Total Absence of Execution Phasing & Checkpoints (Standard Violation)
* **Reviewer Lens**: `egm-implementation-readiness`, `egm-codebase-details`
* **Affected Scope**: Lines 288–480 (Global)
* **Finding & Guidance**: The plan presents a flat list of 26 files without logical execution phasing or intermediate checkpoints. The standard explicitly states: *"The plan must partition the work into logical, incremental phases. Each phase must leave the codebase in a stable, buildable, and testable state."* An implementer cannot discern execution order or how to verify intermediate milestones.
  * **Remediation**: Structure the plan into 6 verifiable phases:
    1. **Phase 1: Foundation & Core Storage** (`package.json`, `tsconfig.json`, `src/config.ts`, `src/db/*`, `src/crypto/*`, unit tests).
    2. **Phase 2: Security & Network Guard** (`src/security/ssrf.ts`, SSRF unit tests).
    3. **Phase 3: OAuth 2.1 Engine & Credential Management** (`src/oauth/*`, OAuth integration tests).
    4. **Phase 4: MCP Reverse Proxy Subsystem** (`src/proxy/*`, proxy integration tests).
    5. **Phase 5: Management Interfaces** (`src/web/*`, `src/web/public/index.html`).
    6. **Phase 6: Application Assembly & Containerization** (`src/index.ts`, `Dockerfile`, `docker-compose.yml`, `README.md`).

#### 1.2 Missing MCP SSE `endpoint` Event Rewriting & Session Mapping (Protocol Fatal Flaw)
* **Reviewer Lens**: `egm-codebase-details`
* **Affected Scope**: Lines 381–399 (`src/proxy/sse.ts`, `src/proxy/messages.ts`)
* **Finding & Guidance**: Under the MCP HTTP/SSE transport specification, connecting to `GET /sse` causes the server to emit an `endpoint` event containing the target URI for JSON-RPC POST requests (`event: endpoint\ndata: /messages?sessionId=...`).
  Line 386 states that MCeption naively pipes upstream SSE bytes down to Gemini Spark. As a result, Gemini Spark will receive the internal upstream URI and attempt to POST directly to the upstream server or to an unmapped path.
  * **Remediation**: The plan must explicitly detail that `src/proxy/sse.ts` parses the initial upstream SSE `endpoint` event, rewrites the path to MCeption's virtual message route (`/{identifier}/messages?sessionId=<proxy_session_id>`), and maintains a bidirectional session map linking Gemini's session to the upstream session.

#### 1.3 Undefined Authentication & Session Architecture for Management Interfaces
* **Reviewer Lens**: `egm-implementation-readiness`, `egm-codebase-details`
* **Affected Scope**: Lines 292–296, lines 400–416
* **Finding & Guidance**: Line 404 specifies `/root/sse` is "authenticated via Google OAuth" and line 412 specifies `GET /api/mcps` serves the "authenticated user", but:
  1. No Google OAuth initiation or callback routes are defined (`GET /auth/google`, `GET /auth/google/callback`).
  2. No session or cookie management plugin (`@fastify/secure-session`) is declared in dependencies.
  3. No user provisioning logic (`users` table record insertion on Google OAuth callback) is specified.
  * **Remediation**: Either formalize the full Google OAuth session architecture and dependencies, or (per Zoom Out Stage 8 recommendation) prune the speculative multi-tenancy and secure management endpoints via an admin token (`ADMIN_API_KEY`).

---

### 2. Major Findings

#### 2.1 Undefined Payload Schemas for Encrypted Credentials
* **Reviewer Lens**: `egm-implementation-readiness`
* **Affected Scope**: Lines 349–353, lines 374–380, lines 391–399
* **Finding & Guidance**: `src/crypto/encryption.ts` accepts `payload: object`, but the exact schema for each `auth_type` is undefined. The implementer must guess property names.
  * **Remediation**: Define an explicit TypeScript discriminated union:
    ```typescript
    type CredentialPayload =
      | { type: 'none' }
      | { type: 'bearer'; token: string }
      | { type: 'api_key_header'; headerName: string; apiKey: string }
      | { type: 'api_key_query'; paramName: string; apiKey: string }
      | { type: 'basic'; username: string; password: string }
      | { type: 'custom_headers'; headers: Record<string, string> };
    ```

#### 2.2 Transport Incompatibility: `http.Agent` vs. Modern Fetch / Undici
* **Reviewer Lens**: `egm-codebase-details`
* **Affected Scope**: Lines 359–365, lines 381–399
* **Finding & Guidance**: The plan proposes custom Node `http.Agent` / `https.Agent` for socket DNS pinning. Node.js 22 LTS and modern packages (including `@modelcontextprotocol/sdk`) use global `fetch` backed by Undici, which completely ignores Node `http.Agent`. If proxy requests use `fetch`, SSRF protections are bypassed.
  * **Remediation**: Explicitly specify the HTTP client engine. If using Undici/fetch, implement a custom Undici `Agent` / `buildConnector`; if using `node:http`, document explicit transport boundaries.

#### 2.3 Heavy Native C++ Addons vs. Node 22 Built-in SQLite
* **Reviewer Lens**: `egm-codebase-details`
* **Affected Scope**: Lines 292–296, lines 302–308, lines 329–338
* **Finding & Guidance**: Relying on `better-sqlite3` requires compiling C++ native addons (`python3`, `make`, `g++`) inside Alpine Docker, inflating image build times and failure surface. Node.js 22 LTS includes built-in `node:sqlite`.
  * **Remediation**: Evaluate using Node 22's native `node:sqlite` directly, eliminating all C++ build tools from the container image.

#### 2.4 Complete Omission of Test Infrastructure Mocks and Helpers
* **Reviewer Lens**: `egm-implementation-readiness`, `egm-codebase-details`
* **Affected Scope**: Lines 445–464
* **Finding & Guidance**: The plan describes spinning up mock upstream MCP servers and testing full OAuth lifecycles without specifying test helpers or harnesses.
  * **Remediation**: Add explicit file definitions for test helpers: `tests/helpers/test-db.ts` (in-memory SQLite), `tests/helpers/mock-upstream.ts` (mock SSE and message server), and `tests/helpers/test-app.ts` (Fastify injection harness).

#### 2.5 Factual Contradiction in Build Step
* **Reviewer Lens**: `egm-style`
* **Affected Scope**: Line 468
* **Finding & Guidance**: Line 468 states: `"npm run build: Executes tsc --noEmit and emits JavaScript to dist/."` The `--noEmit` flag explicitly prevents emitting files.
  * **Remediation**: Correct to `"npm run build: Executes tsc to compile and emit JavaScript to dist/."`

#### 2.6 Absolute Guarantees and Marketing Buzzwords
* **Reviewer Lens**: `egm-style`
* **Affected Scope**: Lines 312, 352, 372, 379, 424, 458
* **Finding & Guidance**: The text relies on promotional claims ("turn-key", "seamlessly", "loads instantly", "guarantees zero plaintext exposure", "guarantees compatibility").
  * **Remediation**: Replace with objective, verifiable engineering descriptions.

---

### 3. Nit Findings

#### 3.1 Unhandled Length Mismatch in PKCE Constant-Time Comparison
* **Reviewer Lens**: `egm-codebase-details`
* **Affected Scope**: Lines 354–358
* **Finding & Guidance**: In `crypto.timingSafeEqual(a, b)`, if `a.length !== b.length`, an unhandled `RangeError` is thrown.
  * **Remediation**: Document that buffer lengths must be checked before invoking `timingSafeEqual`.

#### 3.2 Missing Configuration Defaults in Zod Schema
* **Reviewer Lens**: `egm-implementation-readiness`
* **Affected Scope**: Lines 324–328
* **Finding & Guidance**: `PORT`, `LOG_LEVEL`, and `DATABASE_PATH` default values are not explicitly stated in the config task.
  * **Remediation**: Specify concrete Zod schema defaults (`PORT: 3000`, `LOG_LEVEL: 'info'`, `DATABASE_PATH: '/data/mception.db'`).

#### 3.3 Non-Technical Process Metadata
* **Reviewer Lens**: `egm-style`
* **Affected Scope**: Line 480
* **Finding & Guidance**: Trailing `*Drafted with EGM*` attribution watermark should be removed.
