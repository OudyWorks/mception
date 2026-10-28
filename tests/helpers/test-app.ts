import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import crypto from 'node:crypto';
import { loadConfig, type Config } from '../../src/config.js';
import { oauthRoutes } from '../../src/oauth/server.js';
import { proxyRoutes } from '../../src/proxy/sse.js';
import { messageRoutes } from '../../src/proxy/messages.js';
import { webRoutes } from '../../src/web/routes.js';
import { createTestDatabase, type TestDb } from './test-db.js';

export interface TestAppInstance {
  app: FastifyInstance;
  testDb: TestDb;
  config: Config;
  masterKey: Buffer;
  listen: () => Promise<string>;
  cleanup: () => Promise<void>;
}

export async function createTestApp(
  customConfig?: Partial<Config>,
  customMasterKey?: Buffer
): Promise<TestAppInstance> {
  const config = loadConfig({
    PORT: 3000,
    MCEPTION_PUBLIC_URL: 'http://localhost:3000',
    ADMIN_API_KEY: 'test-admin-secret',
    ...customConfig,
  } as any);

  const masterKey = customMasterKey || crypto.randomBytes(32);
  const testDb = createTestDatabase();

  const app = Fastify({
    logger: false,
  });

  await app.register(cors);
  await app.register(oauthRoutes, { db: testDb.db, config });
  await app.register(proxyRoutes, { db: testDb.db, config, masterKey });
  await app.register(messageRoutes, { db: testDb.db, config, masterKey });
  await app.register(webRoutes, { db: testDb.db, config, masterKey });

  await app.ready();

  return {
    app,
    testDb,
    config,
    masterKey,
    listen: async () => {
      await app.listen({ port: 0, host: '127.0.0.1' });
      const addr = app.server.address() as any;
      return `http://127.0.0.1:${addr.port}`;
    },
    cleanup: async () => {
      await app.close();
      testDb.cleanup();
    },
  };
}
