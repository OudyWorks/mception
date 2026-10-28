import Fastify, { type FastifyInstance } from 'fastify';

export interface MockUpstreamInstance {
  server: FastifyInstance;
  url: string;
  receivedHeaders: Record<string, string | string[] | undefined>[];
  receivedMessages: any[];
  emitSseMessage: (data: string) => void;
  close: () => Promise<void>;
}

export async function createMockUpstreamServer(): Promise<MockUpstreamInstance> {
  const server = Fastify({ logger: false });

  const receivedHeaders: Record<string, string | string[] | undefined>[] = [];
  const receivedMessages: any[] = [];
  let sseConnection: any = null;

  server.get('/sse', async (request, reply) => {
    receivedHeaders.push(request.headers);

    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.flushHeaders();

    sseConnection = reply.raw;

    // Emit initial endpoint event per MCP SSE standard
    reply.raw.write(
      'event: endpoint\ndata: /messages?sessionId=mock-upstream-session-123\n\n'
    );

    request.raw.on('close', () => {
      sseConnection = null;
    });
  });

  server.post('/messages', async (request, reply) => {
    receivedHeaders.push(request.headers);
    receivedMessages.push(request.body);

    const authHeader = request.headers.authorization;
    const apiKeyHeader = request.headers['x-api-key'];

    // If an invalid auth header is passed, return 401
    if (authHeader === 'Bearer invalid_upstream_token') {
      return reply.status(401).send({ error: 'Unauthorized upstream' });
    }

    // In MCP SSE, return 202 and emit result on the SSE stream
    if (sseConnection && !sseConnection.writableEnded) {
      sseConnection.write(
        `event: message\ndata: ${JSON.stringify({
          jsonrpc: '2.0',
          result: { content: [{ type: 'text', text: 'Mock tool response' }] },
          id: (request.body as any)?.id,
        })}\n\n`
      );
    }

    return reply.status(202).send({ status: 'accepted' });
  });

  await server.listen({ port: 0, host: '127.0.0.1' });
  const address = server.server.address() as any;
  const url = `http://127.0.0.1:${address.port}/sse`;

  return {
    server,
    url,
    receivedHeaders,
    receivedMessages,
    emitSseMessage: (data: string) => {
      if (sseConnection && !sseConnection.writableEnded) {
        sseConnection.write(`event: message\ndata: ${data}\n\n`);
      }
    },
    close: async () => {
      if (sseConnection && !sseConnection.writableEnded) {
        sseConnection.end();
      }
      await server.close();
    },
  };
}
