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
import type { Database } from '../db/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface WebRoutesOptions {
  db: Kysely<Database>;
  config: Config;
  masterKey: Buffer;
}

const credentialPayloadSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({ type: z.literal('bearer'), token: z.string().min(1) }),
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
};
