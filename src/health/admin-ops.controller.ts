import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CacheService } from '../common/cache/cache.service';
import { metrics } from '../common/observability/metrics';
import { AdminGuard } from '../moderation/admin.guard';
import {
  cleanupMode,
  UploadCleanupService,
} from '../uploads/upload-cleanup.service';
import { AlertsService } from './alerts.service';
import { poolStats } from './db-pool';
import { chatMetrics } from '../chat/chat-metrics';

@ApiTags('Admin')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Admin-Key', required: true })
@Controller('admin')
@UseGuards(JwtAuthGuard, AdminGuard)
export class AdminOpsController {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly cache: CacheService,
    private readonly cleanup: UploadCleanupService,
    private readonly alerts: AlertsService,
  ) {}

  @Get('metrics')
  @ApiOperation({
    summary:
      'Per-route p50/p95/p99, error rate, pool and cache stats for this instance (last 15 min by default).',
  })
  metrics(@Query('minutes') minutesRaw?: string) {
    const minutes = Math.min(15, Math.max(1, Number(minutesRaw) || 15));
    const window = minutes * 60_000;
    return {
      summary: metrics.summary(window),
      routes: metrics.byRoute(window),
      pool: poolStats(this.ds),
      cache: this.cache.stats(),
      chat: chatMetrics.snapshot(window),
      memoryMb: Math.round(process.memoryUsage().rss / 1048576),
      uptimeSeconds: Math.round(process.uptime()),
    };
  }

  @Post('uploads/cleanup')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Run the image clean-up now. Dry run unless dryRun=false AND UPLOAD_CLEANUP_MODE=delete.',
  })
  runCleanup(@Query('dryRun') dryRun?: string) {
    const mode =
      dryRun === 'false' && cleanupMode() === 'delete' ? 'delete' : 'dry-run';
    return this.cleanup.run(mode);
  }

  @Post('alerts/test')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Send a test alert to ALERT_WEBHOOK_URL / ALERT_EMAIL.',
  })
  async testAlert() {
    await this.alerts.notify('[TEST] alerting', 'Alert delivery works.');
    return { sent: true };
  }
}
