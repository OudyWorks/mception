import crypto from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import type { Kysely } from 'kysely';
import type { Config } from '../config.js';
import type { Database } from '../db/types.js';
import { createSafeFetch } from '../security/ssrf.js';
import { applyCredentials, validateBearerToken } from './auth-helper.js';
import { globalSessionRegistry } from './sessions.js';

export interface ProxyRoutesOptions {
  db: Kysely<Database>;
  config: Config;
  masterKey: Buffer;
}

export const proxyRoutes: FastifyPluginAsync<ProxyRoutesOptions> = async (
  fastify,
  opts
) => {
  const { db, config, masterKey } = opts;
  const safeFetch = createSafeFetch(config.BLOCK_PRIVATE_NETWORKS);

  fastify.get<{ Params: { identifier: string } }>(
    '/:identifier/sse',
    async (request, reply) => {
      const { identifier } = request.params;
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

      const upstreamUrl = new URL(context.upstreamUrl);
      const upstreamHeaders: Record<string, string> = {
        Accept: 'text/event-stream',
      };
      applyCredentials(upstreamHeaders, context.credentials, upstreamUrl);

      const abortController = new AbortController();
      let upstreamRes: Response;
      try {
        upstreamRes = await safeFetch(upstreamUrl.toString(), {
          method: 'GET',
          headers: upstreamHeaders,
          signal: abortController.signal,
        });
      } catch (err) {
        return reply.status(502).send({
          error: `Failed to connect to upstream SSE: ${(err as Error).message}`,
        });
      }

      if (!upstreamRes.ok) {
        return reply.status(upstreamRes.status).send({
          error: `Upstream SSE returned HTTP ${upstreamRes.status}`,
        });
      }

      const clientRes = reply.raw;
      clientRes.setHeader('Content-Type', 'text/event-stream');
      clientRes.setHeader('Cache-Control', 'no-cache');
      clientRes.setHeader('Connection', 'keep-alive');
      clientRes.flushHeaders();

      // 15-second heartbeat ping
      const pingInterval = setInterval(() => {
        if (!clientRes.writableEnded) {
          clientRes.write(': ping\n\n');
        }
      }, 15_000);

      request.raw.on('close', () => {
        clearInterval(pingInterval);
        abortController.abort();
      });

      if (!upstreamRes.body) {
        clearInterval(pingInterval);
        clientRes.end();
        return;
      }

      const reader = upstreamRes.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const messages = buffer.split('\n\n');
          buffer = messages.pop() || '';

          for (const message of messages) {
            if (!message.trim()) continue;

            const lines = message.split('\n');
            let eventName = '';
            let dataLines: string[] = [];

            for (const line of lines) {
              if (line.startsWith('event:')) {
                eventName = line.substring(6).trim();
              } else if (line.startsWith('data:')) {
                dataLines.push(line.substring(5).trim());
              }
            }

            // Rewriting MCP 'endpoint' event
            if (eventName === 'endpoint') {
              const rawData = dataLines.join('\n');
              const resolvedUpstreamUrl = new URL(rawData, upstreamUrl).toString();

              const proxySessionId = crypto.randomUUID();
              globalSessionRegistry.set(proxySessionId, {
                upstreamMessageUrl: resolvedUpstreamUrl,
                mcpId: context.mcpId,
                credentials: context.credentials,
                createdAt: Date.now(),
              });

              const rewrittenData = `/${identifier}/messages?sessionId=${proxySessionId}`;
              clientRes.write(`event: endpoint\ndata: ${rewrittenData}\n\n`);
            } else {
              // Pipe all other events directly
              clientRes.write(`${message}\n\n`);
            }
          }
        }
      } catch (err) {
        if (!abortController.signal.aborted) {
          // Upstream unexpectedly closed
        }
      } finally {
        clearInterval(pingInterval);
        if (!clientRes.writableEnded) {
          clientRes.end();
        }
      }
    }
  );
};
