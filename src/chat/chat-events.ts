import { EventEmitter } from 'events';
import type { MessageView } from './chat-views';

/**
 * In-process bus between the chat writers (ChatService, the listing closer)
 * and the socket gateway, so writers never depend on the gateway. The gateway
 * turns these into socket events (through the Redis adapter when there is
 * more than one instance).
 */
export interface ChatMessageEvent {
  message: MessageView;
  /** Every participant, with their unread count after this message. */
  participants: Array<{ userId: string; unreadCount: number; muted: boolean }>;
  /** When the message was saved (ms epoch), for delivery latency. */
  savedAt: number;
}

export interface ChatStatusEvent {
  conversationId: string;
  /** Who should hear about it (the sender of the messages). */
  toUserId: string;
  /** Who delivered/read. */
  byUserId: string;
  upToSeq: number;
  status: 'delivered' | 'read';
}

export interface ChatUnreadEvent {
  userId: string;
  conversationId: string;
  unreadCount: number;
  total: number;
}

export interface ChatMessageUpdatedEvent {
  userIds: string[];
  message: MessageView;
}

export interface ChatEventMap {
  message: [ChatMessageEvent];
  status: [ChatStatusEvent];
  unread: [ChatUnreadEvent];
  'message-updated': [ChatMessageUpdatedEvent];
}

class ChatEvents extends EventEmitter<ChatEventMap> {}

export const chatEvents = new ChatEvents();
chatEvents.setMaxListeners(20);
