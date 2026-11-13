#!/usr/bin/env node
/* eslint-disable */
// Marks product photos whose file is missing as unavailable and tells each
// seller in the app. DRY RUN BY DEFAULT. Never deletes a listing or an image.
//
//   node scripts/mark-missing-images.js                # dry run: prints the plan
//   node scripts/mark-missing-images.js --apply        # local database
//   node scripts/mark-missing-images.js --apply --confirm-host=<DATABASE_HOST>
//                                                      # required for any non-local host
// Same checks and options as scripts/audit-uploads.js (--uploads-dir,
// --local-hosts, --cloudinary=off).
//
// With --apply, in one transaction:
//   1. product_images."unavailableAt" = now() for every photo whose file is
//      confirmed missing (exists = no; "unknown" is never marked). The API then
//      returns it with `unavailable: true`, ordered last.
//   2. one in-app notification per affected listing to its seller (type
//      "listing", linked to the listing) asking for new photos. A listing is
//      only notified for photos newly marked, so re-running sends nothing new.
//   3. photos marked earlier whose file is back are un-marked.
// Safety: refuses when more than half of the checked photos look missing
// (usually a wrong --uploads-dir or Cloudinary account) unless --allow-mass.
// Every change goes to scripts/out/missing-images-<timestamp>/changes.csv.

const path = require('path');
const fs = require('fs');
const {
  parseArgs,
  connect,
  dbConfig,
  isLocalHost,
  columnExists,
  writeCsv,
  outDir,
} = require('./lib/common');
const { loadProductImages, checkImages } = require('./lib/image-checks');

function notificationFor(listing) {
  const n = listing.images.length;
  const all = listing.remainingWorking === 0;
  const photos = n === 1 ? '1 photo' : `${n} photos`;
  return {
    title: 'Add new photos to your listing',
    body: all
      ? `We couldn't load the photos on "${listing.title}". Your listing is still up, but buyers can't see what you're selling. Add new photos to fix it.`
      : `We couldn't load ${photos} on "${listing.title}". Your listing is still up. Replace the missing ${n === 1 ? 'photo' : 'photos'} so buyers see everything.`,
    metadata: {
      productId: listing.productId,
      reason: 'images_unavailable',
      imageIds: listing.images.map((i) => i.imageId),
    },
  };
}

/** Groups newly missing photos by listing (pure; exported for tests). */
function plan(results) {
  const toMark = results.filter((r) => r.exists === 'no' && !r.unavailableAt);
  const toRestore = results.filter(
    (r) => r.exists === 'yes' && !!r.unavailableAt,
  );
  const listings = new Map();
  for (const r of toMark) {
    if (!listings.has(r.productId))
      listings.set(r.productId, {
        productId: r.productId,
        sellerId: r.sellerId,
        title: r.productTitle,
        images: [],
      });
    listings.get(r.productId).images.push(r);
  }
  for (const l of listings.values()) {
    l.remainingWorking = results.filter(
      (r) =>
        r.productId === l.productId &&
        r.exists !== 'no' &&
        !(r.unavailableAt && r.exists !== 'yes'),
    ).length;
  }
  const checked = results.filter((r) => r.exists !== 'unknown').length;
  const missing = results.filter((r) => r.exists === 'no').length;
  return {
    toMark,
    toRestore,
    listings: [...listings.values()],
    checked,
    missing,
  };
}

async function main() {
  const args = parseArgs();
  const apply = args.apply === true;
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
    if (!(await columnExists(client, 'product_images', 'unavailableAt'))) {
      console.error(
        'product_images."unavailableAt" does not exist. Run the migrations first (npm run migration:run).',
      );
      process.exit(2);
    }
    await client.query('BEGIN TRANSACTION READ ONLY');
    const { rows } = await loadProductImages(client);
    await client.query('ROLLBACK');

    const { results, uploadsDir, uploadsDirExists, cloudNote } =
      await checkImages(rows, {
        uploadsDir: args['uploads-dir'],
        localHosts: args['local-hosts']
          ? String(args['local-hosts']).split(',')
          : [],
        cloudinary: args.cloudinary === 'off' ? 'off' : 'auto',
        log: (m) => console.log(m),
      });
    const p = plan(results);

    if (!uploadsDirExists && results.some((r) => r.storage === 'local'))
      console.log(
        `Note: uploads folder ${uploadsDir} not found; local photos were not checked (never marked).`,
      );
    if (cloudNote && results.some((r) => r.storage === 'cloudinary'))
      console.log(
        `Note: Cloudinary photos not checked (${cloudNote}); never marked.`,
      );

    console.log(
      `\n${apply ? 'APPLYING' : 'DRY RUN'}: ${p.toMark.length} photo(s) on ${p.listings.length} listing(s) to mark unavailable, ${p.toRestore.length} to restore`,
    );
    for (const l of p.listings)
      console.log(
        `  ${l.productId}  "${l.title}"  ${l.images.length} missing${l.remainingWorking === 0 ? ' (no working photos left)' : ''}  -> notify seller ${l.sellerId}`,
      );
    for (const r of p.toRestore)
      console.log(`  restore ${r.imageId} on ${r.productId} (file is back)`);

    if (
      apply &&
      p.checked > 0 &&
      p.missing >= 5 &&
      p.missing / p.checked > 0.5 &&
      args['allow-mass'] !== true
    ) {
      console.error(
        `\nRefusing: ${p.missing} of ${p.checked} checked photos look missing. Check --uploads-dir and the Cloudinary account, or re-run with --allow-mass.`,
      );
      process.exit(2);
    }

    const changes = [];
    if (apply && (p.toMark.length || p.toRestore.length)) {
      await client.query('BEGIN');
      try {
        if (p.toMark.length) {
          await client.query(
            `UPDATE "product_images" SET "unavailableAt" = now()
              WHERE "id" = ANY($1::uuid[]) AND "unavailableAt" IS NULL`,
            [p.toMark.map((r) => r.imageId)],
          );
        }
        for (const l of p.listings) {
          const n = notificationFor(l);
          await client.query(
            `INSERT INTO "notifications" ("userId", "type", "title", "body", "metadata")
             VALUES ($1, 'listing', $2, $3, $4)`,
            [l.sellerId, n.title, n.body, JSON.stringify(n.metadata)],
          );
        }
        if (p.toRestore.length) {
          await client.query(
            `UPDATE "product_images" SET "unavailableAt" = NULL WHERE "id" = ANY($1::uuid[])`,
            [p.toRestore.map((r) => r.imageId)],
          );
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      }
    }
    for (const r of p.toMark)
      changes.push({ action: 'mark_unavailable', ...r });
    for (const r of p.toRestore) changes.push({ action: 'restore', ...r });

    const dir = outDir(apply ? 'missing-images' : 'missing-images-dryrun');
    writeCsv(path.join(dir, 'changes.csv'), changes, [
      'action',
      'productId',
      'sellerId',
      'productTitle',
      'imageId',
      'imageUrl',
      'storage',
      'note',
    ]);
    fs.writeFileSync(
      path.join(dir, 'summary.json'),
      JSON.stringify(
        {
          apply,
          ranAt: new Date().toISOString(),
          marked: p.toMark.length,
          restored: p.toRestore.length,
          listingsNotified: apply ? p.listings.length : 0,
        },
        null,
        2,
      ) + '\n',
    );
    console.log(`\nChanges written to ${path.join(dir, 'changes.csv')}`);
    console.log(
      apply
        ? `Done: marked ${p.toMark.length} photo(s), notified ${p.listings.length} seller listing(s), restored ${p.toRestore.length}. No listing was deleted.`
        : '\nDry run only: nothing was changed. Re-run with --apply to make these changes.',
    );
  } finally {
    await client.end();
  }
}

module.exports = { plan, notificationFor };

if (require.main === module) {
  main().catch((e) => {
    console.error('Marking missing images failed:', e.message);
    process.exit(1);
  });
}
