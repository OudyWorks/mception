import type BetterSqlite3 from 'better-sqlite3';

export function runMigrations(rawDb: BetterSqlite3.Database): void {
  const versionRow = rawDb.pragma('user_version', { simple: true }) as number;
  const currentVersion = Number(versionRow) || 0;

  if (currentVersion < 1) {
    const applyV1 = rawDb.transaction(() => {
      rawDb.exec(`
        CREATE TABLE IF NOT EXISTS registered_mcps (
            id TEXT PRIMARY KEY,
            identifier TEXT UNIQUE NOT NULL,
            name TEXT NOT NULL,
            upstream_url TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS credentials (
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

        CREATE TABLE IF NOT EXISTS auth_codes (
            code_hash TEXT PRIMARY KEY,
            mcp_id TEXT NOT NULL REFERENCES registered_mcps(id) ON DELETE CASCADE,
            code_challenge TEXT NOT NULL,
            code_challenge_method TEXT NOT NULL,
            redirect_uri TEXT NOT NULL,
            expires_at INTEGER NOT NULL,
            used_at INTEGER
        );

        CREATE TABLE IF NOT EXISTS tokens (
            token_hash TEXT PRIMARY KEY,
            token_type TEXT NOT NULL CHECK(token_type IN ('access', 'refresh')),
            mcp_id TEXT NOT NULL REFERENCES registered_mcps(id) ON DELETE CASCADE,
            expires_at INTEGER NOT NULL,
            revoked_at INTEGER
        );

        CREATE INDEX IF NOT EXISTS idx_registered_mcps_identifier ON registered_mcps(identifier);
        CREATE INDEX IF NOT EXISTS idx_tokens_token_hash ON tokens(token_hash);
        CREATE INDEX IF NOT EXISTS idx_tokens_mcp_id ON tokens(mcp_id);
        CREATE INDEX IF NOT EXISTS idx_auth_codes_code_hash ON auth_codes(code_hash);
      `);
      rawDb.pragma('user_version = 1');
    });

    applyV1();
  }
}
