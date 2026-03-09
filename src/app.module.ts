import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ThrottlerModule } from '@nestjs/throttler';
import { BullModule } from '@nestjs/bullmq';
import { getDatabaseConfig } from './config/database.config';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/user.module';
import { ProductsModule } from './products/products.module';
import { WishlistModule } from './wishlist/wishlist.module';
import { CategoriesModule } from './categories/categories.module';
import { UniversitiesModule } from './universities/universities.module';
import { UploadsModule } from './uploads/uploads.module';
import { ChatModule } from './chat/chat.module';
import { NotificationsModule } from './notifications/notifications.module';

@Module({
  imports: [
    // Configuration
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),

    // Database
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const config = getDatabaseConfig(configService);
        return {
          ...config,
          // Add connection retry logic
          retryAttempts: 3,
          retryDelay: 3000,
          autoLoadEntities: true,
          logger: 'advanced-console',
          logging:
            configService.get('NODE_ENV') === 'development'
              ? ['error', 'warn', 'migration']
              : ['error'],
        };
      },
    }),

    // Rate limiting
    ThrottlerModule.forRoot([
      {
        ttl: 60000, // 1 minute
        limit: 100, // 100 requests per minute
      },
    ]),

    // BullMQ — Redis-backed job queue
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        connection: {
          host: configService.get<string>('REDIS_HOST', 'localhost'),
          port: configService.get<number>('REDIS_PORT', 6379),
          password: configService.get<string>('REDIS_PASSWORD') || undefined,
        },
      }),
    }),

    AuthModule,
    UsersModule,
    ProductsModule,
    WishlistModule,
    CategoriesModule,
    UniversitiesModule,
    UploadsModule,
    ChatModule,
    NotificationsModule,
  ],
})
export class AppModule {}
