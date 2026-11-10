import { Conversation } from './entities/conversation.entity';
import { MessageAttachment } from './entities/message.entity';
import { User } from '../users/entities/user.entity';
import { MessageType } from './enums/chat.enums';

/** Public view of a chat participant: never email or phone. */
export function publicUser(u?: User | null) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    profile: u.profile
      ? {
          firstName: u.profile.firstName,
          lastName: u.profile.lastName,
          profilePictureUrl: u.profile.profilePictureUrl ?? null,
        }
      : null,
  };
}

export type PublicUser = NonNullable<ReturnType<typeof publicUser>>;

export const iso = (d?: Date | string | null) =>
  d ? new Date(d).toISOString() : null;

export function listingContext(c: {
  productId?: string | null;
  productTitle?: string | null;
  productImageUrl?: string | null;
  productPrice?: number | null;
}) {
  return c.productId
    ? {
        productId: c.productId,
        title: c.productTitle ?? null,
        coverImageUrl: c.productImageUrl ?? null,
        priceAtStart: c.productPrice ?? null,
      }
    : null;
}

/** Single conversation (create / get). */
export function conversationView(c: Conversation, viewerId: string) {
  const other = c.participants?.find((p) => p.userId !== viewerId);
  const me = c.participants?.find((p) => p.userId === viewerId);
  return {
    id: c.id,
    type: c.type,
    participants: (c.participants ?? []).map((p) => ({
      userId: p.userId,
      lastReadAt: iso(p.lastReadAt),
      lastReadSeq: p.lastReadSeq ?? 0,
      lastDeliveredSeq: p.lastDeliveredSeq ?? 0,
      user: publicUser(p.user),
    })),
    otherUser: publicUser(other?.user),
    listing: listingContext(c),
    lastSeq: c.lastSeq ?? 0,
    unreadCount: me?.unreadCount ?? 0,
    archived: me?.archived ?? false,
    muted: me?.muted ?? false,
    closed: !!c.closedAt,
    closedAt: iso(c.closedAt),
    closedReason: c.closedReason ?? null,
    createdAt: iso(c.createdAt),
    updatedAt: iso(c.lastMessageAt ?? c.createdAt),
  };
}

export type MessageStatusValue = 'sent' | 'delivered' | 'read';

/** Raw message row as the chat queries select it. */
export interface MessageRow {
  id: string;
  conversationId: string;
  seq: number | string;
  clientMessageId: string | null;
  senderId: string;
  content: string;
  type: MessageType;
  attachments: MessageAttachment[] | null;
  attachmentUrl?: string | null;
  replyToId?: string | null;
  productId?: string | null;
  flags: string[] | null;
  deletedAt: Date | string | null;
  createdAt: Date | string;
  hidden?: boolean;
}

export interface MessageViewContext {
  viewerId?: string;
  /** The other participant's receipts (for the viewer's own messages). */
  otherReadSeq?: number;
  otherDeliveredSeq?: number;
  /** The viewer's own read pointer (for messages they received). */
  myReadSeq?: number;
  users?: Map<string, PublicUser | null>;
  products?: Map<string, LegacyProduct>;
  replies?: Map<string, MessageRow>;
}

export interface LegacyProduct {
  id: string;
  title: string;
  price: number;
  images: { id: string; imageUrl: string; isPrimary: boolean }[];
}

export const DELETED_TEXT = 'Message deleted';

export function messageStatus(
  seq: number,
  senderId: string,
  ctx: MessageViewContext,
): MessageStatusValue {
  if (!ctx.viewerId) return 'sent';
  if (senderId === ctx.viewerId) {
    if (seq <= (ctx.otherReadSeq ?? 0)) return 'read';
    if (seq <= (ctx.otherDeliveredSeq ?? 0)) return 'delivered';
    return 'sent';
  }
  return seq <= (ctx.myReadSeq ?? 0) ? 'read' : 'delivered';
}

/**
 * Message as the API and sockets return it. `text`, `seq`, `status`,
 * `deleted` and `deletedForMe` are the C1 contract; `content`, `sender`,
 * `attachmentUrl`, `replyTo`, `product` are kept for one release.
 * Deleted messages never carry their text.
 */
export function messageView(m: MessageRow, ctx: MessageViewContext = {}) {
  const seq = Number(m.seq);
  const deleted = !!m.deletedAt;
  const hidden = !!m.hidden;
  const gone = deleted || hidden;
  const attachments = gone ? [] : (m.attachments ?? []);
  const reply = m.replyToId ? ctx.replies?.get(m.replyToId) : undefined;
  return {
    id: m.id,
    conversationId: m.conversationId,
    seq,
    clientMessageId: m.clientMessageId ?? null,
    senderId: m.senderId,
    type: m.type,
    text: gone ? null : m.content,
    attachments,
    status: messageStatus(seq, m.senderId, ctx),
    deleted,
    deletedForMe: hidden,
    /** True when the message looks like a common scam pattern; show a safety tip. */
    safetyTip: !gone && (m.flags ?? []).length > 0,
    createdAt: iso(m.createdAt),
    // ── legacy (one release) ──
    content: deleted ? DELETED_TEXT : hidden ? '' : m.content,
    attachmentUrl: attachments[0]?.url ?? null,
    sender: ctx.users?.get(m.senderId) ?? null,
    replyToId: m.replyToId ?? null,
    replyTo: reply
      ? {
          id: reply.id,
          content: reply.deletedAt ? DELETED_TEXT : reply.content,
          senderId: reply.senderId,
          type: reply.type,
        }
      : null,
    productId: m.productId ?? null,
    product: (m.productId && ctx.products?.get(m.productId)) || null,
  };
}

export type MessageView = ReturnType<typeof messageView>;
