// Before anything touches libuv's thread pool: bcrypt, zlib (compression)
// and DNS share it, so a burst of logins must not starve response compression.
process.env.UV_THREADPOOL_SIZE = process.env.UV_THREADPOOL_SIZE || '8';

import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { NestExpressApplication } from '@nestjs/platform-express';
import type { Server } from 'http';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { RedisIoAdapter } from './common/adapters/redis-io.adapter';
import { join } from 'path';
import { validateEnv } from './config/env.validation';
import { createAppLogger } from './common/observability/json-logger';
import { lifecycle } from './health/lifecycle';
import { flushPendingWork } from './common/observability/shutdown';

/** Time allowed for in-flight requests to finish after SIGTERM. */
const SHUTDOWN_GRACE_MS = Number(process.env.SHUTDOWN_GRACE_MS || 20_000);

async function bootstrap() {
  validateEnv();
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: createAppLogger(),
    bufferLogs: true,
  });
  const configService = app.get(ConfigService);

  // Redis-backed Socket.io adapter for horizontal scaling
  const redisIoAdapter = new RedisIoAdapter(app, configService);
  try {
    await redisIoAdapter.connectToRedis();
    app.useWebSocketAdapter(redisIoAdapter);
    logger.log('Redis WebSocket adapter enabled');
  } catch (error) {
    logger.warn(
      `Redis adapter failed to connect — falling back to in-memory adapter: ${(error as Error).message}`,
    );
    // App still works with the default in-memory adapter (single-instance only)
  }

  configureApp(app);

  app.useStaticAssets(join(__dirname, '..', 'uploads'), {
    prefix: '/uploads/',
  });

  // Swagger documentation
  const config = new DocumentBuilder()
    .setTitle('CampusSales API')
    .setDescription('Student marketplace API documentation')
    .setVersion('1.0')
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document);

  const port = configService.get<number>('PORT') || 3000;
  await app.listen(port);

  // Keep idle connections open longer than the host's proxy does (Railway
  // and Render use ~60 s), so the proxy never reuses a socket we just closed
  // (a classic source of random 502s).
  const server: Server = app.getHttpServer();
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  installProcessHandlers(app, server, logger);

  logger.log(`Application is running on port ${port}`);
  logger.log(`API docs: /api/docs  Health: /health  Ready: /health/ready`);
}

let shuttingDown = false;

/**
 * Graceful shutdown: on SIGTERM (deploys, restarts) stop accepting new
 * connections, let in-flight requests finish (Nest closes the HTTP server and
 * waits), flush queued analytics events, then exit. /health/ready fails
 * during the drain so the host stops routing to this instance. A hard exit
 * after SHUTDOWN_GRACE_MS guarantees we never hang a deploy.
 *
 * Unhandled rejections and uncaught exceptions are logged (structured, with
 * stack) and the process exits cleanly so the host restarts it in a known
 * state rather than limping on.
 */
function installProcessHandlers(
  app: NestExpressApplication,
  server: Server,
  logger: Logger,
) {
  const shutdown = async (reason: string, code: number) => {
    if (shuttingDown) return;
    shuttingDown = true;
    lifecycle.draining = true;
    logger.warn(`Shutting down (${reason}); draining in-flight requests`);
    const force = setTimeout(() => {
      logger.error('Graceful shutdown timed out; exiting');
      process.exit(code || 1);
    }, SHUTDOWN_GRACE_MS);
    force.unref();
    try {
      // Stop accepting connections and wait for in-flight requests BEFORE
      // Nest tears down the database pool (app.close destroys modules first).
      // Open websockets keep server.close() pending, so cap the wait.
      await Promise.race([
        new Promise<void>((resolve) => server.close(() => resolve())),
        new Promise<void>((resolve) =>
          setTimeout(resolve, SHUTDOWN_GRACE_MS / 2).unref(),
        ),
      ]);
      await flushPendingWork();
      await app.close();
    } catch (e) {
      logger.error(`Error during shutdown: ${(e as Error).message}`);
    }
    process.exit(code);
  };

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => void shutdown(signal, 0));
  }
  process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    logger.error(`Unhandled promise rejection: ${err.message}`, err.stack);
    void shutdown('unhandledRejection', 1);
  });
  process.on('uncaughtException', (err) => {
    logger.error(`Uncaught exception: ${err.message}`, err.stack);
    void shutdown('uncaughtException', 1);
  });
}

bootstrap().catch((error) => {
  // Before the app logger exists: print the configuration problem plainly.
  console.error('Failed to start application:', (error as Error).message);
  process.exit(1);
});
