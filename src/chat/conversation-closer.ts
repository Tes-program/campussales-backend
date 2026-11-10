import { DataSource } from 'typeorm';
import { appendMessage } from './message-writer';
import { MessageType } from './enums/chat.enums';
import { chatEvents } from './chat-events';
import { messageView } from './chat-views';

const SYSTEM_TEXT: Record<string, string> = {
  sold: 'This item has been sold. You can keep chatting, but the listing is closed.',
  deleted: 'This item is no longer available.',
  removed: 'This item is no longer available.',
};

/**
 * Marks every open conversation about a listing as closed and posts one
 * system message in each (with a seq, so it is delivered in real time and on
 * resume like any other message). Idempotent: already closed chats are
 * skipped. The system message is attributed to the seller (messages need a
 * sender) and has type 'system' so the UI renders it as a banner.
 */
export async function closeConversationsForProduct(
  ds: DataSource,
  productId: string,
  sellerId: string,
  reason: 'sold' | 'deleted' | 'removed',
): Promise<number> {
  const raw = await ds.query(
    `UPDATE "conversations" SET "closedAt" = now(), "closedReason" = $2
      WHERE "productId" = $1 AND "closedAt" IS NULL RETURNING "id"`,
    [productId, reason],
  );
  const rows = (Array.isArray(raw[0]) ? raw[0] : raw) as { id: string }[];
  for (const r of rows) {
    const appended = await appendMessage(ds, {
      conversationId: r.id,
      senderId: sellerId,
      content: SYSTEM_TEXT[reason],
      type: MessageType.SYSTEM,
      productId,
    });
    chatEvents.emit('message', {
      message: messageView(appended.row),
      participants: appended.participants,
      savedAt: Date.now(),
    });
  }
  return rows.length;
}
