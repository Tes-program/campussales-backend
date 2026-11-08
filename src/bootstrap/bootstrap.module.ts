import { Module } from '@nestjs/common';
import { CategoriesModule } from '../categories/categories.module';
import { ChatModule } from '../chat/chat.module';
import { FeedModule } from '../feed/feed.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ProductsModule } from '../products/products.module';
import { UniversitiesModule } from '../universities/universities.module';
import { BootstrapController } from './bootstrap.controller';
import { BootstrapService } from './bootstrap.service';

@Module({
  imports: [
    CategoriesModule,
    ChatModule,
    FeedModule,
    NotificationsModule,
    ProductsModule,
    UniversitiesModule,
  ],
  controllers: [BootstrapController],
  providers: [BootstrapService],
})
export class BootstrapModule {}
