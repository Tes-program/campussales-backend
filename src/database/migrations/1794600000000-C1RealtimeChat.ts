import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * C1: real-time, reliable chat.
 *
 * conversations
 *   - userLowId / userHighId: the participant pair, sorted, so "one
 *     conversation per (pair, product)" can be a unique index.
 *   - lastSeq: per-conversation message counter (allocated under the row lock).
 *   - lastMessageAt: when the last message was sent (the list's sort key).
 * conversation_participants (the per-user view of a conversation)
 *   - unreadCount: incremented on send, recomputed on read (no scans).
 *   - lastReadSeq / lastDeliveredSeq: read and delivery receipts.
 *   - lastMessageAt: copy of the conversation's, so the list is one index range.
 *   - archived, muted, clearedSeq ("delete chat" for me only).
 * messages
 *   - seq (unique per conversation), clientMessageId (idempotent send),
 *     attachments (jsonb), deletedAt (sender deleted it for everyone).
 * message_hides: "delete for me" (per user, the message stays for the other).
 * push_subscriptions: Web Push endpoints (behind CHAT_WEB_PUSH).
 * users.chatPresenceVisible: whether others may see online / last active.
 *
 * The unique (pair, product) index is skipped with a warning if duplicate
 * conversations already exist. Run `npm run chat:merge-duplicates` (dry run)
 * then `npm run chat:merge-duplicates -- --apply`, which merges them without
 * deleting a single message and then creates the index.
 */
export class C1RealtimeChat1794600000000 implements MigrationInterface {
  name = 'C1RealtimeChat1794600000000';

  public async up(q: QueryRunner): Promise<void> {
    const add = (table: string, col: string, type: string) =>
      q.query(
        `ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "${col}" ${type}`,
      );

    // ── conversations ────────────────────────────────────────────────
    await add('conversations', 'userLowId', 'uuid NULL');
    await add('conversations', 'userHighId', 'uuid NULL');
    await add('conversations', 'lastSeq', 'bigint NOT NULL DEFAULT 0');
    await add('conversations', 'lastMessageAt', 'TIMESTAMP NULL');

    // ── conversation_participants ────────────────────────────────────
    await add(
      'conversation_participants',
      'unreadCount',
      'integer NOT NULL DEFAULT 0',
    );
    await add(
      'conversation_participants',
      'lastReadSeq',
      'bigint NOT NULL DEFAULT 0',
    );
    await add(
      'conversation_participants',
      'lastDeliveredSeq',
      'bigint NOT NULL DEFAULT 0',
    );
    await add('conversation_participants', 'lastMessageAt', 'TIMESTAMP NULL');
    await add(
      'conversation_participants',
      'archived',
      'boolean NOT NULL DEFAULT false',
    );
    await add(
      'conversation_participants',
      'muted',
      'boolean NOT NULL DEFAULT false',
    );
    await add('conversation_participants', 'clearedSeq', 'bigint NULL');

    // ── messages ─────────────────────────────────────────────────────
    await add('messages', 'seq', 'bigint NULL');
    await add('messages', 'clientMessageId', 'varchar(64) NULL');
    await add('messages', 'attachments', `jsonb NOT NULL DEFAULT '[]'`);
    await add('messages', 'deletedAt', 'TIMESTAMP NULL');

    // ── users ────────────────────────────────────────────────────────
    await add('users', 'chatPresenceVisible', 'boolean NOT NULL DEFAULT true');

    // ── backfill ─────────────────────────────────────────────────────
    // Sequence numbers in creation order (ties broken by id, stable).
    await q.query(`
      UPDATE "messages" m SET "seq" = s.rn
        FROM (SELECT id, row_number() OVER (PARTITION BY "conversationId" ORDER BY "createdAt", id) AS rn
                FROM "messages") s
       WHERE s.id = m.id AND m."seq" IS NULL`);
    await q.query(`ALTER TABLE "messages" ALTER COLUMN "seq" SET NOT NULL`);
    // Old attachmentUrl values become one-item attachment lists.
    await q.query(`
      UPDATE "messages" SET "attachments" = jsonb_build_array(jsonb_build_object('url', "attachmentUrl"))
       WHERE "attachmentUrl" IS NOT NULL AND "attachmentUrl" <> '' AND "attachments" = '[]'::jsonb`);

    await q.query(`
      UPDATE "conversations" c SET "lastSeq" = s.max_seq, "lastMessageAt" = s.last_at
        FROM (SELECT "conversationId", max("seq") AS max_seq, max("createdAt") AS last_at
                FROM "messages" GROUP BY "conversationId") s
       WHERE s."conversationId" = c.id`);

    // The sorted pair, only for real 1:1 conversations.
    await q.query(`
      UPDATE "conversations" c SET "userLowId" = p.lo, "userHighId" = p.hi
        FROM (SELECT "conversationId", min("userId"::text)::uuid AS lo, max("userId"::text)::uuid AS hi
                FROM "conversation_participants" GROUP BY "conversationId" HAVING count(*) = 2) p
       WHERE p."conversationId" = c.id AND c."userLowId" IS NULL`);

    // Receipts from the old lastReadAt timestamps and message statuses.
    await q.query(`
      UPDATE "conversation_participants" cp SET
        "lastMessageAt" = COALESCE(c."lastMessageAt", c."createdAt"),
        "lastReadSeq" = COALESCE((SELECT max(m."seq") FROM "messages" m
                                   WHERE m."conversationId" = cp."conversationId"
                                     AND (m."senderId" = cp."userId" OR (cp."lastReadAt" IS NOT NULL AND m."createdAt" <= cp."lastReadAt"))), 0)
        FROM "conversations" c WHERE c.id = cp."conversationId"`);
    await q.query(`
      UPDATE "conversation_participants" cp SET
        "lastDeliveredSeq" = GREATEST(cp."lastReadSeq", COALESCE((SELECT max(m."seq") FROM "messages" m
                                   WHERE m."conversationId" = cp."conversationId" AND m."senderId" <> cp."userId"
                                     AND m."status" IN ('delivered', 'read')), 0)),
        "unreadCount" = (SELECT count(*) FROM "messages" m
                          WHERE m."conversationId" = cp."conversationId" AND m."senderId" <> cp."userId"
                            AND m."seq" > cp."lastReadSeq")`);

    // ── tables ───────────────────────────────────────────────────────
    await q.query(`
      CREATE TABLE IF NOT EXISTS "message_hides" (
        "userId" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "messageId" uuid NOT NULL REFERENCES "messages"("id") ON DELETE CASCADE,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        PRIMARY KEY ("userId", "messageId")
      )`);
    await q.query(`
      CREATE TABLE IF NOT EXISTS "push_subscriptions" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "userId" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "endpoint" text NOT NULL,
        "p256dh" varchar(255) NOT NULL,
        "auth" varchar(255) NOT NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "lastUsedAt" TIMESTAMP NULL
      )`);
    await q.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_push_subscriptions_endpoint" ON "push_subscriptions" (md5("endpoint"))`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_push_subscriptions_user" ON "push_subscriptions" ("userId")`,
    );

    // ── indexes ──────────────────────────────────────────────────────
    // History, resume (afterSeq) and the list's last-message lookup.
    await q.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_messages_conversation_seq" ON "messages" ("conversationId", "seq" DESC)`,
    );
    // Idempotent send. Per sender, so two people can never collide.
    await q.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_messages_client_id" ON "messages" ("conversationId", "senderId", "clientMessageId") WHERE "clientMessageId" IS NOT NULL`,
    );
    // Superseded by the seq index.
    await q.query(`DROP INDEX IF EXISTS "IDX_messages_conversation_created"`);
    // The conversation list: one index range per user, newest first.
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_conv_participants_user_last" ON "conversation_participants" ("userId", "lastMessageAt" DESC, "conversationId" DESC)`,
    );
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_conversations_pair" ON "conversations" ("userLowId", "userHighId")`,
    );

    const [dupes] = await q.query(`
      SELECT count(*)::int AS n FROM (
        SELECT 1 FROM "conversations" WHERE "userLowId" IS NOT NULL
         GROUP BY "userLowId", "userHighId", COALESCE("productId", '00000000-0000-0000-0000-000000000000'::uuid)
        HAVING count(*) > 1) d`);
    if (Number(dupes?.n ?? 0) > 0) {
      console.warn(
        `[C1] ${dupes.n} duplicate conversation groups; skipped UQ_conversations_pair_product. Run: npm run chat:merge-duplicates -- --apply`,
      );
    } else {
      await q.query(CREATE_PAIR_PRODUCT_INDEX);
    }
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "UQ_conversations_pair_product"`);
    await q.query(`DROP INDEX IF EXISTS "IDX_conversations_pair"`);
    await q.query(`DROP INDEX IF EXISTS "IDX_conv_participants_user_last"`);
    await q.query(`DROP INDEX IF EXISTS "UQ_messages_client_id"`);
    await q.query(`DROP INDEX IF EXISTS "UQ_messages_conversation_seq"`);
    await q.query(
      `CREATE INDEX IF NOT EXISTS "IDX_messages_conversation_created" ON "messages" ("conversationId", "createdAt")`,
    );
    await q.query(`DROP TABLE IF EXISTS "push_subscriptions"`);
    await q.query(`DROP TABLE IF EXISTS "message_hides"`);
    const drop = (t: string, c: string) =>
      q.query(`ALTER TABLE "${t}" DROP COLUMN IF EXISTS "${c}"`);
    await drop('users', 'chatPresenceVisible');
    for (const c of ['seq', 'clientMessageId', 'attachments', 'deletedAt'])
      await drop('messages', c);
    for (const c of [
      'unreadCount',
      'lastReadSeq',
      'lastDeliveredSeq',
      'lastMessageAt',
      'archived',
      'muted',
      'clearedSeq',
    ])
      await drop('conversation_participants', c);
    for (const c of ['userLowId', 'userHighId', 'lastSeq', 'lastMessageAt'])
      await drop('conversations', c);
  }
}

/** One conversation per (sorted pair, product); one general (null product) per pair. */
export const CREATE_PAIR_PRODUCT_INDEX = `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_conversations_pair_product" ON "conversations" ("userLowId", "userHighId", COALESCE("productId", '00000000-0000-0000-0000-000000000000'::uuid)) WHERE "userLowId" IS NOT NULL`;
