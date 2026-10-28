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

  const handleMessages = async (request: any, reply: any) => {
    const { identifier } = request.params;
    const { sessionId } = request.query || {};

    const context = await validateBearerToken(
      request,
      reply,
      db,
      masterKey,
      identifier,
      config
    );
    if (!context) {
      return;
    }

    const effectiveSessionId =
      sessionId || (request.headers['mcp-session-id'] as string | undefined);

    let targetUrl: URL;
    let activeCredentials = context.credentials;
    let targetMcpId = context.mcpId;

    if (effectiveSessionId) {
      const sessionInfo = globalSessionRegistry.get(effectiveSessionId);
      if (!sessionInfo || sessionInfo.mcpId !== context.mcpId) {
        return reply.status(400).send({
          error: 'Invalid or expired sessionId. Please re-open the SSE connection.',
        });
      }
      targetUrl = new URL(sessionInfo.upstreamMessageUrl);
      activeCredentials = sessionInfo.credentials;
    } else {
      targetUrl = new URL(context.upstreamUrl);
    }

    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    applyCredentials(headers, activeCredentials, targetUrl);

    let upstreamRes: Response;
    try {
      upstreamRes = await safeFetch(targetUrl.toString(), {
        method: 'POST',
        headers,
        body: JSON.stringify(request.body),
      });

      if (
        upstreamRes.status === 401 &&
        (activeCredentials.type === 'bearer' ||
          activeCredentials.type === 'upstream_oauth')
      ) {
        const newToken = await refreshUpstreamToken(
          targetMcpId,
          activeCredentials,
          db,
          masterKey
        );
        if (newToken) {
          activeCredentials.token = newToken;
          applyCredentials(headers, activeCredentials, targetUrl);
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
  };

  fastify.post<{
    Params: { identifier: string };
    Querystring: { sessionId?: string };
    Body: any;
  }>('/:identifier/messages', handleMessages);

  fastify.post<{
    Params: { identifier: string };
    Querystring: { sessionId?: string };
    Body: any;
  }>('/:identifier', handleMessages);
};
