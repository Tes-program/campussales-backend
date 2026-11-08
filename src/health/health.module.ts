import { Module } from '@nestjs/common';
import { AlertsService } from './alerts.service';
import { HealthController } from './health.controller';
import { AdminOpsController } from './admin-ops.controller';
import { UploadsModule } from '../uploads/uploads.module';

@Module({
  imports: [UploadsModule],
  controllers: [HealthController, AdminOpsController],
  providers: [AlertsService],
  exports: [AlertsService],
})
export class HealthModule {}
