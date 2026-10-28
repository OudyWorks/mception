import type { Kysely } from 'kysely';
import {
  encryptCredential,
  type CredentialPayload,
} from '../crypto/encryption.js';
import type { Database } from '../db/types.js';

export interface TokenExchangeResult {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
}

export async function exchangeUpstreamCode(params: {
  tokenEndpoint: string;
  code: string;
  redirectUri: string;
  clientId: string;
  codeVerifier: string;
}): Promise<TokenExchangeResult> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: params.redirectUri,
    client_id: params.clientId,
    code_verifier: params.codeVerifier,
  });

  const response = await fetch(params.tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      'User-Agent': 'MCeption/1.0',
    },
    body: body.toString(),
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Upstream token exchange failed with status ${response.status}: ${errorText}`
    );
  }

  const json = (await response.json()) as any;
  if (!json.access_token) {
    throw new Error('Upstream token exchange response missing access_token');
  }

  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_in: json.expires_in,
    token_type: json.token_type,
  };
}

export async function refreshUpstreamToken(
  mcpId: string,
  credentials: Extract<CredentialPayload, { type: 'bearer' | 'upstream_oauth' }>,
  db: Kysely<Database>,
  masterKey: Buffer
): Promise<string | null> {
  if (!credentials.refreshToken || !credentials.tokenEndpoint) {
    return null;
  }

  try {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: credentials.refreshToken,
      client_id: credentials.clientId || '',
    });

    const response = await fetch(credentials.tokenEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        'User-Agent': 'MCeption/1.0',
      },
      body: body.toString(),
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      return null;
    }

    const json = (await response.json()) as any;
    if (!json.access_token) {
      return null;
    }

    const updatedPayload: CredentialPayload = {
      type: credentials.type,
      token: json.access_token,
      refreshToken: json.refresh_token || credentials.refreshToken,
      tokenEndpoint: credentials.tokenEndpoint,
      clientId: credentials.clientId,
      expiresAt: json.expires_in
        ? Date.now() + json.expires_in * 1000
        : undefined,
    };

    const encrypted = encryptCredential(updatedPayload, masterKey);
    const now = Date.now();

    await db
      .updateTable('credentials')
      .set({
        encrypted_payload: encrypted.ciphertext,
        iv: encrypted.iv,
        tag: encrypted.tag,
        updated_at: now,
      })
      .where('mcp_id', '=', mcpId)
      .execute();

    return json.access_token;
  } catch {
    return null;
  }
}
