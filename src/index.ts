import path from 'node:path';
import cors from '@fastify/cors';
import Fastify from 'fastify';
import { loadConfig } from './config.js';
import { resolveMasterKey } from './crypto/encryption.js';
import { createDatabaseConnection } from './db/connection.js';
import { runMigrations } from './db/migrations.js';
import { oauthRoutes } from './oauth/server.js';
import { messageRoutes } from './proxy/messages.js';
import { proxyRoutes } from './proxy/sse.js';
import { webRoutes } from './web/routes.js';

async function bootstrap() {
  const config = loadConfig();

  const loggerLevel = config.LOG_LEVEL || 'info';
  const fastify = Fastify({
    logger: {
      level: loggerLevel,
      transport:
        process.env.NODE_ENV !== 'production'
          ? { target: 'pino-pretty' }
          : undefined,
    },
  });

  const dbDir = path.dirname(config.DATABASE_PATH);
  const masterKey = resolveMasterKey(config.MCEPTION_MASTER_KEY, dbDir);

  const { db, rawDb } = createDatabaseConnection(config.DATABASE_PATH);
  fastify.log.info('Running database migrations...');
  runMigrations(rawDb);
  fastify.log.info('Database initialized and migrated successfully.');

  // Register core plugins & routes
  await fastify.register(cors, {
    origin: true,
  });

  await fastify.register(oauthRoutes, { db, config });
  await fastify.register(proxyRoutes, { db, config, masterKey });
  await fastify.register(messageRoutes, { db, config, masterKey });
  await fastify.register(webRoutes, { db, config, masterKey });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    fastify.log.info(`Received ${signal}. Shutting down gracefully...`);
    try {
      await fastify.close();
      rawDb.close();
      fastify.log.info('MCeption stopped cleanly.');
      process.exit(0);
    } catch (err) {
      fastify.log.error(err, 'Error during graceful shutdown');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  try {
    await fastify.listen({ port: config.PORT, host: '0.0.0.0' });
    fastify.log.info(
      `MCeption is running on ${config.MCEPTION_PUBLIC_URL} (Port ${config.PORT})`
    );
  } catch (err) {
    fastify.log.error(err, 'Failed to start MCeption server');
    process.exit(1);
  }
}

bootstrap().catch((err) => {
  console.error('Fatal initialization error:', err);
  process.exit(1);
});
