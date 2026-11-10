import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { RateLimit } from '../common/rate-limit/rate-limit.decorator';
import { EmailVerifiedGuard } from '../auth/guards/email-verified.guard';
import { ChatService } from './chat.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';
import { CreateConversationDto } from './dto/create-conversation.dto';
import { SendMessageDto } from './dto/send-message.dto';
import { FilterConversationsDto } from './dto/filter-conversations.dto';
import { FilterMessagesDto } from './dto/filter-messages.dto';
import {
  ChatSettingsDto,
  ConversationSettingsDto,
  DeleteMessageQueryDto,
  MarkReadDto,
  ReportMessageDto,
} from './dto/chat-actions.dto';
import { ReportsService } from '../moderation/reports.service';
import { notFound } from '../common/errors/app-errors';
import type { ReportReason } from '../moderation/report.entity';

@ApiTags('Chat')
@Controller('chat')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class ChatController {
  constructor(
    private readonly chatService: ChatService,
    private readonly reports: ReportsService,
  ) {}

  // --- Conversations ---

  @Post('conversations')
  @RateLimit('messages')
  @UseGuards(EmailVerifiedGuard)
  @ApiOperation({
    summary:
      'Find or create the conversation with a user: one per (pair, product), one general per pair',
  })
  @ApiResponse({ status: 201, description: 'Conversation created' })
  @ApiResponse({ status: 200, description: 'Existing conversation returned' })
  async createConversation(
    @CurrentUser() user: User,
    @Body() dto: CreateConversationDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { conversation, isExisting } =
      await this.chatService.createConversation(user.id, dto);
    res.status(isExisting ? HttpStatus.OK : HttpStatus.CREATED);
    return conversation;
  }

  @Get('conversations')
  @ApiOperation({
    summary:
      'Conversation list, newest first, cursor paginated: { items, nextCursor, totalUnread }',
  })
  getConversations(
    @CurrentUser() user: User,
    @Query() filterDto: FilterConversationsDto,
  ) {
    return this.chatService.listConversations(user.id, filterDto);
  }

  @Get('unread')
  @ApiOperation({
    summary:
      'Unread total and per-conversation counts (stored counters, one query)',
  })
  getUnread(@CurrentUser() user: User) {
    return this.chatService.getUnread(user.id);
  }

  @Get('conversations/unread-count')
  @ApiOperation({ summary: 'Deprecated: use GET /chat/unread' })
  async getTotalUnreadCount(@CurrentUser() user: User) {
    return {
      unreadCount: await this.chatService.getTotalUnreadCount(user.id),
    };
  }

  @Get('settings')
  @ApiOperation({ summary: 'Chat privacy settings (presence)' })
  getSettings(@CurrentUser() user: User) {
    return this.chatService.getSettings(user.id);
  }

  @Patch('settings')
  @ApiOperation({ summary: 'Show or hide your online status in chat' })
  updateSettings(@CurrentUser() user: User, @Body() dto: ChatSettingsDto) {
    return this.chatService.updateChatSettings(user.id, dto.showPresence);
  }

  @Get('conversations/find')
  @ApiOperation({
    summary:
      'Find the conversation with a user (and product) without creating one',
  })
  @ApiResponse({ status: 404, description: 'No conversation yet' })
  async findConversation(
    @CurrentUser() user: User,
    @Query('participantId', ParseUUIDPipe) participantId: string,
    @Query('productId', new ParseUUIDPipe({ optional: true }))
    productId?: string,
  ) {
    const conversation = await this.chatService.findExistingConversation(
      user.id,
      participantId,
      productId,
    );
    if (!conversation) throw notFound("You haven't chatted yet.");
    return conversation;
  }

  @Get('conversations/:id')
  @ApiOperation({ summary: 'One conversation (same shape as a list item)' })
  getConversation(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.chatService.getConversation(id, user.id);
  }

  @Patch('conversations/:id')
  @ApiOperation({ summary: 'Archive / mute for you' })
  updateConversation(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ConversationSettingsDto,
  ) {
    return this.chatService.updateSettings(id, user.id, dto);
  }

  @Delete('conversations/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary:
      'Delete the chat for you only (the other person keeps it). It comes back on a new message.',
  })
  async deleteConversation(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.chatService.clearConversation(id, user.id);
  }

  // --- Messages ---

  @Get('conversations/:id/messages')
  @ApiOperation({
    summary:
      'History newest last (limit 30, beforeSeq for older) or resume with afterSeq',
  })
  getMessages(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() filterDto: FilterMessagesDto,
  ) {
    return this.chatService.getMessages(id, user.id, filterDto);
  }

  @Post('conversations/:id/messages')
  @RateLimit('messages')
  @UseGuards(EmailVerifiedGuard)
  @ApiOperation({
    summary:
      'Send { clientMessageId, text, attachments? }. Idempotent on clientMessageId (200 with the original).',
  })
  @ApiResponse({ status: 201, description: 'Message saved' })
  @ApiResponse({
    status: 200,
    description: 'Same clientMessageId as before: the original message',
  })
  async sendMessage(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SendMessageDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { message, created } = await this.chatService.sendMessage(
      id,
      user.id,
      dto,
      { via: 'http' },
    );
    res.status(created ? HttpStatus.CREATED : HttpStatus.OK);
    return message;
  }

  @Delete('conversations/:id/messages/:messageId')
  @ApiOperation({
    summary:
      'Delete for me (default) or for everyone (?for=everyone, own message within 10 minutes)',
  })
  deleteMessage(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('messageId', ParseUUIDPipe) messageId: string,
    @Query() q: DeleteMessageQueryDto,
  ) {
    return this.chatService.deleteMessage(id, messageId, user.id, q.for);
  }

  @Post('conversations/:id/messages/:messageId/report')
  @RateLimit('reports')
  @ApiOperation({ summary: 'Report a message (B4 reports queue)' })
  async reportMessage(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('messageId', ParseUUIDPipe) messageId: string,
    @Body() dto: ReportMessageDto,
  ) {
    // Same participant check as every chat route (404 otherwise).
    await this.chatService.getConversation(id, user.id);
    return this.reports.create(user, {
      targetType: 'message',
      targetId: messageId,
      reason: dto.reason as ReportReason,
      details: dto.details ?? null,
    });
  }

  // --- Read receipts ---

  @Post('conversations/:id/read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Mark read up to upToSeq (default: everything). Idempotent. Returns the new unread counts.',
  })
  markRead(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MarkReadDto,
  ) {
    return this.chatService.markRead(id, user.id, dto?.upToSeq);
  }

  @Patch('conversations/:id/read')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Deprecated: use POST …/read' })
  async markAsReadLegacy(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.chatService.markRead(id, user.id);
  }

  // --- Message search ---

  @Get('conversations/:id/messages/search')
  @ApiOperation({ summary: 'Search messages within a conversation' })
  searchMessages(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('q') searchTerm: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.chatService.searchMessages(
      id,
      user.id,
      (searchTerm || '').slice(0, 100),
      Math.max(1, Number(page) || 1),
      Math.min(50, Math.max(1, Number(limit) || 20)),
    );
  }
}
