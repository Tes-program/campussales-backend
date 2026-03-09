import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';

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
  synchronize: configService.get('NODE_ENV') === 'development', // Only for development
  logging: configService.get('NODE_ENV') === 'development',
  ssl:
    configService.get('NODE_ENV') === 'production'
      ? { rejectUnauthorized: false }
      : false,
});
