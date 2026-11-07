import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import compression from 'compression';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { TimeoutInterceptor } from './common/interceptors/timeout.interceptor';
import { SanitizeInterceptor } from './common/interceptors/sanitize.interceptor';
import { requestIdMiddleware } from './common/middleware/request-id.middleware';
import { queryCountMiddleware } from './common/query-count';
import { createValidationPipe } from './common/validation/validation-errors';

/**
 * Global HTTP pipeline shared by main.ts and the integration tests, so tests
 * exercise exactly what production runs.
 */
export function configureApp(app: INestApplication): void {
  const configService = app.get(ConfigService);

  // Must be first so every response, including guard/pipe failures, has an id.
  app.use(requestIdMiddleware);
  app.use(queryCountMiddleware);

  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalInterceptors(
    new LoggingInterceptor(),
    new TimeoutInterceptor(),
    new SanitizeInterceptor(),
  );

  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(compression());

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
    exposedHeaders: ['X-Request-Id', 'Retry-After', 'ETag'],
  });

  app.useGlobalPipes(createValidationPipe());
  // /share/* serves link-preview HTML at the root, outside /api.
  app.setGlobalPrefix('api', { exclude: ['share', 'share/(.*)'] });
}
