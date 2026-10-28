import type { FastifyPluginAsync } from 'fastify';
import type { Kysely } from 'kysely';
import type { Config } from '../config.js';
import type { Database } from '../db/types.js';
import { createSafeFetch } from '../security/ssrf.js';
import { refreshUpstreamToken } from '../upstream/oauth.js';
import { applyCredentials, validateBearerToken } from './auth-helper.js';
import { globalSessionRegistry } from './sessions.js';

export interface MessageRoutesOptions {
  db: Kysely<Database>;
  config: Config;
  masterKey: Buffer;
}

export const messageRoutes: FastifyPluginAsync<MessageRoutesOptions> = async (
  fastify,
  opts
) => {
  const { db, config, masterKey } = opts;
  const safeFetch = createSafeFetch(config.BLOCK_PRIVATE_NETWORKS);

  fastify.post<{
    Params: { identifier: string };
    Querystring: { sessionId?: string };
    Body: any;
  }>('/:identifier/messages', async (request, reply) => {
    const { identifier } = request.params;
    const { sessionId } = request.query;

    const context = await validateBearerToken(
      request,
      reply,
      db,
      masterKey,
      identifier
    );
    if (!context) {
      return;
    }

    if (!sessionId) {
      return reply.status(400).send({
        error: 'Missing required sessionId query parameter',
      });
    }

    const sessionInfo = globalSessionRegistry.get(sessionId);
    if (!sessionInfo || sessionInfo.mcpId !== context.mcpId) {
      return reply.status(400).send({
        error: 'Invalid or expired sessionId. Please re-open the SSE connection.',
      });
    }

    const targetUrl = new URL(sessionInfo.upstreamMessageUrl);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    applyCredentials(headers, sessionInfo.credentials, targetUrl);

    let upstreamRes: Response;
    try {
      upstreamRes = await safeFetch(targetUrl.toString(), {
        method: 'POST',
        headers,
        body: JSON.stringify(request.body),
      });

      if (
        upstreamRes.status === 401 &&
        (sessionInfo.credentials.type === 'bearer' ||
          sessionInfo.credentials.type === 'upstream_oauth')
      ) {
        const newToken = await refreshUpstreamToken(
          sessionInfo.mcpId,
          sessionInfo.credentials,
          db,
          masterKey
        );
        if (newToken) {
          sessionInfo.credentials.token = newToken;
          applyCredentials(headers, sessionInfo.credentials, targetUrl);
          upstreamRes = await safeFetch(targetUrl.toString(), {
            method: 'POST',
            headers,
            body: JSON.stringify(request.body),
          });
        }
      }
    } catch (err) {
      return reply.status(502).send({
        error: `Failed to forward message to upstream MCP: ${(err as Error).message}`,
      });
    }

    if (upstreamRes.status === 401) {
      const body = request.body as any;
      return reply.status(200).send({
        jsonrpc: '2.0',
        error: {
          code: -32001,
          message:
            'Upstream authentication failed. Please update credentials in the MCeption dashboard.',
        },
        id: body?.id ?? null,
      });
    }

    if (!upstreamRes.ok) {
      return reply.status(upstreamRes.status).send({
        error: `Upstream message endpoint returned HTTP ${upstreamRes.status}`,
      });
    }

    // In MCP SSE protocol, POST /messages responds with 202 Accepted.
    // If upstream returns content, forward it; otherwise send 202.
    const text = await upstreamRes.text();
    if (text) {
      try {
        const json = JSON.parse(text);
        return reply.status(upstreamRes.status).send(json);
      } catch {
        return reply.status(upstreamRes.status).send(text);
      }
    }

    return reply.status(202).send({ status: 'accepted' });
  });
};
