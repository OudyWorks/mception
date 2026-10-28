# MCeption: OAuth 2.1 Reverse Proxy & Hub for Gemini Spark MCPs

MCeption is an open-source reverse proxy and gateway service that bridges Google Gemini Spark's mandatory **OAuth 2.1 (PKCE S256)** authentication model with standard remote **Model Context Protocol (MCP)** servers using static authorization schemes (pre-shared API keys, static Bearer tokens, HTTP Basic authentication, or custom HTTP headers).

---

## The Problem

Gemini Spark requires all remote third-party tools to implement an OAuth 2.1 authorization server with PKCE `S256` verification. In contrast, virtually all existing community and enterprise MCP servers authenticate via static headers or query tokens. Instructing an LLM to pass API keys in prompts risks credential leakage, while requiring every upstream MCP maintainer to implement OAuth 2.1 state machines locks out existing tools.

MCeption solves this:
1. **Gemini Spark connects to MCeption via OAuth 2.1 PKCE**.
2. **MCeption terminates the OAuth handshake and manages token lifecycles**.
3. **MCeption intercepts and rewrites SSE transport `endpoint` events**.
4. **MCeption decrypts your stored credentials and transparently injects them** into outbound SSE streams and JSON-RPC tool calls.

---

## Features

* **Compliant OAuth 2.1 Authorization Server**: Implements RFC 6749 and RFC 7636 (Authorization Code grant with mandatory PKCE `S256` verification).
* **Zero-Plaintext at Rest**: Upstream secrets are encrypted using **AES-256-GCM** before writing to SQLite with automatic key versioning.
* **Support for Remote & Local MCPs**:
  * Any remote HTTPS/HTTP MCP server on the internet or cloud.
  * Local Docker containers (`172.16.0.0/12`) and localhost (`127.0.0.1`) are permitted by default for development.
* **SSRF Protection**: Blocks cloud metadata services (`169.254.169.254`, `fe80::/10`) by default; offers a `BLOCK_PRIVATE_NETWORKS=true` toggle for public cloud deployments. Automatic 3xx redirect following is disabled (`maxRedirects: 0`).
* **Built-in Web Dashboard**: Manage endpoints, configure credentials, and copy one-click Gemini Connected App URLs from a responsive browser UI.
* **Single-Container Deployment**: Fully self-contained Node.js + SQLite (WAL mode) deployment in a minimal Alpine Docker container.

---

## Quickstart

### Using Docker Compose (Recommended)

1. Clone the repository and navigate into the folder:
   ```bash
   git clone https://github.com/oudmane/mception.git
   cd mception
   ```

2. Start the service with Docker Compose:
   ```bash
   docker compose up -d
   ```

3. Open the dashboard at `http://localhost:3000`. Enter the default `ADMIN_API_KEY` (`mception-super-secret-admin-key`) in the top bar to connect.

---

### Local Node.js Development

Requirements: Node.js 22 LTS or newer.

```bash
# 1. Install dependencies
npm install

# 2. Run unit and integration tests
npm test

# 3. Build TypeScript
npm run build

# 4. Start the server
npm start
```

---

## Connecting an MCP to Gemini Spark

### 1. Register the MCP in MCeption
1. Open the MCeption Web Dashboard at `http://localhost:3000` (or your public tunnel domain).
2. Click **+ Register Remote MCP**.
3. Enter:
   * **Identifier**: e.g., `weather`
   * **Name**: e.g., `Weather Service`
   * **Remote Upstream URL**: e.g., `https://api.example.com/sse` (or `http://localhost:8080/sse`)
   * **Authentication Scheme**: Choose from `Bearer Token`, `API Key (Header)`, `API Key (Query Parameter)`, `Basic Auth`, or `Custom Headers`.
4. Click **Register Endpoint**.

### 2. Connect in Gemini Spark
1. In the dashboard card, click **Copy** on the generated **Gemini Connected App URL**:
   ```text
   https://mception.yourdomain.com/weather
   ```
2. In Gemini Spark, go to **Settings > Connected Apps > Add Custom Tool**.
3. Paste the URL and click **Connect**.
4. Gemini Spark will execute the OAuth 2.1 handshake with MCeption. Once connected, all tool calls route through MCeption with your credentials securely injected!

---

## Configuration Reference

Set these variables via environment variables or a `.env` file:

| Variable | Default | Description |
| :--- | :--- | :--- |
| `PORT` | `3000` | Port on which the HTTP server listens. |
| `MCEPTION_PUBLIC_URL` | `http://localhost:3000` | Public base URL used for OAuth discovery and issuer URLs. |
| `ADMIN_API_KEY` | `mception-dev-secret-key` | Secret key required to access the Web Dashboard and Admin REST API. |
| `MCEPTION_MASTER_KEY` | *(auto-generated)* | 32-byte master encryption key (64 hex or 44 base64 chars). In dev mode, saved to `/data/.dev_master_key`. |
| `BLOCK_PRIVATE_NETWORKS` | `false` | When `true`, blocks RFC 1918 private subnets and localhost (for cloud deployments). |
| `ALLOWED_REDIRECT_URIS` | *(none)* | Comma-separated list of allowed OAuth redirect URI prefixes. |
| `DATABASE_PATH` | `./data/mception.db` | Location of the persistent SQLite database file. |
| `LOG_LEVEL` | `info` | Logging verbosity (`fatal`, `error`, `warn`, `info`, `debug`, `trace`). |

---

## Architecture Diagram

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

---

## License

[Apache 2.0](LICENSE)
