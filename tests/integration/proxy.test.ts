import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encryptCredential } from '../../src/crypto/encryption.js';
import { hashSecret } from '../../src/crypto/pkce.js';
import {
  createMockUpstreamServer,
  type MockUpstreamInstance,
} from '../helpers/mock-upstream.js';
import { createTestApp, type TestAppInstance } from '../helpers/test-app.js';

describe('MCP Reverse Proxy Integration Test Suite', () => {
  let instance: TestAppInstance;
  let mockUpstream: MockUpstreamInstance;
  let baseUrl: string;
  const masterKey = crypto.randomBytes(32);
  const rawAccessToken = 'test-gemini-access-token-123';
  const mcpId = 'mcp-weather-id';

  beforeEach(async () => {
    mockUpstream = await createMockUpstreamServer();
    instance = (await createTestApp({}, masterKey)) as any;
    baseUrl = await instance.listen();

    const now = Date.now();
    // Seed registered MCP pointing to mock upstream
    await instance.testDb.db
      .insertInto('registered_mcps')
      .values({
        id: mcpId,
        identifier: 'weather',
        name: 'Weather Service',
        upstream_url: mockUpstream.url,
        created_at: now,
        updated_at: now,
      })
      .execute();

    // Seed credentials (API Key Header: X-API-Key: my-api-key)
    const enc = encryptCredential(
      {
        type: 'api_key_header',
        headerName: 'X-API-Key',
        apiKey: 'my-api-key-123',
      },
      masterKey
    );

    await instance.testDb.db
      .insertInto('credentials')
      .values({
        id: 'cred-1',
        mcp_id: mcpId,
        auth_type: 'api_key_header',
        encrypted_payload: enc.ciphertext,
        iv: enc.iv,
        tag: enc.tag,
        key_version: 1,
        created_at: now,
        updated_at: now,
      })
      .execute();

    // Seed valid access token
    await instance.testDb.db
      .insertInto('tokens')
      .values({
        token_hash: hashSecret(rawAccessToken),
        token_type: 'access',
        mcp_id: mcpId,
        expires_at: now + 3600_000,
        revoked_at: null,
      })
      .execute();
  });

  afterEach(async () => {
    await mockUpstream.close();
    await instance.cleanup();
  });

  it('rejects SSE connection without Authorization header', async () => {
    const res = await fetch(`${baseUrl}/weather/sse`);
    expect(res.status).toBe(401);
  });

  it('intercepts upstream SSE, rewrites endpoint event, and proxies JSON-RPC messages with injected credentials', async () => {
    const abortController = new AbortController();

    // Step 1: Open SSE stream using fetch
    const sseRes = await fetch(`${baseUrl}/weather/sse`, {
      headers: {
        authorization: `Bearer ${rawAccessToken}`,
      },
      signal: abortController.signal,
    });

    expect(sseRes.status).toBe(200);
    expect(sseRes.headers.get('content-type')).toContain('text/event-stream');

    // Read the first chunk from the SSE stream
    const reader = sseRes.body!.getReader();
    const decoder = new TextDecoder();
    let { value } = await reader.read();
    let text = decoder.decode(value);

    expect(text).toContain('event: endpoint');

    // Extract rewritten endpoint URL
    const match = text.match(
      /data:\s*\/weather\/messages\?sessionId=([a-f0-9-]+)/
    );
    expect(match).not.toBeNull();
    const proxySessionId = match![1];

    // Verify upstream received injected API key header on SSE connect
    const upstreamSseHeader = mockUpstream.receivedHeaders[0];
    expect(upstreamSseHeader['x-api-key']).toBe('my-api-key-123');

    // Step 2: Dispatch JSON-RPC tool call to rewritten message endpoint
    const toolCallPayload = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'get_weather',
        arguments: { city: 'Paris' },
      },
    };

    const msgRes = await fetch(
      `${baseUrl}/weather/messages?sessionId=${proxySessionId}`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${rawAccessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(toolCallPayload),
      }
    );

    expect(msgRes.status).toBe(202);

    // Verify upstream received the message and injected headers
    expect(mockUpstream.receivedMessages.length).toBe(1);
    expect(mockUpstream.receivedMessages[0]).toEqual(toolCallPayload);

    const upstreamPostHeader = mockUpstream.receivedHeaders[1];
    expect(upstreamPostHeader['x-api-key']).toBe('my-api-key-123');

    // Abort SSE reader
    abortController.abort();
  });

  it('rejects message forwarding when sessionId is invalid or expired', async () => {
    const msgRes = await fetch(
      `${baseUrl}/weather/messages?sessionId=non-existent-session`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${rawAccessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1 }),
      }
    );

    expect(msgRes.status).toBe(400);
    const json = (await msgRes.json()) as any;
    expect(json.error).toContain('Invalid or expired sessionId');
  });

  it('returns structured JSON-RPC error -32001 when upstream returns HTTP 401', async () => {
    // Update credential in db to an invalid token that triggers 401 in mock upstream
    const enc = encryptCredential(
      { type: 'bearer', token: 'invalid_upstream_token' },
      masterKey
    );

    await instance.testDb.db
      .updateTable('credentials')
      .set({
        auth_type: 'bearer',
        encrypted_payload: enc.ciphertext,
        iv: enc.iv,
        tag: enc.tag,
      })
      .where('mcp_id', '=', mcpId)
      .execute();

    const abortController = new AbortController();

    // Establish SSE
    const sseRes = await fetch(`${baseUrl}/weather/sse`, {
      headers: { authorization: `Bearer ${rawAccessToken}` },
      signal: abortController.signal,
    });
    const reader = sseRes.body!.getReader();
    const decoder = new TextDecoder();
    const { value } = await reader.read();
    const text = decoder.decode(value);

    const match = text.match(
      /data:\s*\/weather\/messages\?sessionId=([a-f0-9-]+)/
    );
    const proxySessionId = match![1];

    // Send tool call
    const msgRes = await fetch(
      `${baseUrl}/weather/messages?sessionId=${proxySessionId}`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${rawAccessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 42, method: 'tools/call' }),
      }
    );

    expect(msgRes.status).toBe(200);
    const json = (await msgRes.json()) as any;
    expect(json.jsonrpc).toBe('2.0');
    expect(json.id).toBe(42);
    expect(json.error.code).toBe(-32001);
    expect(json.error.message).toContain('Upstream authentication failed');

    abortController.abort();
  });
});
