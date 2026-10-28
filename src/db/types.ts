import type { Generated } from 'kysely';

export interface RegisteredMcpTable {
  id: string;
  identifier: string;
  name: string;
  upstream_url: string;
  created_at: number;
  updated_at: number;
}

export type AuthType =
  | 'none'
  | 'bearer'
  | 'api_key_header'
  | 'api_key_query'
  | 'basic'
  | 'custom_headers';

export interface CredentialTable {
  id: string;
  mcp_id: string;
  auth_type: AuthType;
  encrypted_payload: Buffer;
  iv: Buffer;
  tag: Buffer;
  key_version: Generated<number>;
  created_at: number;
  updated_at: number;
}

export interface AuthCodeTable {
  code_hash: string;
  mcp_id: string;
  code_challenge: string;
  code_challenge_method: string;
  redirect_uri: string;
  expires_at: number;
  used_at: number | null;
}

export interface TokenTable {
  token_hash: string;
  token_type: 'access' | 'refresh';
  mcp_id: string;
  expires_at: number;
  revoked_at: number | null;
}

export interface Database {
  registered_mcps: RegisteredMcpTable;
  credentials: CredentialTable;
  auth_codes: AuthCodeTable;
  tokens: TokenTable;
}
