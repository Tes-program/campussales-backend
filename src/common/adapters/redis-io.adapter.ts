import { IoAdapter } from '@nestjs/platform-socket.io';
import { INestApplicationContext, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ServerOptions } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';

/**
 * Custom Socket.io adapter using Redis pub/sub for horizontal scaling.
 * All Socket.io server instances share state via Redis, so messages
 * emitted on one instance are received by clients on any instance.
 */
export class RedisIoAdapter extends IoAdapter {
  private adapterConstructor: ReturnType<typeof createAdapter> | null = null;
  private readonly logger = new Logger(RedisIoAdapter.name);

  constructor(
    app: INestApplicationContext,
    private readonly configService: ConfigService,
  ) {
    super(app);
  }

  async connectToRedis(): Promise<void> {
    const host = this.configService.get<string>('REDIS_HOST', 'localhost');
    const port = this.configService.get<number>('REDIS_PORT', 6379);
    const password = this.configService.get<string>('REDIS_PASSWORD');

    const redisOptions = {
      host,
      port,
      password: password || undefined,
    };

    const pubClient = new Redis(redisOptions);
    const subClient = pubClient.duplicate();

    // Wait for both connections to be ready
    await Promise.all([
      new Promise<void>((resolve, reject) => {
        pubClient.on('ready', resolve);
        pubClient.on('error', reject);
      }),
      new Promise<void>((resolve, reject) => {
        subClient.on('ready', resolve);
        subClient.on('error', reject);
      }),
    ]);

    this.adapterConstructor = createAdapter(pubClient, subClient) as any;
    this.logger.log(`Redis IO adapter connected to ${host}:${port}`);
  }

  createIOServer(port: number, options?: ServerOptions): any {
    const server = super.createIOServer(port, options);
    if (this.adapterConstructor) {
      server.adapter(this.adapterConstructor);
    }
    return server;
  }
}
