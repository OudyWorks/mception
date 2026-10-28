import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import type { Config } from '../config.js';
import {
  decryptCredential,
  type CredentialPayload,
} from '../crypto/encryption.js';
import { hashSecret } from '../crypto/pkce.js';
import type { Database } from '../db/types.js';

export interface ValidatedMcpContext {
  mcpId: string;
  identifier: string;
  upstreamUrl: string;
  credentials: CredentialPayload;
}

export async function validateBearerToken(
  request: FastifyRequest,
  reply: FastifyReply,
  db: Kysely<Database>,
  masterKey: Buffer,
  expectedIdentifier: string,
  config: Config
): Promise<ValidatedMcpContext | null> {
  const resourceMetadataUrl = `${config.MCEPTION_PUBLIC_URL}/.well-known/oauth-protected-resource/${expectedIdentifier}`;
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    reply.header(
      'www-authenticate',
      `Bearer error="invalid_token", error_description="The access token is missing or invalid", resource_metadata="${resourceMetadataUrl}"`
    );
    reply.status(401).send({ error: 'Missing or invalid Authorization header' });
    return null;
  }

  const token = authHeader.substring(7).trim();
  const tokenHash = hashSecret(token);
  const now = Date.now();

  const tokenRecord = await db
    .selectFrom('tokens')
    .selectAll()
    .where('token_hash', '=', tokenHash)
    .where('token_type', '=', 'access')
    .where('revoked_at', 'is', null)
    .where('expires_at', '>', now)
    .executeTakeFirst();

  if (!tokenRecord) {
    reply.header(
      'www-authenticate',
      `Bearer error="invalid_token", error_description="Invalid or expired access token", resource_metadata="${resourceMetadataUrl}"`
    );
    reply.status(401).send({ error: 'Invalid or expired access token' });
    return null;
  }

  const mcp = await db
    .selectFrom('registered_mcps')
    .selectAll()
    .where('id', '=', tokenRecord.mcp_id)
    .executeTakeFirst();

  if (!mcp || mcp.identifier !== expectedIdentifier) {
    reply.status(403).send({ error: 'Token is not authorized for this endpoint' });
    return null;
  }

  const credRecord = await db
    .selectFrom('credentials')
    .selectAll()
    .where('mcp_id', '=', mcp.id)
    .executeTakeFirst();

  let credentials: CredentialPayload = { type: 'none' };
  if (credRecord) {
    credentials = decryptCredential(
      credRecord.encrypted_payload,
      credRecord.iv,
      credRecord.tag,
      masterKey
    );
  }

  return {
    mcpId: mcp.id,
    identifier: mcp.identifier,
    upstreamUrl: mcp.upstream_url,
    credentials,
  };
}

export function applyCredentials(
  headers: Record<string, string>,
  credentials: CredentialPayload,
  targetUrl: URL
): void {
  switch (credentials.type) {
    case 'bearer':
    case 'upstream_oauth':
      headers['authorization'] = `Bearer ${credentials.token}`;
      break;
    case 'api_key_header':
      headers[credentials.headerName.toLowerCase()] = credentials.apiKey;
      break;
    case 'api_key_query':
      targetUrl.searchParams.set(credentials.paramName, credentials.apiKey);
      break;
    case 'basic': {
      const encoded = Buffer.from(
        `${credentials.username}:${credentials.password}`,
        'utf8'
      ).toString('base64');
      headers['authorization'] = `Basic ${encoded}`;
      break;
    }
    case 'custom_headers':
      for (const [k, v] of Object.entries(credentials.headers)) {
        headers[k.toLowerCase()] = v;
      }
      break;
    case 'none':
    default:
      break;
  }
}
