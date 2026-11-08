import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import helmet from 'helmet';
import compression from 'compression';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { TimeoutInterceptor } from './common/interceptors/timeout.interceptor';
import { SanitizeInterceptor } from './common/interceptors/sanitize.interceptor';
import { requestIdMiddleware } from './common/middleware/request-id.middleware';
import { timingMiddleware } from './common/observability/timing.middleware';
import { HttpCacheInterceptor } from './common/http-cache/http-cache.interceptor';
import { createValidationPipe } from './common/validation/validation-errors';

/**
 * Global HTTP pipeline shared by main.ts and the integration tests, so tests
 * exercise exactly what production runs.
 */
export function configureApp(app: INestApplication): void {
  const configService = app.get(ConfigService);

  const reflector = app.get(Reflector);

  // Must be first so every response, including guard/pipe failures, has an id.
  app.use(requestIdMiddleware);
  // Timing log, metrics, Server-Timing (non-production), query counts.
  app.use(timingMiddleware);

  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalInterceptors(
    new TimeoutInterceptor(reflector),
    new HttpCacheInterceptor(reflector),
    new SanitizeInterceptor(),
  );

  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  // br (quality 4) or gzip for anything over 1 KB.
  app.use(compression({ threshold: 1024 }));

  const isProd = configService.get('NODE_ENV') === 'production';

  // Behind Railway's proxy: trust one hop so req.ip is the student's IP
  // (per-IP rate limits would otherwise treat everyone as one client).
  const trustProxy =
    configService.get<string>('TRUST_PROXY') ?? (isProd ? '1' : '');
  if (trustProxy) {
    (
      app.getHttpAdapter().getInstance() as {
        set: (k: string, v: unknown) => void;
      }
    ).set(
      'trust proxy',
      /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy,
    );
  }

  // Only the configured frontend origin(s); localhost dev servers outside production.
  const configured = (configService.get<string>('CORS_ORIGIN') || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  const devOrigins = isProd
    ? []
    : [
        'http://localhost:5173',
        'http://localhost:4173',
        'http://localhost:3000',
      ];
  app.enableCors({
    origin: [...new Set([...configured, ...devOrigins])],
    credentials: true,
    exposedHeaders: [
      'X-Request-Id',
      'Retry-After',
      'ETag',
      'Server-Timing',
      'X-Query-Count',
    ],
  });

  app.useGlobalPipes(createValidationPipe());
  // /share/* serves link-preview HTML and /health* serves the host's health
  // checks at the root, outside /api.
  app.setGlobalPrefix('api', {
    exclude: ['share', 'share/(.*)', 'health', 'health/ready'],
  });
}
