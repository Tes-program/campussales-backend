import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NotificationsModule } from '../notifications/notifications.module';
import { Product } from '../products/entities/product.entity';
import { User } from '../users/entities/user.entity';
import { AdminController } from './admin.controller';
import { AdminGuard } from './admin.guard';
import { AdminService } from './admin.service';
import { MaintenanceService } from './maintenance.service';
import { ModerationService } from './moderation.service';
import { AdminAuditLog, Report } from './report.entity';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([Report, AdminAuditLog, Product, User]),
    NotificationsModule,
  ],
  controllers: [ReportsController, AdminController],
  providers: [
    ModerationService,
    ReportsService,
    AdminService,
    AdminGuard,
    MaintenanceService,
  ],
  exports: [ModerationService, MaintenanceService, ReportsService],
})
export class ModerationModule {}
