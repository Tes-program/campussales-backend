#!/usr/bin/env node
/* eslint-disable */
// Data clean-up for B1. DRY RUN BY DEFAULT.
//
//   node scripts/fix-data.js                      # dry run: prints the plan, changes nothing
//   node scripts/fix-data.js --apply              # applies the plan (local database)
//   node scripts/fix-data.js --apply --confirm-host=<DATABASE_HOST>
//                                                 # required for any non-local host
//
// What it does (never deletes a row):
//   1. quantity < 1                                 -> quantity = 1
//   2. active/inactive listings with an invalid price, no images or a junk
//      title (incl. obvious test titles such as "QA Test")
//                                                   -> status = needs_review, isAvailable = false
//                                                      (hidden from the feed; the seller can fix
//                                                       and re-activate it)
//   3. phone numbers that parse as Nigerian mobiles -> normalised to +234XXXXXXXXXX
//      (numbers that don't parse are left alone and reported)
//
// Requires the B1 migration (products.status) to have run first.
// Every change is written to scripts/out/fix-<timestamp>/changes.csv with the
// old value, so it can be reversed by hand.

const path = require('path');
const fs = require('fs');
const {
  dbConfig,
  rules,
  parseArgs,
  connect,
  isLocalHost,
  columnExists,
  loadProducts,
  loadUsersWithPhones,
  maskPhone,
  writeCsv,
  outDir,
} = require('./lib/common');

function planChanges(products, users) {
  const changes = [];
  for (const p of products) {
    if (p.quantity < 1) {
      changes.push({
        table: 'products',
        id: p.id,
        field: 'quantity',
        oldValue: p.quantity,
        newValue: 1,
        reason: 'quantity under 1',
      });
    }
    if (p.status === 'active' || p.status === 'inactive') {
      const reasons = [];
      if (rules.validatePrice(Number(p.price)))
        reasons.push(`invalid price (${p.price})`);
      if (p.imageCount < 1) reasons.push('no images');
      if (rules.isJunkTitle(p.title)) reasons.push('junk title');
      if (reasons.length) {
        changes.push({
          table: 'products',
          id: p.id,
          field: 'status',
          oldValue: p.status,
          newValue: 'needs_review',
          reason: reasons.join('; '),
          title: p.title,
        });
      }
    }
  }
  const unparseable = [];
  for (const u of users) {
    const normalised = rules.normaliseNigerianPhone(u.phoneNumber);
    if (!normalised) {
      unparseable.push({ id: u.id, phoneMasked: maskPhone(u.phoneNumber) });
    } else if (normalised !== u.phoneNumber) {
      changes.push({
        table: 'users',
        id: u.id,
        field: 'phoneNumber',
        oldValue: u.phoneNumber,
        newValue: normalised,
        reason: 'normalise phone',
      });
    }
  }
  return { changes, unparseable };
}

async function applyChange(client, c) {
  // Each UPDATE re-checks the old value so a row changed in the meantime is skipped.
  let r;
  if (c.table === 'products' && c.field === 'quantity') {
    r = await client.query(
      `UPDATE "products" SET "quantity" = 1 WHERE "id" = $1 AND "quantity" < 1`,
      [c.id],
    );
  } else if (c.table === 'products' && c.field === 'status') {
    r = await client.query(
      `UPDATE "products" SET "status" = 'needs_review', "isAvailable" = false
        WHERE "id" = $1 AND "status" = $2 AND "deletedAt" IS NULL`,
      [c.id, c.oldValue],
    );
  } else if (c.table === 'users' && c.field === 'phoneNumber') {
    r = await client.query(
      `UPDATE "users" SET "phoneNumber" = $2 WHERE "id" = $1 AND "phoneNumber" = $3`,
      [c.id, c.newValue, c.oldValue],
    );
  } else {
    throw new Error(`Unknown change ${c.table}.${c.field}`);
  }
  return r.rowCount;
}

async function main() {
  const args = parseArgs();
  const apply = args.apply === true;
  const target = dbConfig(args);

  // Checked before connecting, so nothing touches a remote database by accident.
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

  const { client, cfg } = await connect(args);

  try {
    if (!(await columnExists(client, 'products', 'status'))) {
      console.error(
        'products.status is missing. Run the B1 migration first (npm run migration:run).',
      );
      process.exit(2);
    }

    await client.query(apply ? 'BEGIN' : 'BEGIN TRANSACTION READ ONLY');
    const { rows: products } = await loadProducts(client);
    const users = await loadUsersWithPhones(client);
    const { changes, unparseable } = planChanges(products, users);

    const dir = outDir(apply ? 'fix' : 'fix-dryrun');
    const printable = changes.map((c) => ({
      ...c,
      oldValue: c.field === 'phoneNumber' ? maskPhone(c.oldValue) : c.oldValue,
      newValue: c.field === 'phoneNumber' ? maskPhone(c.newValue) : c.newValue,
    }));

    console.log(
      `\n${apply ? 'APPLYING' : 'DRY RUN'}: ${changes.length} change(s) planned`,
    );
    for (const c of printable) {
      console.log(
        `  ${c.table}.${c.field}  ${c.id}  ${c.oldValue} -> ${c.newValue}  (${c.reason}${c.title ? `; "${c.title}"` : ''})`,
      );
    }
    if (unparseable.length) {
      console.log(
        `\n${unparseable.length} phone number(s) could not be parsed and were left unchanged (see unparseable_phones.csv).`,
      );
    }

    let applied = 0;
    if (apply) {
      for (const c of changes) applied += await applyChange(client, c);
      await client.query('COMMIT');
      // The real old values are kept here so changes can be reversed.
      writeCsv(path.join(dir, 'changes.csv'), changes, [
        'table',
        'id',
        'field',
        'oldValue',
        'newValue',
        'reason',
      ]);
    } else {
      await client.query('ROLLBACK');
      writeCsv(path.join(dir, 'plan.csv'), printable, [
        'table',
        'id',
        'field',
        'oldValue',
        'newValue',
        'reason',
        'title',
      ]);
    }
    writeCsv(path.join(dir, 'unparseable_phones.csv'), unparseable, [
      'id',
      'phoneMasked',
    ]);
    fs.writeFileSync(
      path.join(dir, 'summary.json'),
      JSON.stringify(
        {
          database: `${cfg.host}/${cfg.database}`,
          apply,
          planned: changes.length,
          applied,
          unparseablePhones: unparseable.length,
        },
        null,
        2,
      ) + '\n',
    );

    console.log(
      apply
        ? `\nApplied ${applied} of ${changes.length} change(s).`
        : '\nDry run only: nothing was changed. Re-run with --apply to make these changes.',
    );
    console.log(`Details written to ${dir}`);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    await client.end();
  }
}

module.exports = { planChanges };

if (require.main === module) {
  main().catch((e) => {
    console.error('fix-data failed:', e.message);
    process.exit(1);
  });
}
