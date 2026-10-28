import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { Config } from '../config.js';
import {
  encryptCredential,
  type CredentialPayload,
} from '../crypto/encryption.js';
import { createPkcePair } from '../crypto/pkce.js';
import type { Database } from '../db/types.js';
import { exchangeUpstreamCode } from '../upstream/oauth.js';
import { probeUpstream } from '../upstream/probe.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface WebRoutesOptions {
  db: Kysely<Database>;
  config: Config;
  masterKey: Buffer;
}

const credentialPayloadSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({
    type: z.literal('bearer'),
    token: z.string().min(1),
    refreshToken: z.string().optional(),
    tokenEndpoint: z.string().optional(),
    clientId: z.string().optional(),
    expiresAt: z.number().optional(),
  }),
  z.object({
    type: z.literal('upstream_oauth'),
    token: z.string().min(1),
    refreshToken: z.string().optional(),
    tokenEndpoint: z.string().optional(),
    clientId: z.string().optional(),
    expiresAt: z.number().optional(),
  }),
  z.object({
    type: z.literal('api_key_header'),
    headerName: z.string().min(1),
    apiKey: z.string().min(1),
  }),
  z.object({
    type: z.literal('api_key_query'),
    paramName: z.string().min(1),
    apiKey: z.string().min(1),
  }),
  z.object({
    type: z.literal('basic'),
    username: z.string().min(1),
    password: z.string().min(1),
  }),
  z.object({
    type: z.literal('custom_headers'),
    headers: z.record(z.string()),
  }),
]);

const createMcpSchema = z.object({
  identifier: z
    .string()
    .min(1)
    .max(64)
    .regex(
      /^[a-z0-9_-]+$/,
      'Identifier must contain only lowercase letters, numbers, hyphens, and underscores'
    ),
  name: z.string().min(1).max(128),
  upstream_url: z.string().url(),
  credentials: credentialPayloadSchema.default({ type: 'none' }),
});

export const webRoutes: FastifyPluginAsync<WebRoutesOptions> = async (
  fastify,
  opts
) => {
  const { db, config, masterKey } = opts;

  // Serve static UI assets from src/web/public
  const publicDir = path.join(__dirname, 'public');
  await fastify.register(fastifyStatic, {
    root: publicDir,
    prefix: '/',
    decorateReply: false,
  });

  // Healthcheck endpoint
  fastify.get('/healthz', async () => {
    return { status: 'ok', timestamp: Date.now() };
  });

  // Admin Authentication Middleware
  const authenticateAdmin = (
    request: FastifyRequest,
    reply: FastifyReply
  ): boolean => {
    const authHeader = request.headers.authorization;
    let token: string | undefined;

    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7).trim();
    } else if ((request.query as any)?.admin_key) {
      token = (request.query as any).admin_key;
    }

    if (!token || token !== config.ADMIN_API_KEY) {
      reply
        .status(401)
        .send({ error: 'Unauthorized: Invalid or missing ADMIN_API_KEY' });
      return false;
    }
    return true;
  };

  // List all registered MCP endpoints
  fastify.get('/api/mcps', async (request, reply) => {
    if (!authenticateAdmin(request, reply)) return;

    const mcps = await db
      .selectFrom('registered_mcps')
      .leftJoin('credentials', 'credentials.mcp_id', 'registered_mcps.id')
      .select([
        'registered_mcps.id',
        'registered_mcps.identifier',
        'registered_mcps.name',
        'registered_mcps.upstream_url',
        'registered_mcps.created_at',
        'registered_mcps.updated_at',
        'credentials.auth_type',
      ])
      .orderBy('registered_mcps.created_at', 'desc')
      .execute();

    const formatted = mcps.map((mcp) => ({
      ...mcp,
      auth_type: mcp.auth_type || 'none',
      connected_app_url: `${config.MCEPTION_PUBLIC_URL}/${mcp.identifier}`,
      discovery_url: `${config.MCEPTION_PUBLIC_URL}/${mcp.identifier}/.well-known/oauth-authorization-server`,
    }));

    return reply.send({ mcps: formatted });
  });

  // Create new MCP endpoint
  fastify.post('/api/mcps', async (request, reply) => {
    if (!authenticateAdmin(request, reply)) return;

    const parseResult = createMcpSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: 'Validation failed',
        details: parseResult.error.issues,
      });
    }

    const { identifier, name, upstream_url, credentials } = parseResult.data;

    // Check identifier uniqueness
    const existing = await db
      .selectFrom('registered_mcps')
      .select('id')
      .where('identifier', '=', identifier)
      .executeTakeFirst();

    if (existing) {
      return reply.status(409).send({
        error: `Endpoint identifier "${identifier}" is already registered.`,
      });
    }

    const now = Date.now();
    const mcpId = crypto.randomUUID();

    const encrypted = encryptCredential(credentials, masterKey);

    await db
      .insertInto('registered_mcps')
      .values({
        id: mcpId,
        identifier,
        name,
        upstream_url,
        created_at: now,
        updated_at: now,
      })
      .execute();

    await db
      .insertInto('credentials')
      .values({
        id: crypto.randomUUID(),
        mcp_id: mcpId,
        auth_type: credentials.type,
        encrypted_payload: encrypted.ciphertext,
        iv: encrypted.iv,
        tag: encrypted.tag,
        key_version: 1,
        created_at: now,
        updated_at: now,
      })
      .execute();

    return reply.status(201).send({
      id: mcpId,
      identifier,
      name,
      upstream_url,
      auth_type: credentials.type,
      connected_app_url: `${config.MCEPTION_PUBLIC_URL}/${identifier}`,
      discovery_url: `${config.MCEPTION_PUBLIC_URL}/${identifier}/.well-known/oauth-authorization-server`,
    });
  });

  // Delete MCP endpoint
  fastify.delete<{ Params: { identifier: string } }>(
    '/api/mcps/:identifier',
    async (request, reply) => {
      if (!authenticateAdmin(request, reply)) return;

      const { identifier } = request.params;
      const mcp = await db
        .selectFrom('registered_mcps')
        .select('id')
        .where('identifier', '=', identifier)
        .executeTakeFirst();

      if (!mcp) {
        return reply.status(404).send({ error: 'Endpoint not found' });
      }

      await db
        .deleteFrom('registered_mcps')
        .where('id', '=', mcp.id)
        .execute();

      return reply.send({ success: true, message: `Endpoint "${identifier}" deleted.` });
    }
  );

  // Probe Upstream MCP Server for Supported Authentication
  fastify.post('/api/mcps/probe', async (request, reply) => {
    if (!authenticateAdmin(request, reply)) return;

    const bodySchema = z.object({
      upstream_url: z.string().url(),
    });

    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'Validation failed',
        details: parsed.error.issues,
      });
    }

    try {
      const probeResult = await probeUpstream(
        parsed.data.upstream_url,
        config.BLOCK_PRIVATE_NETWORKS
      );
      return reply.send(probeResult);
    } catch (err: any) {
      return reply.status(400).send({
        error: `Failed to probe upstream server: ${err.message}`,
      });
    }
  });

  // Initiate Upstream OAuth 2.1 Flow
  fastify.get<{
    Querystring: {
      upstream_url?: string;
      identifier?: string;
      name?: string;
      admin_key?: string;
    };
  }>('/api/oauth/upstream/start', async (request, reply) => {
    if (!authenticateAdmin(request, reply)) return;

    const { upstream_url, identifier, name } = request.query;
    if (!upstream_url || !identifier || !name) {
      return reply.status(400).send({
        error: 'Missing required query parameters: upstream_url, identifier, name',
      });
    }

    let probeResult;
    try {
      probeResult = await probeUpstream(
        upstream_url,
        config.BLOCK_PRIVATE_NETWORKS
      );
    } catch (err: any) {
      return reply.status(400).send({
        error: `Could not probe upstream server: ${err.message}`,
      });
    }

    if (
      probeResult.auth_type !== 'upstream_oauth' ||
      !probeResult.authorization_endpoint ||
      !probeResult.token_endpoint
    ) {
      return reply.status(400).send({
        error: 'Upstream server does not support OAuth 2.1 authorization.',
      });
    }

    const state = crypto.randomBytes(24).toString('hex');
    const { verifier: codeVerifier, challenge: codeChallenge } =
      createPkcePair();
    const callbackUrl = `${config.MCEPTION_PUBLIC_URL}/api/oauth/upstream/callback`;
    const clientId = `${config.MCEPTION_PUBLIC_URL}/oauth/client-metadata.json`;

    const now = Date.now();
    const expiresAt = now + 10 * 60 * 1000; // 10 minutes

    await db
      .insertInto('upstream_oauth_states')
      .values({
        state,
        mcp_identifier: identifier,
        mcp_name: name,
        upstream_url,
        token_endpoint: probeResult.token_endpoint,
        client_id: clientId,
        code_verifier: codeVerifier,
        created_at: now,
        expires_at: expiresAt,
      })
      .execute();

    const authUrl = new URL(probeResult.authorization_endpoint);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('redirect_uri', callbackUrl);
    authUrl.searchParams.set('code_challenge', codeChallenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('resource', upstream_url);

    return reply.redirect(authUrl.toString(), 302);
  });

  // Upstream OAuth 2.1 Callback
  fastify.get<{
    Querystring: {
      code?: string;
      state?: string;
      error?: string;
      error_description?: string;
    };
  }>('/api/oauth/upstream/callback', async (request, reply) => {
    const { code, state, error, error_description } = request.query;

    if (error) {
      const msg = error_description || error;
      return reply.redirect(`/?error=${encodeURIComponent(`Upstream OAuth failed: ${msg}`)}`, 302);
    }

    if (!code || !state) {
      return reply.redirect(
        `/?error=${encodeURIComponent('Missing code or state in OAuth callback')}`,
        302
      );
    }

    const pending = await db
      .selectFrom('upstream_oauth_states')
      .selectAll()
      .where('state', '=', state)
      .where('expires_at', '>', Date.now())
      .executeTakeFirst();

    if (!pending) {
      return reply.redirect(
        `/?error=${encodeURIComponent('OAuth session expired or invalid. Please try again.')}`,
        302
      );
    }

    let tokenResult;
    try {
      tokenResult = await exchangeUpstreamCode({
        tokenEndpoint: pending.token_endpoint,
        code,
        redirectUri: `${config.MCEPTION_PUBLIC_URL}/api/oauth/upstream/callback`,
        clientId: pending.client_id,
        codeVerifier: pending.code_verifier,
      });
    } catch (err: any) {
      return reply.redirect(
        `/?error=${encodeURIComponent(`Token exchange failed: ${err.message}`)}`,
        302
      );
    }

    const now = Date.now();

    // Check if MCP endpoint already exists
    const existingMcp = await db
      .selectFrom('registered_mcps')
      .select('id')
      .where('identifier', '=', pending.mcp_identifier)
      .executeTakeFirst();

    let mcpId: string;
    if (existingMcp) {
      mcpId = existingMcp.id;
      await db
        .updateTable('registered_mcps')
        .set({
          name: pending.mcp_name,
          upstream_url: pending.upstream_url,
          updated_at: now,
        })
        .where('id', '=', mcpId)
        .execute();
    } else {
      mcpId = crypto.randomUUID();
      await db
        .insertInto('registered_mcps')
        .values({
          id: mcpId,
          identifier: pending.mcp_identifier,
          name: pending.mcp_name,
          upstream_url: pending.upstream_url,
          created_at: now,
          updated_at: now,
        })
        .execute();
    }

    const credPayload: CredentialPayload = {
      type: 'upstream_oauth',
      token: tokenResult.access_token,
      refreshToken: tokenResult.refresh_token,
      tokenEndpoint: pending.token_endpoint,
      clientId: pending.client_id,
      expiresAt: tokenResult.expires_in
        ? now + tokenResult.expires_in * 1000
        : undefined,
    };

    const encrypted = encryptCredential(credPayload, masterKey);

    const existingCred = await db
      .selectFrom('credentials')
      .select('id')
      .where('mcp_id', '=', mcpId)
      .executeTakeFirst();

    if (existingCred) {
      await db
        .updateTable('credentials')
        .set({
          auth_type: 'upstream_oauth',
          encrypted_payload: encrypted.ciphertext,
          iv: encrypted.iv,
          tag: encrypted.tag,
          updated_at: now,
        })
        .where('mcp_id', '=', mcpId)
        .execute();
    } else {
      await db
        .insertInto('credentials')
        .values({
          id: crypto.randomUUID(),
          mcp_id: mcpId,
          auth_type: 'upstream_oauth',
          encrypted_payload: encrypted.ciphertext,
          iv: encrypted.iv,
          tag: encrypted.tag,
          key_version: 1,
          created_at: now,
          updated_at: now,
        })
        .execute();
    }

    // Clean up state
    await db
      .deleteFrom('upstream_oauth_states')
      .where('state', '=', state)
      .execute();

    return reply.redirect(
      `/?success=${encodeURIComponent(`Successfully connected and authenticated "${pending.mcp_name}"!`)}`,
      302
    );
  });
};
