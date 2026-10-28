import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { webRoutes } from '../../src/web/routes.js';
import { createTestApp, type TestAppInstance } from '../helpers/test-app.js';

describe('Web Dashboard & Admin API Integration Tests', () => {
  let instance: TestAppInstance;

  beforeEach(async () => {
    instance = await createTestApp({
      ADMIN_API_KEY: 'test-admin-key-secret',
    });
  });

  afterEach(async () => {
    await instance.cleanup();
  });

  it('serves healthcheck at GET /healthz', async () => {
    const res = await instance.app.inject({
      method: 'GET',
      url: '/healthz',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ok');
  });

  it('rejects access to /api/mcps without valid ADMIN_API_KEY', async () => {
    const res = await instance.app.inject({
      method: 'GET',
      url: '/api/mcps',
    });
    expect(res.statusCode).toBe(401);
  });

  it('registers, lists, and deletes remote MCP endpoints via Admin API', async () => {
    // 1. Create remote MCP
    const createRes = await instance.app.inject({
      method: 'POST',
      url: '/api/mcps',
      headers: {
        authorization: 'Bearer test-admin-key-secret',
      },
      payload: {
        identifier: 'github-tools',
        name: 'GitHub Tools MCP',
        upstream_url: 'https://api.github.com/mcp/sse',
        credentials: {
          type: 'bearer',
          token: 'ghp_secret_token_12345',
        },
      },
    });

    expect(createRes.statusCode).toBe(201);
    const createdData = createRes.json();
    expect(createdData.identifier).toBe('github-tools');
    expect(createdData.auth_type).toBe('bearer');
    expect(createdData.connected_app_url).toBe(
      'http://localhost:3000/github-tools'
    );

    // 2. List MCPs
    const listRes = await instance.app.inject({
      method: 'GET',
      url: '/api/mcps',
      headers: {
        authorization: 'Bearer test-admin-key-secret',
      },
    });

    expect(listRes.statusCode).toBe(200);
    const listData = listRes.json();
    expect(listData.mcps.length).toBe(1);
    expect(listData.mcps[0].identifier).toBe('github-tools');
    expect(listData.mcps[0].name).toBe('GitHub Tools MCP');
    // Ensure plaintext token is never leaked in list payload
    expect(JSON.stringify(listData)).not.toContain('ghp_secret_token_12345');

    // 3. Delete MCP
    const deleteRes = await instance.app.inject({
      method: 'DELETE',
      url: '/api/mcps/github-tools',
      headers: {
        authorization: 'Bearer test-admin-key-secret',
      },
    });

    expect(deleteRes.statusCode).toBe(200);
    expect(deleteRes.json().success).toBe(true);

    // 4. Verify deletion
    const listAfterDelete = await instance.app.inject({
      method: 'GET',
      url: '/api/mcps',
      headers: {
        authorization: 'Bearer test-admin-key-secret',
      },
    });
    expect(listAfterDelete.json().mcps.length).toBe(0);
  });
});
