import { DataSource } from 'typeorm';

const SYSTEM_TEXT: Record<string, string> = {
  sold: 'This item has been sold. You can keep chatting, but the listing is closed.',
  deleted: 'This item is no longer available.',
  removed: 'This item is no longer available.',
};

/**
 * Marks every open conversation about a listing as closed and posts one
 * system message in each. Idempotent (already closed chats are skipped).
 * The system message is attributed to the seller (messages need a sender)
 * and has type 'system' so the UI renders it as a banner.
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
    await ds.query(
      `INSERT INTO "messages" ("conversationId", "senderId", "content", "type", "status", "productId")
       VALUES ($1, $2, $3, 'system', 'sent', $4)`,
      [r.id, sellerId, SYSTEM_TEXT[reason], productId],
    );
  }
  return rows.length;
}
