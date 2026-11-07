#!/usr/bin/env node
/* eslint-disable */
// READ-ONLY data audit. Runs inside a READ ONLY transaction, so PostgreSQL
// itself refuses any write. Safe to run before or after the B1 migration.
//
//   node scripts/audit-data.js [--database=<name>]
//
// Prints counts and writes summary.json plus one CSV of ids per check to
// scripts/out/audit-<timestamp>/.

const path = require('path');
const fs = require('fs');
const {
  resolveCategorySlug,
  rules,
  LISTING_LIMITS: L,
  parseArgs,
  connect,
  loadProducts,
  loadUsersWithPhones,
  maskPhone,
  writeCsv,
  outDir,
} = require('./lib/common');

const PRODUCT_COLUMNS = [
  'id',
  'sellerId',
  'title',
  'price',
  'quantity',
  'imageCount',
  'status',
  'isAvailable',
  'isSold',
  'createdAt',
];
const USER_COLUMNS = ['id', 'phoneMasked', 'normalisedMasked'];

function auditProducts(products) {
  const checks = {
    price_under_50: [],
    price_has_kobo: [],
    price_over_max: [],
    quantity_under_1: [],
    quantity_over_max: [],
    no_images: [],
    too_many_images: [],
    title_empty_or_short: [],
    title_junk: [],
    suspected_test_listing: [],
    duplicate_title_and_seller: [],
    sold_but_available: [],
  };

  const groups = new Map();
  for (const p of products) {
    const price = Number(p.price);
    if (price < L.priceMin) checks.price_under_50.push(p);
    if (!Number.isInteger(price)) checks.price_has_kobo.push(p);
    if (price > L.priceMax) checks.price_over_max.push(p);
    if (p.quantity < L.quantityMin) checks.quantity_under_1.push(p);
    if (p.quantity > L.quantityMax) checks.quantity_over_max.push(p);
    if (p.imageCount < L.imagesMin) checks.no_images.push(p);
    if (p.imageCount > L.imagesMax) checks.too_many_images.push(p);

    const title = typeof p.title === 'string' ? p.title.trim() : '';
    if (rules.charLength(title) < L.titleMin)
      checks.title_empty_or_short.push(p);
    else if (rules.isJunkTitle(p.title)) checks.title_junk.push(p);
    if (rules.maybeTestListing(p.title)) checks.suspected_test_listing.push(p);
    if (p.isSold && p.isAvailable) checks.sold_but_available.push(p);

    const key = `${p.sellerId}|${title.toLowerCase().replace(/\s+/g, ' ')}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  for (const list of groups.values()) {
    if (list.length > 1) checks.duplicate_title_and_seller.push(...list);
  }
  return checks;
}

function auditUsers(users) {
  const checks = {
    users_invalid_phone: [],
    users_phone_not_normalised: [],
    users_duplicate_phone: [],
  };
  const byNumber = new Map();
  for (const u of users) {
    const normalised = rules.normaliseNigerianPhone(u.phoneNumber);
    const row = {
      id: u.id,
      phoneMasked: maskPhone(u.phoneNumber),
      normalisedMasked: maskPhone(normalised),
    };
    if (!normalised) {
      checks.users_invalid_phone.push(row);
      continue;
    }
    if (normalised !== u.phoneNumber)
      checks.users_phone_not_normalised.push(row);
    if (!byNumber.has(normalised)) byNumber.set(normalised, []);
    byNumber.get(normalised).push(row);
  }
  for (const list of byNumber.values()) {
    if (list.length > 1) checks.users_duplicate_phone.push(...list);
  }
  return checks;
}

async function main() {
  const args = parseArgs();
  const { client, cfg } = await connect(args);
  try {
    await client.query('BEGIN TRANSACTION READ ONLY');
    const {
      rows: products,
      hasStatus,
      hasDeletedAt,
    } = await loadProducts(client);
    const users = await loadUsersWithPhones(client);
    const categories = (
      await client.query(
        `SELECT c."id", c."slug", c."name", c."isActive",
                (SELECT count(*)::int FROM "products" p WHERE p."categoryId" = c."id") AS "productCount"
           FROM "categories" c ORDER BY c."slug"`,
      )
    ).rows;
    await client.query('ROLLBACK');

    const productChecks = auditProducts(products);
    const userChecks = auditUsers(users);

    const dir = outDir('audit');
    const summary = {
      database: `${cfg.host}/${cfg.database}`,
      ranAt: new Date().toISOString(),
      schema: {
        productsHaveStatus: hasStatus,
        productsHaveDeletedAt: hasDeletedAt,
      },
      totals: { liveProducts: products.length, usersWithPhone: users.length },
      counts: {},
    };

    console.log('\nCheck                              Count');
    console.log('---------------------------------  -----');
    for (const [name, rows] of Object.entries(productChecks)) {
      summary.counts[name] = rows.length;
      writeCsv(path.join(dir, `${name}.csv`), rows, PRODUCT_COLUMNS);
      console.log(`${name.padEnd(33)}  ${String(rows.length).padStart(5)}`);
    }
    for (const [name, rows] of Object.entries(userChecks)) {
      summary.counts[name] = rows.length;
      writeCsv(path.join(dir, `${name}.csv`), rows, USER_COLUMNS);
      console.log(`${name.padEnd(33)}  ${String(rows.length).padStart(5)}`);
    }
    // Categories the API will not accept (not in src/common/constants/categories.ts,
    // neither as a slug nor an alias). Listings in them can't be edited until moved.
    const unknownCategories = categories.filter(
      (c) => !resolveCategorySlug(c.slug),
    );
    summary.counts.categories_outside_shared_list = unknownCategories.length;
    writeCsv(
      path.join(dir, 'categories_outside_shared_list.csv'),
      unknownCategories,
      ['id', 'slug', 'name', 'isActive', 'productCount'],
    );
    console.log(
      `${'categories_outside_shared_list'.padEnd(33)}  ${String(unknownCategories.length).padStart(5)}`,
    );
    for (const c of unknownCategories)
      console.log(`    ${c.slug} ("${c.name}", ${c.productCount} listings)`);

    fs.writeFileSync(
      path.join(dir, 'summary.json'),
      JSON.stringify(summary, null, 2) + '\n',
    );

    console.log(
      `\nLive products: ${products.length}. Users with a phone: ${users.length}.`,
    );
    if (productChecks.suspected_test_listing.length) {
      console.log(
        '\nSuspected test listings (ask the owner before deleting anything):',
      );
      for (const p of productChecks.suspected_test_listing)
        console.log(`  ${p.id}  "${p.title}"`);
    }
    console.log(`\nReport written to ${dir}`);
    console.log('No data was modified (READ ONLY transaction).');
  } finally {
    await client.end();
  }
}

module.exports = { auditProducts, auditUsers };

if (require.main === module) {
  main().catch((e) => {
    console.error('Audit failed:', e.message);
    process.exit(1);
  });
}
