import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { probeUpstream } from '../../src/upstream/probe.js';

describe('probeUpstream unit tests', () => {
  let server: FastifyInstance;
  let baseUrl: string;

  beforeEach(async () => {
    server = Fastify({ logger: false });
  });

  afterEach(async () => {
    await server.close();
  });

  it('detects unauthenticated public endpoint (HTTP 200)', async () => {
    server.get('/public', async () => ({ status: 'ok' }));
    await server.listen({ port: 0, host: '127.0.0.1' });
    const addr = server.server.address() as any;
    baseUrl = `http://127.0.0.1:${addr.port}`;

    const res = await probeUpstream(`${baseUrl}/public`, false);
    expect(res.auth_required).toBe(false);
    expect(res.auth_type).toBe('none');
  });

  it('detects Bearer token requirement from WWW-Authenticate header', async () => {
    server.get('/bearer-only', async (request, reply) => {
      reply.header('www-authenticate', 'Bearer realm="api"');
      return reply.status(401).send({ error: 'unauthorized' });
    });
    await server.listen({ port: 0, host: '127.0.0.1' });
    const addr = server.server.address() as any;
    baseUrl = `http://127.0.0.1:${addr.port}`;

    const res = await probeUpstream(`${baseUrl}/bearer-only`, false);
    expect(res.auth_required).toBe(true);
    expect(res.auth_type).toBe('bearer');
  });

  it('detects HTTP Basic auth requirement from WWW-Authenticate header', async () => {
    server.get('/basic-only', async (request, reply) => {
      reply.header('www-authenticate', 'Basic realm="secure"');
      return reply.status(401).send({ error: 'unauthorized' });
    });
    await server.listen({ port: 0, host: '127.0.0.1' });
    const addr = server.server.address() as any;
    baseUrl = `http://127.0.0.1:${addr.port}`;

    const res = await probeUpstream(`${baseUrl}/basic-only`, false);
    expect(res.auth_required).toBe(true);
    expect(res.auth_type).toBe('basic');
  });
});
