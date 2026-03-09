import {
  MigrationInterface,
  QueryRunner,
  TableColumn,
  TableForeignKey,
} from 'typeorm';

export class MoveProductToMessages1695000015000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Add productId column to messages table
    await queryRunner.addColumn(
      'messages',
      new TableColumn({
        name: 'productId',
        type: 'uuid',
        isNullable: true,
      }),
    );

    // 2. Add foreign key for productId on messages
    await queryRunner.createForeignKey(
      'messages',
      new TableForeignKey({
        name: 'FK_messages_productId',
        columnNames: ['productId'],
        referencedColumnNames: ['id'],
        referencedTableName: 'products',
        onDelete: 'SET NULL',
      }),
    );

    // 3. Migrate: For each conversation that has a productId,
    //    set productId on the FIRST message of that conversation
    await queryRunner.query(`
      UPDATE messages m
      SET "productId" = c."productId"
      FROM conversations c
      WHERE m."conversationId" = c.id
        AND c."productId" IS NOT NULL
        AND m.id = (
          SELECT id FROM messages
          WHERE "conversationId" = c.id
          ORDER BY "createdAt" ASC
          LIMIT 1
        )
    `);

    // 4. Merge duplicate conversations between the same user pair.
    //    For each pair of users with multiple conversations, pick the earliest
    //    as the "primary" and reassign all messages from duplicates to the primary,
    //    then delete the empty duplicate conversations.
    await queryRunner.query(`
      WITH user_pairs AS (
        -- For each conversation, get the two participant user IDs in canonical order
        SELECT
          c.id AS conversation_id,
          LEAST(p1."userId", p2."userId") AS user_a,
          GREATEST(p1."userId", p2."userId") AS user_b,
          c."createdAt"
        FROM conversations c
        INNER JOIN conversation_participants p1 ON p1."conversationId" = c.id
        INNER JOIN conversation_participants p2 ON p2."conversationId" = c.id
          AND p2."userId" > p1."userId"
      ),
      primary_conversations AS (
        -- For each user pair, find the earliest conversation (the primary one)
        SELECT DISTINCT ON (user_a, user_b)
          conversation_id AS primary_id,
          user_a,
          user_b
        FROM user_pairs
        ORDER BY user_a, user_b, "createdAt" ASC
      ),
      duplicates AS (
        -- All conversations that are NOT the primary for their user pair
        SELECT up.conversation_id AS dup_id, pc.primary_id
        FROM user_pairs up
        INNER JOIN primary_conversations pc ON pc.user_a = up.user_a AND pc.user_b = up.user_b
        WHERE up.conversation_id != pc.primary_id
      )
      -- Reassign messages from duplicate conversations to the primary
      UPDATE messages m
      SET "conversationId" = d.primary_id
      FROM duplicates d
      WHERE m."conversationId" = d.dup_id
    `);

    // Delete the now-empty duplicate conversations (cascade deletes participants)
    await queryRunner.query(`
      WITH user_pairs AS (
        SELECT
          c.id AS conversation_id,
          LEAST(p1."userId", p2."userId") AS user_a,
          GREATEST(p1."userId", p2."userId") AS user_b,
          c."createdAt"
        FROM conversations c
        INNER JOIN conversation_participants p1 ON p1."conversationId" = c.id
        INNER JOIN conversation_participants p2 ON p2."conversationId" = c.id
          AND p2."userId" > p1."userId"
      ),
      primary_conversations AS (
        SELECT DISTINCT ON (user_a, user_b)
          conversation_id AS primary_id,
          user_a,
          user_b
        FROM user_pairs
        ORDER BY user_a, user_b, "createdAt" ASC
      ),
      duplicates AS (
        SELECT up.conversation_id AS dup_id
        FROM user_pairs up
        INNER JOIN primary_conversations pc ON pc.user_a = up.user_a AND pc.user_b = up.user_b
        WHERE up.conversation_id != pc.primary_id
      )
      DELETE FROM conversations WHERE id IN (SELECT dup_id FROM duplicates)
    `);

    // 5. Drop the productId foreign key from conversations
    const conversationsTable = await queryRunner.getTable('conversations');
    const productFk = conversationsTable?.foreignKeys.find(
      (fk) => fk.columnNames.indexOf('productId') !== -1,
    );
    if (productFk) {
      await queryRunner.dropForeignKey('conversations', productFk);
    }

    // 6. Drop the productId column from conversations
    await queryRunner.dropColumn('conversations', 'productId');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 1. Re-add productId column to conversations
    await queryRunner.addColumn(
      'conversations',
      new TableColumn({
        name: 'productId',
        type: 'uuid',
        isNullable: true,
      }),
    );

    await queryRunner.createForeignKey(
      'conversations',
      new TableForeignKey({
        columnNames: ['productId'],
        referencedColumnNames: ['id'],
        referencedTableName: 'products',
        onDelete: 'SET NULL',
      }),
    );

    // 2. Drop productId foreign key from messages
    const messagesTable = await queryRunner.getTable('messages');
    const productFk = messagesTable?.foreignKeys.find(
      (fk) => fk.columnNames.indexOf('productId') !== -1,
    );
    if (productFk) {
      await queryRunner.dropForeignKey('messages', productFk);
    }

    // 3. Drop productId column from messages
    await queryRunner.dropColumn('messages', 'productId');
  }
}
