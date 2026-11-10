import {
  Controller,
  Get,
  Patch,
  Delete,
  Param,
  Query,
  UseGuards,
  ParseUUIDPipe,
  Logger,
  Post,
  HttpCode,
  HttpStatus,
  Body,
} from '@nestjs/common';
import { WebPushService } from './web-push.service';
import {
  PushSubscriptionDto,
  PushUnsubscribeDto,
} from './dto/push-subscription.dto';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { NotificationsService } from './notifications.service';
import { FilterNotificationsDto } from './dto/filter-notifications.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';

@ApiTags('Notifications')
@Controller('notifications')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class NotificationsController {
  private readonly logger = new Logger(NotificationsController.name);

  constructor(
    private readonly notificationsService: NotificationsService,
    private readonly webPush: WebPushService,
  ) {}

  // ─── Web Push (C1, behind CHAT_WEB_PUSH) ───

  @Get('push/public-key')
  @ApiOperation({
    summary:
      'VAPID public key for PushManager.subscribe(); null when Web Push is off.',
  })
  pushPublicKey() {
    return {
      enabled: this.webPush.enabled(),
      publicKey: this.webPush.publicKey(),
    };
  }

  @Post('push/subscriptions')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Register this browser for Web Push (idempotent).' })
  async pushSubscribe(
    @CurrentUser() user: User,
    @Body() dto: PushSubscriptionDto,
  ) {
    await this.webPush.subscribe(user.id, dto);
  }

  @Post('push/subscriptions/remove')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Stop Web Push for this browser (idempotent).' })
  async pushUnsubscribe(
    @CurrentUser() user: User,
    @Body() dto: PushUnsubscribeDto,
  ) {
    await this.webPush.unsubscribe(user.id, dto.endpoint);
  }

  @Get()
  @ApiOperation({ summary: 'List user notifications (paginated)' })
  @ApiQuery({ name: 'page', required: false, example: 1 })
  @ApiQuery({ name: 'limit', required: false, example: 20 })
  @ApiQuery({
    name: 'type',
    required: false,
    enum: ['all', 'unread'],
    example: 'all',
  })
  @ApiResponse({ status: 200, description: 'Notifications retrieved' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async findAll(
    @CurrentUser() user: User,
    @Query() filterDto: FilterNotificationsDto,
  ) {
    this.logger.log(`User ${user.id} fetching notifications`);
    return await this.notificationsService.findAll(user.id, filterDto);
  }

  @Get('unread-count')
  @ApiOperation({ summary: 'Get unread notification count' })
  @ApiResponse({ status: 200, description: 'Unread count retrieved' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async getUnreadCount(@CurrentUser() user: User) {
    this.logger.log(`User ${user.id} checking unread count`);
    return await this.notificationsService.getUnreadCount(user.id);
  }

  @Post('read-all')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark all notifications as read' })
  async readAll(@CurrentUser() user: User) {
    return this.notificationsService.markAllAsRead(user.id);
  }

  @Post(':id/read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark one notification as read (idempotent)' })
  async read(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.notificationsService.markAsRead(id, user.id);
  }

  /** @deprecated use POST /notifications/read-all */
  @Patch('read-all')
  @ApiOperation({ summary: 'Mark all notifications as read' })
  @ApiResponse({ status: 200, description: 'All notifications marked as read' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async markAllAsRead(@CurrentUser() user: User) {
    this.logger.log(`User ${user.id} marking all notifications as read`);
    return await this.notificationsService.markAllAsRead(user.id);
  }

  @Patch(':id/read')
  @ApiOperation({ summary: 'Mark a single notification as read' })
  @ApiResponse({ status: 200, description: 'Notification marked as read' })
  @ApiResponse({ status: 404, description: 'Notification not found' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async markAsRead(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    this.logger.log(`User ${user.id} marking notification ${id} as read`);
    return await this.notificationsService.markAsRead(id, user.id);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a notification' })
  @ApiResponse({ status: 200, description: 'Notification deleted' })
  @ApiResponse({ status: 404, description: 'Notification not found' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async deleteNotification(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    this.logger.log(`User ${user.id} deleting notification ${id}`);
    return await this.notificationsService.deleteNotification(id, user.id);
  }
}
