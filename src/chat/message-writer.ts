import { DataSource, EntityManager } from 'typeorm';
import { MessageAttachment } from './entities/message.entity';
import { MessageRow } from './chat-views';
import { MessageType } from './enums/chat.enums';

export interface AppendMessageInput {
  conversationId: string;
  senderId: string;
  clientMessageId?: string | null;
  content: string;
  type: MessageType;
  attachments?: MessageAttachment[];
  replyToId?: string | null;
  productId?: string | null;
  flags?: string[];
}

export interface AppendedMessage {
  row: MessageRow;
  participants: Array<{ userId: string; unreadCount: number; muted: boolean }>;
}

/**
 * Appends one message in a single statement (one round trip, atomic):
 *  1. bumps conversations.lastSeq under the row lock, so concurrent sends in
 *     one conversation get strictly increasing seq numbers in commit order
 *     (a reader resuming with afterSeq can never skip a message),
 *  2. inserts the message with that seq,
 *  3. updates every participant row: lastMessageAt (list order), +1 unread
 *     for everyone but the sender, and un-archives it for the recipients.
 * A duplicate clientMessageId fails the whole statement with 23505 on
 * UQ_messages_client_id (nothing is written, no seq is used).
 * replyToId / productId that don't exist (or belong elsewhere) become null.
 */
export async function appendMessage(
  db: DataSource | EntityManager,
  m: AppendMessageInput,
): Promise<AppendedMessage> {
  const rows = await db.query<
    Array<MessageRow & { participants: AppendedMessage['participants'] }>
  >(
    `WITH conv AS (
       UPDATE "conversations"
          SET "lastSeq" = "lastSeq" + 1,
              "lastMessageAt" = GREATEST(clock_timestamp()::timestamp, COALESCE("lastMessageAt", '-infinity')),
              "updatedAt" = now()
        WHERE id = $1
       RETURNING id, "lastSeq", "lastMessageAt"
     ), ins AS (
       INSERT INTO "messages" ("conversationId", "senderId", "seq", "clientMessageId", "content", "type", "status",
                               "attachments", "attachmentUrl", "replyToId", "productId", "flags", "createdAt")
       SELECT conv.id, $2, conv."lastSeq", $3, $4, $5, 'sent', $6::jsonb, $7,
              (SELECT r.id FROM "messages" r WHERE r.id = $8 AND r."conversationId" = $1),
              (SELECT p.id FROM "products" p WHERE p.id = $9),
              $10::jsonb, conv."lastMessageAt"
         FROM conv
       RETURNING id, "conversationId", seq, "clientMessageId", "senderId", content, type, attachments,
                 "replyToId", "productId", flags, "deletedAt", "createdAt"
     ), parts AS (
       UPDATE "conversation_participants" p
          SET "lastMessageAt" = conv."lastMessageAt",
              "unreadCount" = p."unreadCount" + CASE WHEN p."userId" = $2 THEN 0 ELSE 1 END,
              "archived" = CASE WHEN p."userId" = $2 THEN p."archived" ELSE false END
         FROM conv
        WHERE p."conversationId" = conv.id
       RETURNING p."userId", p."unreadCount", p."muted"
     )
     SELECT ins.*, (SELECT json_agg(json_build_object('userId', parts."userId", 'unreadCount', parts."unreadCount", 'muted', parts."muted"))
                      FROM parts) AS participants
       FROM ins`,
    [
      m.conversationId,
      m.senderId,
      m.clientMessageId ?? null,
      m.content,
      m.type,
      JSON.stringify(m.attachments ?? []),
      m.attachments?.[0]?.url ?? null,
      m.replyToId ?? null,
      m.productId ?? null,
      JSON.stringify(m.flags ?? []),
    ],
  );
  const raw = Array.isArray(rows[0])
    ? (rows[0] as unknown as typeof rows)
    : rows;
  const r = raw[0];
  if (!r) throw new Error('Conversation not found while appending a message');
  const { participants, ...row } = r;
  return {
    row: { ...row, seq: Number(row.seq) },
    participants: participants ?? [],
  };
}

export const isUniqueViolation = (e: unknown, constraint?: string) => {
  const err = e as {
    code?: string;
    constraint?: string;
    driverError?: { code?: string; constraint?: string };
  };
  const code = err.code ?? err.driverError?.code;
  const name = err.constraint ?? err.driverError?.constraint;
  return code === '23505' && (!constraint || name === constraint);
};
