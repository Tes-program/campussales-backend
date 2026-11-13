#!/usr/bin/env node
/* eslint-disable */
// READ-ONLY image audit. Lists every product image URL of live listings and
// checks that its file exists (uploads folder or Cloudinary), then reports:
//   missing         the file is gone
//   too_small       under 400x300 (either orientation)
//   extreme_aspect  wider than 2:1 or taller than 1:2
//
//   node scripts/audit-uploads.js [--database=<name>] [--uploads-dir=./uploads]
//        [--local-hosts=api.example.com,old-host.example.com] [--cloudinary=off]
//
// Database reads run in a READ ONLY transaction; files are only opened for
// reading; Cloudinary is only queried (Admin API listing/lookup, no writes).
// Writes images.csv (one row per image, `issues` empty when fine) and
// summary.json to scripts/out/uploads-audit-<timestamp>/.

const path = require('path');
const fs = require('fs');
const { parseArgs, connect, writeCsv, outDir } = require('./lib/common');
const {
  CSV_COLUMNS,
  loadProductImages,
  checkImages,
  summarise,
} = require('./lib/image-checks');

async function main() {
  const args = parseArgs();
  const { client, cfg } = await connect(args);
  let rows;
  try {
    await client.query('BEGIN TRANSACTION READ ONLY');
    ({ rows } = await loadProductImages(client));
    await client.query('ROLLBACK');
  } finally {
    await client.end();
  }

  const { results, uploadsDir, uploadsDirExists, cloudNote } =
    await checkImages(rows, {
      uploadsDir: args['uploads-dir'],
      localHosts: args['local-hosts']
        ? String(args['local-hosts']).split(',')
        : [],
      cloudinary: args.cloudinary === 'off' ? 'off' : 'auto',
      log: (m) => console.log(m),
    });
  const summary = summarise(results);

  const dir = outDir('uploads-audit');
  writeCsv(path.join(dir, 'images.csv'), results, CSV_COLUMNS);
  fs.writeFileSync(
    path.join(dir, 'summary.json'),
    JSON.stringify(
      {
        database: `${cfg.host}/${cfg.database}`,
        ranAt: new Date().toISOString(),
        uploadsDir,
        uploadsDirExists,
        cloudinary: cloudNote || 'checked',
        ...summary,
      },
      null,
      2,
    ) + '\n',
  );

  console.log(
    `\nImages: ${summary.images} on ${summary.listings} live listing(s) ` +
      `(local ${summary.byStorage.local}, Cloudinary ${summary.byStorage.cloudinary}, other ${summary.byStorage.other})`,
  );
  console.log('\nCheck                 Count');
  console.log('--------------------  -----');
  for (const [name, n] of [
    ['missing', summary.missing],
    ['too_small', summary.tooSmall],
    ['extreme_aspect', summary.extremeAspect],
    ['unchecked', summary.unchecked],
    ['marked_unavailable', summary.alreadyMarkedUnavailable],
  ])
    console.log(`${name.padEnd(20)}  ${String(n).padStart(5)}`);
  if (!uploadsDirExists && summary.byStorage.local)
    console.log(
      `\nWarning: uploads folder ${uploadsDir} not found, so local images were not checked. Pass --uploads-dir.`,
    );
  if (cloudNote && summary.byStorage.cloudinary)
    console.log(`\nCloudinary images not checked: ${cloudNote}.`);
  console.log(`\nReport written to ${path.join(dir, 'images.csv')}`);
  console.log('No data was modified (read-only audit).');
}

if (require.main === module) {
  main().catch((e) => {
    console.error('Upload audit failed:', e.message);
    process.exit(1);
  });
}
