import { Conversation } from './entities/conversation.entity';
import { Message } from './entities/message.entity';
import { User } from '../users/entities/user.entity';

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

const iso = (d?: Date | null) => (d ? new Date(d).toISOString() : null);

export function listingContext(c: Conversation) {
  return c.productId
    ? {
        productId: c.productId,
        title: c.productTitle ?? null,
        coverImageUrl: c.productImageUrl ?? null,
        priceAtStart: c.productPrice ?? null,
      }
    : null;
}

export function conversationView(c: Conversation, viewerId: string) {
  const other = c.participants?.find((p) => p.userId !== viewerId);
  return {
    id: c.id,
    type: c.type,
    participants: (c.participants ?? []).map((p) => ({
      userId: p.userId,
      lastReadAt: iso(p.lastReadAt),
      user: publicUser(p.user),
    })),
    otherUser: publicUser(other?.user),
    listing: listingContext(c),
    closed: !!c.closedAt,
    closedAt: iso(c.closedAt),
    closedReason: c.closedReason ?? null,
    createdAt: iso(c.createdAt),
    updatedAt: iso(c.updatedAt),
  };
}

export function messageView(m: Message) {
  return {
    id: m.id,
    conversationId: m.conversationId,
    senderId: m.senderId,
    sender: publicUser(m.sender),
    content: m.content,
    type: m.type,
    status: m.status,
    attachmentUrl: m.attachmentUrl ?? null,
    replyToId: m.replyToId ?? null,
    replyTo: m.replyTo
      ? {
          id: m.replyTo.id,
          content: m.replyTo.content,
          senderId: m.replyTo.senderId,
          type: m.replyTo.type,
        }
      : null,
    productId: m.productId ?? null,
    product: m.product
      ? {
          id: m.product.id,
          title: m.product.title,
          price: Number(m.product.price),
          images: (m.product.images ?? []).map((i) => ({
            id: i.id,
            imageUrl: i.imageUrl,
            isPrimary: i.isPrimary,
          })),
        }
      : null,
    /** True when the message looks like a common scam pattern; show a safety tip. */
    safetyTip: (m.flags ?? []).length > 0,
    createdAt: iso(m.createdAt),
  };
}

export type MessageView = ReturnType<typeof messageView>;
