import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestAppInstance } from '../helpers/test-app.js';

describe('Upstream OAuth Discovery & Client Flow Integration Tests', () => {
  let appInstance: TestAppInstance;
  let mockServer: FastifyInstance;
  let mockBaseUrl: string;
  let customMessagesHandler:
    | ((request: any, reply: any) => Promise<any>)
    | null = null;

  beforeEach(async () => {
    customMessagesHandler = null;
    appInstance = await createTestApp({
      ADMIN_API_KEY: 'test-admin-secret-key',
      BLOCK_PRIVATE_NETWORKS: false,
    });

    mockServer = Fastify({ logger: false });

    // Enable application/x-www-form-urlencoded parser on mock server
    mockServer.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      (req, body, done) => {
        try {
          const params = new URLSearchParams(body as string);
          const parsed: Record<string, string> = {};
          for (const [k, v] of params.entries()) {
            parsed[k] = v;
          }
          done(null, parsed);
        } catch (err: any) {
          done(err, undefined);
        }
      }
    );

    // Mock Upstream Protected Resource (RFC 9728)
    mockServer.get('/mcp', async (request, reply) => {
      reply.header(
        'www-authenticate',
        `Bearer error="invalid_token", resource_metadata="${mockBaseUrl}/.well-known/oauth-protected-resource/mcp"`
      );
      return reply.status(401).send({ error: 'Unauthorized' });
    });

    mockServer.get('/.well-known/oauth-protected-resource/mcp', async () => {
      return {
        resource: `${mockBaseUrl}/mcp`,
        authorization_servers: [mockBaseUrl],
        bearer_methods_supported: ['header'],
        resource_name: 'Mock Provider MCP',
      };
    });

    // Mock Upstream Authorization Server Metadata (RFC 8414)
    mockServer.get('/.well-known/oauth-authorization-server', async () => {
      return {
        issuer: mockBaseUrl,
        authorization_endpoint: `${mockBaseUrl}/oauth/authorize`,
        token_endpoint: `${mockBaseUrl}/oauth/token`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['none'],
        code_challenge_methods_supported: ['S256'],
        client_id_metadata_document_supported: true,
      };
    });

    // Mock Upstream Token Endpoint
    mockServer.post('/oauth/token', async (request, reply) => {
      const body = request.body as any;
      if (body.grant_type === 'authorization_code') {
        if (body.code === 'valid_mock_code') {
          return reply.send({
            access_token: 'upstream_access_token_abc123',
            refresh_token: 'upstream_refresh_token_xyz789',
            expires_in: 3600,
            token_type: 'Bearer',
          });
        }
        return reply.status(400).send({ error: 'invalid_grant' });
      }

      if (body.grant_type === 'refresh_token') {
        if (body.refresh_token === 'upstream_refresh_token_xyz789') {
          return reply.send({
            access_token: 'refreshed_upstream_access_token_new456',
            refresh_token: 'upstream_refresh_token_xyz789',
            expires_in: 3600,
            token_type: 'Bearer',
          });
        }
        return reply.status(400).send({ error: 'invalid_grant' });
      }

      return reply.status(400).send({ error: 'unsupported_grant_type' });
    });

    mockServer.post('/messages', async (request, reply) => {
      if (customMessagesHandler) {
        return customMessagesHandler(request, reply);
      }
      return reply.status(202).send({ status: 'accepted' });
    });

    await mockServer.listen({ port: 0, host: '127.0.0.1' });
    const addr = mockServer.server.address() as any;
    mockBaseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await mockServer.close();
    await appInstance.cleanup();
  });

  it('serves Client ID Metadata Document at GET /oauth/client-metadata.json', async () => {
    const res = await appInstance.app.inject({
      method: 'GET',
      url: '/oauth/client-metadata.json',
    });

    expect(res.statusCode).toBe(200);
    const doc = res.json();
    expect(doc.client_id).toBe(
      'http://localhost:3000/oauth/client-metadata.json'
    );
    expect(doc.client_name).toBe('MCeption');
    expect(doc.redirect_uris).toContain(
      'http://localhost:3000/api/oauth/upstream/callback'
    );
    expect(doc.grant_types).toContain('authorization_code');
    expect(doc.grant_types).toContain('refresh_token');
    expect(doc.token_endpoint_auth_method).toBe('none');
  });

  it('probes upstream server and discovers RFC 9728 / OAuth 2.1 metadata', async () => {
    const res = await appInstance.app.inject({
      method: 'POST',
      url: '/api/mcps/probe',
      headers: {
        authorization: 'Bearer test-admin-secret-key',
      },
      payload: {
        upstream_url: `${mockBaseUrl}/mcp`,
      },
    });

    expect(res.statusCode).toBe(200);
    const probe = res.json();
    expect(probe.auth_required).toBe(true);
    expect(probe.auth_type).toBe('upstream_oauth');
    expect(probe.provider_name).toBe('Mock Provider MCP');
    expect(probe.authorization_endpoint).toBe(`${mockBaseUrl}/oauth/authorize`);
    expect(probe.token_endpoint).toBe(`${mockBaseUrl}/oauth/token`);
    expect(probe.client_id_metadata_document_supported).toBe(true);
  });

  it('executes full interactive upstream OAuth flow (start -> authorize redirect -> callback -> token storage)', async () => {
    // 1. Call /api/oauth/upstream/start
    const startRes = await appInstance.app.inject({
      method: 'GET',
      url: `/api/oauth/upstream/start?upstream_url=${encodeURIComponent(
        `${mockBaseUrl}/mcp`
      )}&identifier=mock-oauth-mcp&name=Mock%20OAuth%20MCP`,
      headers: {
        authorization: 'Bearer test-admin-secret-key',
      },
    });

    expect(startRes.statusCode).toBe(302);
    const redirectUrlStr = startRes.headers.location;
    expect(redirectUrlStr).toBeDefined();

    const redirectUrl = new URL(redirectUrlStr!);
    expect(redirectUrl.origin + redirectUrl.pathname).toBe(
      `${mockBaseUrl}/oauth/authorize`
    );
    expect(redirectUrl.searchParams.get('client_id')).toBe(
      'http://localhost:3000/oauth/client-metadata.json'
    );
    expect(redirectUrl.searchParams.get('response_type')).toBe('code');
    expect(redirectUrl.searchParams.get('code_challenge_method')).toBe('S256');

    const state = redirectUrl.searchParams.get('state');
    expect(state).toBeTruthy();

    // Verify state was saved in upstream_oauth_states table
    const stateRecord = await appInstance.testDb.db
      .selectFrom('upstream_oauth_states')
      .selectAll()
      .where('state', '=', state!)
      .executeTakeFirst();

    expect(stateRecord).toBeDefined();
    expect(stateRecord?.mcp_identifier).toBe('mock-oauth-mcp');

    // 2. Simulate upstream provider redirecting back to /api/oauth/upstream/callback
    const callbackRes = await appInstance.app.inject({
      method: 'GET',
      url: `/api/oauth/upstream/callback?code=valid_mock_code&state=${encodeURIComponent(
        state!
      )}`,
    });

    expect(callbackRes.statusCode).toBe(302);
    expect(callbackRes.headers.location).toContain(
      '?success=Successfully%20connected'
    );

    // Verify MCP was created in database with upstream_oauth credentials
    const createdMcp = await appInstance.testDb.db
      .selectFrom('registered_mcps')
      .selectAll()
      .where('identifier', '=', 'mock-oauth-mcp')
      .executeTakeFirst();

    expect(createdMcp).toBeDefined();
    expect(createdMcp?.name).toBe('Mock OAuth MCP');

    const credRecord = await appInstance.testDb.db
      .selectFrom('credentials')
      .selectAll()
      .where('mcp_id', '=', createdMcp!.id)
      .executeTakeFirst();

    expect(credRecord).toBeDefined();
    expect(credRecord?.auth_type).toBe('upstream_oauth');

    // Verify state was cleaned up
    const stateAfterCallback = await appInstance.testDb.db
      .selectFrom('upstream_oauth_states')
      .selectAll()
      .where('state', '=', state!)
      .executeTakeFirst();

    expect(stateAfterCallback).toBeUndefined();
  });

  it('transparently refreshes expired upstream token on 401 during message proxying', async () => {
    let messageAttempts = 0;
    const receivedAuthHeaders: string[] = [];

    customMessagesHandler = async (request, reply) => {
      messageAttempts++;
      const auth = (request.headers.authorization as string) || '';
      receivedAuthHeaders.push(auth);

      if (auth === 'Bearer expired_upstream_token') {
        return reply.status(401).send({ error: 'token_expired' });
      }

      if (auth === 'Bearer refreshed_upstream_access_token_new456') {
        return reply.status(202).send({ status: 'accepted' });
      }

      return reply.status(401).send({ error: 'unauthorized' });
    };

    const now = Date.now();
    const mcpId = 'test-refresh-mcp-id';
    const clientToken = 'client_token_test_123';

    // Seed registered MCP
    await appInstance.testDb.db
      .insertInto('registered_mcps')
      .values({
        id: mcpId,
        identifier: 'refresh-test',
        name: 'Refresh Test MCP',
        upstream_url: `${mockBaseUrl}/mcp`,
        created_at: now,
        updated_at: now,
      })
      .execute();

    // Seed credentials with expired token + refresh token
    const { encryptCredential } = await import(
      '../../src/crypto/encryption.js'
    );
    const enc = encryptCredential(
      {
        type: 'upstream_oauth',
        token: 'expired_upstream_token',
        refreshToken: 'upstream_refresh_token_xyz789',
        tokenEndpoint: `${mockBaseUrl}/oauth/token`,
      },
      appInstance.masterKey
    );

    await appInstance.testDb.db
      .insertInto('credentials')
      .values({
        id: 'cred-refresh-1',
        mcp_id: mcpId,
        auth_type: 'upstream_oauth',
        encrypted_payload: enc.ciphertext,
        iv: enc.iv,
        tag: enc.tag,
        key_version: 1,
        created_at: now,
        updated_at: now,
      })
      .execute();

    // Seed client access token
    const { hashSecret } = await import('../../src/crypto/pkce.js');
    await appInstance.testDb.db
      .insertInto('tokens')
      .values({
        token_hash: hashSecret(clientToken),
        token_type: 'access',
        mcp_id: mcpId,
        expires_at: now + 3600_000,
        revoked_at: null,
      })
      .execute();

    // Register active proxy session pointing to mockServer/messages
    const { globalSessionRegistry } = await import(
      '../../src/proxy/sessions.js'
    );
    const sessionId = 'test-session-for-refresh';
    globalSessionRegistry.set(sessionId, {
      sessionId,
      mcpId,
      upstreamMessageUrl: `${mockBaseUrl}/messages`,
      credentials: {
        type: 'upstream_oauth',
        token: 'expired_upstream_token',
        refreshToken: 'upstream_refresh_token_xyz789',
        tokenEndpoint: `${mockBaseUrl}/oauth/token`,
      },
      createdAt: now,
      lastSeenAt: now,
    });

    // Send tool call to proxy
    const res = await appInstance.app.inject({
      method: 'POST',
      url: `/refresh-test/messages?sessionId=${sessionId}`,
      headers: {
        authorization: `Bearer ${clientToken}`,
        'content-type': 'application/json',
      },
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'test_tool' },
      },
    });

    expect(res.statusCode).toBe(202);
    expect(messageAttempts).toBe(2);
    expect(receivedAuthHeaders[0]).toBe('Bearer expired_upstream_token');
    expect(receivedAuthHeaders[1]).toBe(
      'Bearer refreshed_upstream_access_token_new456'
    );

    // Verify DB was updated with refreshed token
    const updatedCred = await appInstance.testDb.db
      .selectFrom('credentials')
      .selectAll()
      .where('mcp_id', '=', mcpId)
      .executeTakeFirst();

    const { decryptCredential } = await import(
      '../../src/crypto/encryption.js'
    );
    const decrypted = decryptCredential(
      updatedCred!.encrypted_payload,
      updatedCred!.iv,
      updatedCred!.tag,
      appInstance.masterKey
    );

    expect((decrypted as any).token).toBe(
      'refreshed_upstream_access_token_new456'
    );
  });
});
