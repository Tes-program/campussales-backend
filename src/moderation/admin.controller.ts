import {
  Body,
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
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ValidationFailed } from '../common/errors/app-errors';
import { User } from '../users/entities/user.entity';
import { AdminActionDto, DryRunDto } from './admin.dto';
import { AdminGuard } from './admin.guard';
import { AdminService } from './admin.service';
import { MaintenanceService } from './maintenance.service';
import { screenListing } from './screening';

@ApiTags('Admin')
@ApiBearerAuth()
@ApiHeader({
  name: 'X-Admin-Key',
  required: true,
  description: 'Must match ADMIN_API_KEY.',
})
@Controller('admin')
@UseGuards(JwtAuthGuard, AdminGuard)
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly maintenance: MaintenanceService,
  ) {}

  @Get('reports')
  @ApiOperation({
    summary:
      'Reports queue (status=open by default; open|dismissed|actioned|all).',
  })
  reports(@Query('status') status = 'open') {
    if (!['open', 'dismissed', 'actioned', 'all'].includes(status)) {
      throw new ValidationFailed({
        status: 'Status must be open, dismissed, actioned or all.',
      });
    }
    return this.admin.listReports(status);
  }

  @Get('products')
  @ApiOperation({
    summary: 'Listings by moderationStatus (needs_review by default).',
  })
  products(@Query('moderationStatus') moderationStatus = 'needs_review') {
    if (!['needs_review', 'rejected', 'approved'].includes(moderationStatus)) {
      throw new ValidationFailed({
        moderationStatus: 'Use needs_review, rejected or approved.',
      });
    }
    return this.admin.listProducts(moderationStatus);
  }

  @Get('users')
  @ApiOperation({
    summary: 'Accounts flagged for review (chat scam signals) or suspended.',
  })
  users() {
    return this.admin.listUsersNeedingReview();
  }

  @Get('audit-log')
  @ApiOperation({ summary: 'Who did what, when.' })
  auditLog() {
    return this.admin.auditLog();
  }

  @Post('actions')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'approve | reject | remove (listing) · warn_user | suspend_user | unsuspend_user | clear_user_review (user) · dismiss_report (report). Audited; owner notified.',
  })
  act(@CurrentUser() admin: User, @Body() dto: AdminActionDto) {
    return this.admin.act(admin, dto.action, dto.targetId, dto.reason);
  }

  @Post('moderation/dry-run')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Run the screening rules on text without saving anything.',
  })
  dryRun(@Body() dto: DryRunDto) {
    return screenListing({ ...dto, imageCount: 1 });
  }

  @Post('summary/send')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Send the open-items summary email now.' })
  summary() {
    return this.maintenance.sendDailySummary(true);
  }
}
