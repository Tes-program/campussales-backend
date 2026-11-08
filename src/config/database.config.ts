import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { QueryTimingSubscriber } from '../common/query-count';

const num = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/**
 * One shared node-postgres pool per process (never a connection per
 * request). DB_POOL_MAX should stay below the database's max_connections
 * divided by the number of API instances (Railway Postgres: 100).
 */
export function poolOptions(configService: ConfigService) {
  return {
    max: num(configService.get<string>('DB_POOL_MAX'), 20),
    min: 2,
    idleTimeoutMillis: 30_000,
    // Fail fast (and alert) instead of queueing forever when the pool is exhausted.
    connectionTimeoutMillis: num(
      configService.get<string>('DB_CONNECTION_TIMEOUT_MS'),
      5_000,
    ),
    keepAlive: true,
    application_name: 'campussales-api',
    // Stop runaway queries just before the 15 s request timeout.
    statement_timeout: num(
      configService.get<string>('DB_STATEMENT_TIMEOUT_MS'),
      14_000,
    ),
  };
}

export const getDatabaseConfig = (
  configService: ConfigService,
): TypeOrmModuleOptions => ({
  type: 'postgres',
  host: configService.get<string>('DATABASE_HOST') || 'localhost',
  port: parseInt(configService.get<string>('DATABASE_PORT') || '5432', 10),
  username: configService.get<string>('DATABASE_USERNAME') || 'postgres',
  password: configService.get<string>('DATABASE_PASSWORD') || '',
  database: configService.get<string>('DATABASE_NAME') || 'campussales',
  entities: [__dirname + '/../**/*.entity{.ts,.js}'],
  migrations: [__dirname + '/../database/migrations/*{.ts,.js}'],
  subscribers: [QueryTimingSubscriber],
  extra: poolOptions(configService),
  synchronize: configService.get('NODE_ENV') === 'development', // Only for development
  logging: configService.get('NODE_ENV') === 'development',
  ssl:
    configService.get('NODE_ENV') === 'production'
      ? { rejectUnauthorized: false }
      : false,
});
