#!/usr/bin/env node
/* eslint-disable */
// C1: merge duplicate conversations. DRY RUN BY DEFAULT.
//
//   npm run chat:merge-duplicates                       # dry run: prints the plan, changes nothing
//   npm run chat:merge-duplicates -- --apply            # merges (local database)
//   npm run chat:merge-duplicates -- --apply --confirm-host=<DATABASE_HOST>
//                                                       # required for any non-local host (take a backup first)
//
// A duplicate is a second conversation for the same sorted user pair and the
// same product (or both without a product). For each group the OLDEST
// conversation is kept and, in one transaction per group:
//   - every message of the others is moved into it (ids unchanged, so reports,
//     replies and "delete for me" keep working) and the merged thread is
//     renumbered 1..n by (createdAt, id);
//   - read/delivery receipts are carried over per message, then unread counts
//     are recounted; archived = all were archived, muted = any was muted;
//   - notifications pointing at a duplicate point at the kept conversation;
//   - the emptied duplicate rows are removed only after checking they hold no
//     messages. NO MESSAGE IS EVER DELETED.
// Then the unique index UQ_conversations_pair_product is created, so new
// duplicates can't appear. Writes scripts/out/merge-conversations-<ts>/merges.csv.

const {
  parseArgs,
  connect,
  dbConfig,
  isLocalHost,
  writeCsv,
  outDir,
} = require('./lib/common');
const {
  CREATE_PAIR_PRODUCT_INDEX,
} = require('../src/database/migrations/1794600000000-C1RealtimeChat');

const NO_PRODUCT = '00000000-0000-0000-0000-000000000000';

async function findGroups(client) {
  const r = await client.query(`
    SELECT "userLowId" AS lo, "userHighId" AS hi, "productId",
           array_agg(id::text ORDER BY "createdAt", id) AS ids,
           array_agg((SELECT count(*) FROM messages m WHERE m."conversationId" = c.id)::int ORDER BY "createdAt", id) AS counts
      FROM conversations c
     WHERE "userLowId" IS NOT NULL
     GROUP BY "userLowId", "userHighId", "productId", COALESCE("productId", '${NO_PRODUCT}'::uuid)
    HAVING count(*) > 1`);
  // productId and COALESCE group identically; COALESCE is listed to mirror the index.
  return r.rows.map((g) => ({ ...g, keep: g.ids[0], dups: g.ids.slice(1) }));
}

/** Conversations created by old code (no pair columns yet). */
async function backfillPairs(client) {
  const r = await client.query(`
    UPDATE conversations c SET "userLowId" = p.lo, "userHighId" = p.hi
      FROM (SELECT "conversationId", min("userId"::text)::uuid AS lo, max("userId"::text)::uuid AS hi
              FROM conversation_participants GROUP BY "conversationId" HAVING count(*) = 2) p
     WHERE p."conversationId" = c.id AND c."userLowId" IS NULL`);
  return r.rowCount;
}

async function mergeGroup(client, g) {
  const all = g.ids;
  await client.query('BEGIN');
  try {
    // Lock every conversation in the group (in id order: no deadlocks with live sends).
    await client.query(
      `SELECT id FROM conversations WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
      [all],
    );

    // Per message: was it read / delivered for each participant in its original conversation?
    await client.query(
      `
      CREATE TEMP TABLE merge_receipts ON COMMIT DROP AS
      SELECT m.id, p."userId",
             (m."senderId" = p."userId" OR m.seq <= p."lastReadSeq") AS read,
             (m."senderId" = p."userId" OR m.seq <= p."lastDeliveredSeq") AS delivered
        FROM messages m
        JOIN conversation_participants p ON p."conversationId" = m."conversationId"
       WHERE m."conversationId" = ANY($1::uuid[])`,
      [all],
    );

    // Distinct temporary (negative) seq per moved message, so nothing clashes.
    const moved = await client.query(
      `UPDATE messages m SET "conversationId" = $1::uuid, seq = -(1000000000 + s.rn)
         FROM (SELECT id, row_number() OVER (ORDER BY "createdAt", id) AS rn
                 FROM messages WHERE "conversationId" = ANY($2::uuid[])) s
        WHERE s.id = m.id RETURNING m.id`,
      [g.keep, g.dups],
    );
    // A clientMessageId can only be used once per sender and conversation.
    await client.query(
      `
      UPDATE messages m SET "clientMessageId" = NULL
       WHERE m."conversationId" = $1 AND m.seq < 0 AND m."clientMessageId" IS NOT NULL
         AND EXISTS (SELECT 1 FROM messages o WHERE o."conversationId" = $1 AND o.id <> m.id
                       AND o."senderId" = m."senderId" AND o."clientMessageId" = m."clientMessageId" AND o.seq > 0)`,
      [g.keep],
    );
    // Renumber 1..n in two steps (negative first) so the unique seq index never clashes.
    await client.query(
      `
      UPDATE messages m SET seq = -s.rn
        FROM (SELECT id, row_number() OVER (ORDER BY "createdAt", id) AS rn FROM messages WHERE "conversationId" = $1) s
       WHERE s.id = m.id`,
      [g.keep],
    );
    await client.query(
      `UPDATE messages SET seq = -seq WHERE "conversationId" = $1`,
      [g.keep],
    );

    await client.query(
      `
      UPDATE conversations c SET
        "lastSeq" = COALESCE((SELECT max(seq) FROM messages WHERE "conversationId" = c.id), 0),
        "lastMessageAt" = (SELECT max("createdAt") FROM messages WHERE "conversationId" = c.id),
        "closedAt" = COALESCE(c."closedAt", (SELECT max(d."closedAt") FROM conversations d WHERE d.id = ANY($2::uuid[]))),
        "closedReason" = COALESCE(c."closedReason", (SELECT max(d."closedReason") FROM conversations d WHERE d.id = ANY($2::uuid[])))
       WHERE c.id = $1`,
      [g.keep, g.dups],
    );

    await client.query(
      `
      UPDATE conversation_participants p SET
        "lastReadSeq" = COALESCE((SELECT max(m.seq) FROM messages m JOIN merge_receipts r ON r.id = m.id AND r."userId" = p."userId"
                                   WHERE m."conversationId" = $1 AND r.read), 0),
        "lastDeliveredSeq" = COALESCE((SELECT max(m.seq) FROM messages m JOIN merge_receipts r ON r.id = m.id AND r."userId" = p."userId"
                                   WHERE m."conversationId" = $1 AND r.delivered), 0),
        "archived" = (SELECT bool_and(o.archived) FROM conversation_participants o
                       WHERE o."conversationId" = ANY($2::uuid[]) AND o."userId" = p."userId"),
        "muted" = (SELECT bool_or(o.muted) FROM conversation_participants o
                    WHERE o."conversationId" = ANY($2::uuid[]) AND o."userId" = p."userId"),
        "clearedSeq" = NULL,
        "lastMessageAt" = COALESCE((SELECT max("createdAt") FROM messages WHERE "conversationId" = $1),
                                   (SELECT max(o."lastMessageAt") FROM conversation_participants o
                                     WHERE o."conversationId" = ANY($2::uuid[]) AND o."userId" = p."userId"))
       WHERE p."conversationId" = $1`,
      [g.keep, all],
    );
    await client.query(
      `
      UPDATE conversation_participants p SET "unreadCount" =
        (SELECT count(*) FROM messages m WHERE m."conversationId" = $1 AND m."senderId" <> p."userId"
            AND m."deletedAt" IS NULL AND m.seq > p."lastReadSeq")
       WHERE p."conversationId" = $1`,
      [g.keep],
    );

    await client.query(
      `UPDATE notifications SET metadata = jsonb_set(metadata, '{conversationId}', to_jsonb($1::text))
        WHERE metadata->>'conversationId' = ANY($2::text[])`,
      [g.keep, g.dups],
    );

    const left = await client.query(
      `SELECT count(*)::int AS n FROM messages WHERE "conversationId" = ANY($1::uuid[])`,
      [g.dups],
    );
    if (left.rows[0].n !== 0)
      throw new Error(`messages left in duplicates of ${g.keep}`);
    await client.query(`DELETE FROM conversations WHERE id = ANY($1::uuid[])`, [
      g.dups,
    ]);
    await client.query('COMMIT');
    return moved.rowCount;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  }
}

/** Returns { groups, duplicates, messagesMoved, applied }. Exported for tests. */
async function run(client, { apply = false, log = console.log } = {}) {
  if (apply) {
    const n = await backfillPairs(client);
    if (n) log(`Backfilled the user pair on ${n} conversation(s).`);
  }
  const groups = await findGroups(client);
  const duplicates = groups.reduce((a, g) => a + g.dups.length, 0);
  const pending = groups.reduce(
    (a, g) => a + g.counts.slice(1).reduce((x, y) => x + y, 0),
    0,
  );
  log(`Duplicate groups: ${groups.length}`);
  log(`Duplicate conversations to merge: ${duplicates}`);
  log(`Messages to move: ${pending}`);
  for (const g of groups.slice(0, 20)) {
    log(
      `  keep ${g.keep} <- ${g.dups.join(', ')} (product ${g.productId ?? 'none'}, messages ${g.counts.join('+')})`,
    );
  }
  if (groups.length > 20) log(`  … and ${groups.length - 20} more`);

  const rows = [];
  let messagesMoved = 0;
  if (apply) {
    for (const g of groups) {
      const moved = await mergeGroup(client, g);
      messagesMoved += moved;
      for (const d of g.dups)
        rows.push({ kept: g.keep, merged: d, productId: g.productId ?? '' });
    }
    await client.query(CREATE_PAIR_PRODUCT_INDEX);
    log(
      `Merged ${duplicates} conversation(s); moved ${messagesMoved} message(s). Unique index is in place.`,
    );
  } else {
    log('Dry run: nothing changed. Re-run with --apply to merge.');
  }
  return {
    groups: groups.length,
    duplicates,
    messagesMoved,
    applied: apply,
    rows,
  };
}

async function main() {
  const args = parseArgs();
  const apply = !!args.apply;
  const target = dbConfig(args);
  if (
    apply &&
    !isLocalHost(target.host) &&
    args['confirm-host'] !== target.host
  ) {
    console.error(
      `Refusing to --apply against non-local host ${target.host}. Take a backup, then re-run with --confirm-host=${target.host}.`,
    );
    process.exit(2);
  }
  const { client } = await connect(args);
  try {
    const res = await run(client, { apply });
    if (apply && res.rows.length) {
      const dir = outDir('merge-conversations');
      writeCsv(`${dir}/merges.csv`, res.rows, ['kept', 'merged', 'productId']);
      console.log(`Written: ${dir}/merges.csv`);
    }
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}

module.exports = { run, findGroups };
