import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProductsModule } from '../products/products.module';
import { UserProfile } from '../users/entities/user-profile.entity';
import { FeedController } from './feed.controller';
import { FeedService } from './feed.service';
import { MeController } from './me.controller';

@Module({
  imports: [ProductsModule, TypeOrmModule.forFeature([UserProfile])],
  controllers: [FeedController, MeController],
  providers: [FeedService],
})
export class FeedModule {}
