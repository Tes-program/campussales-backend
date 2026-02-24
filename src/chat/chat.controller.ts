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
  Logger,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { ChatService } from './chat.service';
import { ChatGateway } from './chat.gateway';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';
import { CreateConversationDto } from './dto/create-conversation.dto';
import { SendMessageDto } from './dto/send-message.dto';
import { FilterConversationsDto } from './dto/filter-conversations.dto';
import { FilterMessagesDto } from './dto/filter-messages.dto';

@ApiTags('Chat')
@Controller('chat')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class ChatController {
  private readonly logger = new Logger(ChatController.name);

  constructor(
    private readonly chatService: ChatService,
    private readonly chatGateway: ChatGateway,
  ) {}

  // --- Conversations ---

  @Post('conversations')
  @ApiOperation({ summary: 'Create or get existing conversation' })
  @ApiResponse({ status: 201, description: 'Conversation created' })
  @ApiResponse({ status: 400, description: 'Invalid data' })
  async createConversation(
    @CurrentUser() user: User,
    @Body() dto: CreateConversationDto,
  ) {
    this.logger.log(
      `User ${user.id} creating conversation with ${dto.participantId}`,
    );
    return await this.chatService.createConversation(user.id, dto);
  }

  @Get('conversations')
  @ApiOperation({
    summary: 'Get user conversations with last message and unread count',
  })
  @ApiResponse({ status: 200, description: 'Conversations retrieved' })
  async getConversations(
    @CurrentUser() user: User,
    @Query() filterDto: FilterConversationsDto,
  ) {
    this.logger.log(`User ${user.id} fetching conversations`);
    return await this.chatService.getConversations(user.id, filterDto);
  }

  @Get('conversations/unread-count')
  @ApiOperation({
    summary: 'Get total unread message count across all conversations',
  })
  @ApiResponse({ status: 200, description: 'Unread count retrieved' })
  async getTotalUnreadCount(@CurrentUser() user: User) {
    const count = await this.chatService.getTotalUnreadCount(user.id);
    return { unreadCount: count };
  }

  @Get('conversations/:id')
  @ApiOperation({ summary: 'Get conversation by ID' })
  @ApiResponse({ status: 200, description: 'Conversation found' })
  @ApiResponse({ status: 404, description: 'Conversation not found' })
  @ApiResponse({ status: 403, description: 'Not a participant' })
  async getConversation(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return await this.chatService.getConversationById(id, user.id);
  }

  @Delete('conversations/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete conversation' })
  @ApiResponse({ status: 204, description: 'Conversation deleted' })
  @ApiResponse({ status: 404, description: 'Conversation not found' })
  async deleteConversation(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    this.logger.log(`User ${user.id} deleting conversation ${id}`);
    await this.chatService.deleteConversation(id, user.id);
  }

  // --- Messages ---

  @Get('conversations/:id/messages')
  @ApiOperation({
    summary:
      'Get messages in a conversation (newest first, reversed for display)',
  })
  @ApiResponse({ status: 200, description: 'Messages retrieved' })
  @ApiResponse({ status: 404, description: 'Conversation not found' })
  async getMessages(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() filterDto: FilterMessagesDto,
  ) {
    return await this.chatService.getMessages(id, user.id, filterDto);
  }

  @Post('conversations/:id/messages')
  @ApiOperation({ summary: 'Send a message in a conversation' })
  @ApiResponse({ status: 201, description: 'Message sent' })
  @ApiResponse({ status: 404, description: 'Conversation not found' })
  @ApiResponse({ status: 403, description: 'Not a participant' })
  async sendMessage(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SendMessageDto,
  ) {
    this.logger.log(`User ${user.id} sending message in conversation ${id}`);
    const message = await this.chatService.sendMessage(id, user.id, dto);

    // Also emit via WebSocket so other participants see it in real-time
    this.chatGateway.emitNewMessage(id, message);
    await this.chatGateway.emitMessageNotification(id, user.id, message);

    return message;
  }

  // --- Read receipts ---

  @Patch('conversations/:id/read')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Mark all messages in conversation as read' })
  @ApiResponse({ status: 204, description: 'Messages marked as read' })
  async markAsRead(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    this.logger.log(`User ${user.id} marking conversation ${id} as read`);
    await this.chatService.markAsRead(id, user.id);
  }
}
