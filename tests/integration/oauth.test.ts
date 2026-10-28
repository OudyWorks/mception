import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPkcePair } from '../../src/crypto/pkce.js';
import { createTestApp, type TestAppInstance } from '../helpers/test-app.js';

describe('OAuth 2.1 Integration Test Suite', () => {
  let instance: TestAppInstance;

  beforeEach(async () => {
    instance = await createTestApp();

    // Seed test endpoint
    const now = Date.now();
    await instance.testDb.db
      .insertInto('registered_mcps')
      .values({
        id: 'mcp-test-1',
        identifier: 'weather',
        name: 'Weather MCP Server',
        upstream_url: 'http://localhost:8080/sse',
        created_at: now,
        updated_at: now,
      })
      .execute();
  });

  afterEach(async () => {
    await instance.cleanup();
  });

  describe('RFC 8414 Discovery Endpoint', () => {
    it('returns RFC 8414 metadata for registered endpoint', async () => {
      const response = await instance.app.inject({
        method: 'GET',
        url: '/weather/.well-known/oauth-authorization-server',
      });

      expect(response.statusCode).toBe(200);
      const data = response.json();
      expect(data.issuer).toBe('http://localhost:3000/weather');
      expect(data.authorization_endpoint).toBe(
        'http://localhost:3000/weather/oauth/authorize'
      );
      expect(data.token_endpoint).toBe(
        'http://localhost:3000/weather/oauth/token'
      );
      expect(data.code_challenge_methods_supported).toEqual(['S256']);
      expect(data.grant_types_supported).toContain('authorization_code');
      expect(data.grant_types_supported).toContain('refresh_token');
    });

    it('returns 404 for non-existent endpoint identifier', async () => {
      const response = await instance.app.inject({
        method: 'GET',
        url: '/nonexistent/.well-known/oauth-authorization-server',
      });
      expect(response.statusCode).toBe(404);
    });
  });

  describe('OAuth 2.1 Authorization Code Flow (/oauth/authorize)', () => {
    it('redirects with authorization code on valid request', async () => {
      const { challenge } = createPkcePair();

      const response = await instance.app.inject({
        method: 'GET',
        url: '/weather/oauth/authorize',
        query: {
          response_type: 'code',
          client_id: 'gemini-spark',
          redirect_uri: 'https://gemini.google.com/oauth/callback',
          scope: 'mcp',
          state: 'test-client-state-123',
          code_challenge: challenge,
          code_challenge_method: 'S256',
        },
      });

      expect(response.statusCode).toBe(302);
      const location = response.headers.location;
      expect(location).toBeDefined();

      const redirectUrl = new URL(location!);
      expect(redirectUrl.origin).toBe('https://gemini.google.com');
      expect(redirectUrl.pathname).toBe('/oauth/callback');
      expect(redirectUrl.searchParams.get('state')).toBe(
        'test-client-state-123'
      );
      expect(redirectUrl.searchParams.get('code')).toBeTruthy();
    });

    it('rejects missing or unsupported PKCE methods', async () => {
      const response = await instance.app.inject({
        method: 'GET',
        url: '/weather/oauth/authorize',
        query: {
          response_type: 'code',
          redirect_uri: 'https://gemini.google.com/oauth/callback',
          code_challenge: 'plain_challenge',
          code_challenge_method: 'plain',
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe('invalid_request');
    });
  });

  describe('OAuth 2.1 Token Exchange (/oauth/token)', () => {
    it('successfully exchanges code for tokens and executes refresh flow', async () => {
      const { verifier, challenge } = createPkcePair();

      // Step 1: Authorize
      const authResponse = await instance.app.inject({
        method: 'GET',
        url: '/weather/oauth/authorize',
        query: {
          response_type: 'code',
          client_id: 'gemini-spark',
          redirect_uri: 'https://gemini.google.com/oauth/callback',
          code_challenge: challenge,
          code_challenge_method: 'S256',
        },
      });

      const location = new URL(authResponse.headers.location!);
      const code = location.searchParams.get('code')!;

      // Step 2: Redeem Token
      const tokenResponse = await instance.app.inject({
        method: 'POST',
        url: '/weather/oauth/token',
        payload: {
          grant_type: 'authorization_code',
          code,
          code_verifier: verifier,
          redirect_uri: 'https://gemini.google.com/oauth/callback',
        },
      });

      expect(tokenResponse.statusCode).toBe(200);
      const tokenData = tokenResponse.json();
      expect(tokenData.access_token).toBeTypeOf('string');
      expect(tokenData.token_type).toBe('Bearer');
      expect(tokenData.expires_in).toBe(3600);
      expect(tokenData.refresh_token).toBeTypeOf('string');

      // Step 3: Replay Attack Prevention (Code cannot be reused)
      const replayResponse = await instance.app.inject({
        method: 'POST',
        url: '/weather/oauth/token',
        payload: {
          grant_type: 'authorization_code',
          code,
          code_verifier: verifier,
        },
      });
      expect(replayResponse.statusCode).toBe(400);
      expect(replayResponse.json().error).toBe('invalid_grant');

      // Step 4: Refresh Token Exchange
      const refreshResponse = await instance.app.inject({
        method: 'POST',
        url: '/weather/oauth/token',
        payload: {
          grant_type: 'refresh_token',
          refresh_token: tokenData.refresh_token,
        },
      });

      expect(refreshResponse.statusCode).toBe(200);
      const refreshedData = refreshResponse.json();
      expect(refreshedData.access_token).toBeTypeOf('string');
      expect(refreshedData.refresh_token).not.toBe(tokenData.refresh_token); // Rotation!

      // Step 5: Old refresh token is revoked
      const reusedRefreshResponse = await instance.app.inject({
        method: 'POST',
        url: '/weather/oauth/token',
        payload: {
          grant_type: 'refresh_token',
          refresh_token: tokenData.refresh_token,
        },
      });
      expect(reusedRefreshResponse.statusCode).toBe(400);
      expect(reusedRefreshResponse.json().error).toBe('invalid_grant');
    });

    it('rejects invalid code_verifier', async () => {
      const { challenge } = createPkcePair();

      const authResponse = await instance.app.inject({
        method: 'GET',
        url: '/weather/oauth/authorize',
        query: {
          response_type: 'code',
          redirect_uri: 'https://gemini.google.com/oauth/callback',
          code_challenge: challenge,
          code_challenge_method: 'S256',
        },
      });

      const location = new URL(authResponse.headers.location!);
      const code = location.searchParams.get('code')!;

      const tokenResponse = await instance.app.inject({
        method: 'POST',
        url: '/weather/oauth/token',
        payload: {
          grant_type: 'authorization_code',
          code,
          code_verifier: 'invalid-verifier-string',
        },
      });

      expect(tokenResponse.statusCode).toBe(400);
      expect(tokenResponse.json().error).toBe('invalid_grant');
    });
  });
});
