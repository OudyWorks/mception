import crypto from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import type { Kysely } from 'kysely';
import type { Config } from '../config.js';
import { hashSecret, verifyPkce } from '../crypto/pkce.js';
import type { Database } from '../db/types.js';

export interface OAuthRoutesOptions {
  db: Kysely<Database>;
  config: Config;
}

export const oauthRoutes: FastifyPluginAsync<OAuthRoutesOptions> = async (
  fastify,
  opts
) => {
  const { db, config } = opts;

  // RFC / SEP-991 Client ID Metadata Document for Upstream OAuth Servers
  fastify.get('/oauth/client-metadata.json', async (request, reply) => {
    reply.header('content-type', 'application/json');
    return reply.send({
      client_id: `${config.MCEPTION_PUBLIC_URL}/oauth/client-metadata.json`,
      client_name: 'MCeption',
      client_uri: config.MCEPTION_PUBLIC_URL,
      redirect_uris: [
        `${config.MCEPTION_PUBLIC_URL}/api/oauth/upstream/callback`,
      ],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });
  });

  // RFC 9728 OAuth Protected Resource Metadata (scoped by identifier)
  fastify.get<{ Params: { identifier: string } }>(
    '/.well-known/oauth-protected-resource/:identifier',
    async (request, reply) => {
      const { identifier } = request.params;
      const mcp = await db
        .selectFrom('registered_mcps')
        .selectAll()
        .where('identifier', '=', identifier)
        .executeTakeFirst();

      if (!mcp) {
        return reply.status(404).send({ error: 'Endpoint not found' });
      }

      reply.header('content-type', 'application/json');
      return reply.send({
        resource: `${config.MCEPTION_PUBLIC_URL}/${identifier}`,
        authorization_servers: [`${config.MCEPTION_PUBLIC_URL}/${identifier}`],
        bearer_methods_supported: ['header'],
        scopes_supported: ['mcp'],
        resource_name: mcp.name,
      });
    }
  );

  // RFC 9728 alternative scoped path
  fastify.get<{ Params: { identifier: string } }>(
    '/:identifier/.well-known/oauth-protected-resource',
    async (request, reply) => {
      const { identifier } = request.params;
      const mcp = await db
        .selectFrom('registered_mcps')
        .selectAll()
        .where('identifier', '=', identifier)
        .executeTakeFirst();

      if (!mcp) {
        return reply.status(404).send({ error: 'Endpoint not found' });
      }

      reply.header('content-type', 'application/json');
      return reply.send({
        resource: `${config.MCEPTION_PUBLIC_URL}/${identifier}`,
        authorization_servers: [`${config.MCEPTION_PUBLIC_URL}/${identifier}`],
        bearer_methods_supported: ['header'],
        scopes_supported: ['mcp'],
        resource_name: mcp.name,
      });
    }
  );

  // RFC 9728 root fallback (for discovery tools checking host root)
  fastify.get('/.well-known/oauth-protected-resource', async (request, reply) => {
    const mcps = await db.selectFrom('registered_mcps').selectAll().execute();
    if (mcps.length === 0) {
      return reply.status(404).send({ error: 'No MCP endpoints registered' });
    }
    const mcp = mcps[0];
    reply.header('content-type', 'application/json');
    return reply.send({
      resource: `${config.MCEPTION_PUBLIC_URL}/${mcp.identifier}`,
      authorization_servers: [`${config.MCEPTION_PUBLIC_URL}/${mcp.identifier}`],
      bearer_methods_supported: ['header'],
      scopes_supported: ['mcp'],
      resource_name: mcp.name,
    });
  });

  // RFC 8414 OAuth 2.0 Authorization Server Metadata
  fastify.get<{ Params: { identifier: string } }>(
    '/:identifier/.well-known/oauth-authorization-server',
    async (request, reply) => {
      const { identifier } = request.params;
      const mcp = await db
        .selectFrom('registered_mcps')
        .select('id')
        .where('identifier', '=', identifier)
        .executeTakeFirst();

      if (!mcp) {
        return reply.status(404).send({ error: 'Endpoint not found' });
      }

      const base = `${config.MCEPTION_PUBLIC_URL}/${identifier}`;
      return reply.send({
        issuer: base,
        authorization_endpoint: `${base}/oauth/authorize`,
        token_endpoint: `${base}/oauth/token`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        scopes_supported: ['mcp'],
      });
    }
  );

  // RFC 6749 & OAuth 2.1 Authorization Endpoint
  fastify.get<{
    Params: { identifier: string };
    Querystring: {
      response_type?: string;
      client_id?: string;
      redirect_uri?: string;
      scope?: string;
      state?: string;
      code_challenge?: string;
      code_challenge_method?: string;
    };
  }>('/:identifier/oauth/authorize', async (request, reply) => {
    const { identifier } = request.params;
    const {
      response_type,
      redirect_uri,
      code_challenge,
      code_challenge_method,
      state,
    } = request.query;

    const mcp = await db
      .selectFrom('registered_mcps')
      .select(['id', 'identifier'])
      .where('identifier', '=', identifier)
      .executeTakeFirst();

    if (!mcp) {
      return reply.status(404).send({ error: 'Endpoint not found' });
    }

    if (response_type !== 'code') {
      return reply.status(400).send({
        error: 'unsupported_response_type',
        error_description: 'Only response_type=code is supported.',
      });
    }

    if (!redirect_uri) {
      return reply.status(400).send({
        error: 'invalid_request',
        error_description: 'Missing redirect_uri parameter.',
      });
    }

    if (!code_challenge || code_challenge_method !== 'S256') {
      return reply.status(400).send({
        error: 'invalid_request',
        error_description:
          'Mandatory PKCE parameters missing: code_challenge and code_challenge_method=S256 are required.',
      });
    }

    // Redirect URI validation if configured
    if (config.ALLOWED_REDIRECT_URIS) {
      const allowed = config.ALLOWED_REDIRECT_URIS.split(',').map((u) =>
        u.trim()
      );
      const isAllowed = allowed.some((allowedUri) =>
        redirect_uri.startsWith(allowedUri)
      );
      if (!isAllowed) {
        return reply.status(400).send({
          error: 'invalid_request',
          error_description: 'Redirect URI is not in the allowed list.',
        });
      }
    }

    const authCode = crypto.randomBytes(32).toString('base64url');
    const codeHash = hashSecret(authCode);
    const expiresAt = Date.now() + 60_000; // 60 seconds TTL

    await db
      .insertInto('auth_codes')
      .values({
        code_hash: codeHash,
        mcp_id: mcp.id,
        code_challenge,
        code_challenge_method,
        redirect_uri,
        expires_at: expiresAt,
        used_at: null,
      })
      .execute();

    const redirectTarget = new URL(redirect_uri);
    redirectTarget.searchParams.set('code', authCode);
    if (state) {
      redirectTarget.searchParams.set('state', state);
    }

    return reply.redirect(redirectTarget.toString(), 302);
  });

  // RFC 6749 & OAuth 2.1 Token Endpoint
  fastify.post<{
    Params: { identifier: string };
    Body: {
      grant_type?: string;
      code?: string;
      code_verifier?: string;
      redirect_uri?: string;
      refresh_token?: string;
    };
  }>('/:identifier/oauth/token', async (request, reply) => {
    const { identifier } = request.params;
    const body = (request.body || {}) as {
      grant_type?: string;
      code?: string;
      code_verifier?: string;
      redirect_uri?: string;
      refresh_token?: string;
    };

    const { grant_type, code, code_verifier, redirect_uri, refresh_token } =
      body;

    const mcp = await db
      .selectFrom('registered_mcps')
      .select('id')
      .where('identifier', '=', identifier)
      .executeTakeFirst();

    if (!mcp) {
      return reply.status(404).send({ error: 'Endpoint not found' });
    }

    const now = Date.now();

    if (grant_type === 'authorization_code') {
      if (!code || !code_verifier) {
        return reply.status(400).send({
          error: 'invalid_request',
          error_description: 'Missing code or code_verifier.',
        });
      }

      const codeHash = hashSecret(code);
      const authCodeRecord = await db
        .selectFrom('auth_codes')
        .selectAll()
        .where('code_hash', '=', codeHash)
        .where('mcp_id', '=', mcp.id)
        .executeTakeFirst();

      if (!authCodeRecord) {
        return reply.status(400).send({
          error: 'invalid_grant',
          error_description: 'Authorization code is invalid or unknown.',
        });
      }

      if (authCodeRecord.used_at !== null) {
        return reply.status(400).send({
          error: 'invalid_grant',
          error_description: 'Authorization code has already been used.',
        });
      }

      if (authCodeRecord.expires_at < now) {
        return reply.status(400).send({
          error: 'invalid_grant',
          error_description: 'Authorization code has expired.',
        });
      }

      if (redirect_uri && authCodeRecord.redirect_uri !== redirect_uri) {
        return reply.status(400).send({
          error: 'invalid_grant',
          error_description: 'redirect_uri does not match authorization code.',
        });
      }

      const pkceValid = verifyPkce(
        code_verifier,
        authCodeRecord.code_challenge,
        authCodeRecord.code_challenge_method
      );

      if (!pkceValid) {
        return reply.status(400).send({
          error: 'invalid_grant',
          error_description: 'PKCE code_verifier verification failed.',
        });
      }

      // Mark code as used
      await db
        .updateTable('auth_codes')
        .set({ used_at: now })
        .where('code_hash', '=', codeHash)
        .execute();

      // Issue access token (1 hour) & refresh token (30 days)
      const accessToken = crypto.randomBytes(32).toString('base64url');
      const refreshToken = crypto.randomBytes(32).toString('base64url');

      const accessTokenHash = hashSecret(accessToken);
      const refreshTokenHash = hashSecret(refreshToken);

      await db
        .insertInto('tokens')
        .values([
          {
            token_hash: accessTokenHash,
            token_type: 'access',
            mcp_id: mcp.id,
            expires_at: now + 3600_000,
            revoked_at: null,
          },
          {
            token_hash: refreshTokenHash,
            token_type: 'refresh',
            mcp_id: mcp.id,
            expires_at: now + 30 * 86400_000,
            revoked_at: null,
          },
        ])
        .execute();

      return reply.send({
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: refreshToken,
        scope: 'mcp',
      });
    }

    if (grant_type === 'refresh_token') {
      if (!refresh_token) {
        return reply.status(400).send({
          error: 'invalid_request',
          error_description: 'Missing refresh_token.',
        });
      }

      const refreshHash = hashSecret(refresh_token);
      const tokenRecord = await db
        .selectFrom('tokens')
        .selectAll()
        .where('token_hash', '=', refreshHash)
        .where('token_type', '=', 'refresh')
        .where('mcp_id', '=', mcp.id)
        .where('revoked_at', 'is', null)
        .executeTakeFirst();

      if (!tokenRecord || tokenRecord.expires_at < now) {
        return reply.status(400).send({
          error: 'invalid_grant',
          error_description: 'Refresh token is invalid or expired.',
        });
      }

      // Revoke existing refresh token (Refresh Token Rotation)
      await db
        .updateTable('tokens')
        .set({ revoked_at: now })
        .where('token_hash', '=', refreshHash)
        .execute();

      // Issue new token pair
      const newAccessToken = crypto.randomBytes(32).toString('base64url');
      const newRefreshToken = crypto.randomBytes(32).toString('base64url');

      await db
        .insertInto('tokens')
        .values([
          {
            token_hash: hashSecret(newAccessToken),
            token_type: 'access',
            mcp_id: mcp.id,
            expires_at: now + 3600_000,
            revoked_at: null,
          },
          {
            token_hash: hashSecret(newRefreshToken),
            token_type: 'refresh',
            mcp_id: mcp.id,
            expires_at: now + 30 * 86400_000,
            revoked_at: null,
          },
        ])
        .execute();

      return reply.send({
        access_token: newAccessToken,
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: newRefreshToken,
        scope: 'mcp',
      });
    }

    return reply.status(400).send({
      error: 'unsupported_grant_type',
      error_description: `Grant type "${grant_type}" is not supported. Supported: authorization_code, refresh_token.`,
    });
  });
};
