/* eslint-disable */
// Shared helpers for scripts/audit-data.js and scripts/fix-data.js.
//
// Connection: uses the same DATABASE_HOST / PORT / USERNAME / PASSWORD / NAME
// variables as the API (from the environment, then .env). DATABASE_URL is
// deliberately ignored so a stray production URL in .env is never picked up.
// Override the database with --database=<name>.

const path = require('path');
const fs = require('fs');

require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

// Load the API's own validation rules (TypeScript) so scripts and API agree.
require('ts-node').register({
  transpileOnly: true,
  compilerOptions: {
    module: 'commonjs',
    moduleResolution: 'node',
    resolvePackageJsonExports: false,
  },
});
const rules = require('../../src/common/validation/rules');
const { LISTING_LIMITS } = require('../../src/common/constants/listing');
const {
  resolveCategorySlug,
} = require('../../src/common/constants/categories');

const { Client } = require('pg');

function parseArgs(argv = process.argv.slice(2)) {
  const args = {};
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (m) args[m[1]] = m[2] === undefined ? true : m[2];
  }
  return args;
}

function dbConfig(args) {
  return {
    host: process.env.DATABASE_HOST || 'localhost',
    port: parseInt(process.env.DATABASE_PORT || '5432', 10),
    user: process.env.DATABASE_USERNAME || 'postgres',
    password: process.env.DATABASE_PASSWORD || '',
    database: args.database || process.env.DATABASE_NAME || 'campussales',
    ssl:
      process.env.NODE_ENV === 'production'
        ? { rejectUnauthorized: false }
        : false,
  };
}

const isLocalHost = (h) => ['localhost', '127.0.0.1', '::1'].includes(h);

async function connect(args) {
  const cfg = dbConfig(args);
  console.log(`Target database: ${cfg.host}:${cfg.port}/${cfg.database}`);
  const client = new Client(cfg);
  await client.connect();
  return { client, cfg };
}

async function columnExists(client, table, column) {
  const r = await client.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2`,
    [table, column],
  );
  return r.rowCount > 0;
}

async function loadProducts(client) {
  const hasDeletedAt = await columnExists(client, 'products', 'deletedAt');
  const hasStatus = await columnExists(client, 'products', 'status');
  const hasIsSold = await columnExists(client, 'products', 'isSold');
  const r = await client.query(`
    SELECT p."id", p."sellerId", p."title", p."description",
           p."price"::text AS price, p."quantity", p."isAvailable",
           ${hasIsSold ? 'p."isSold"' : 'false AS "isSold"'},
           ${hasStatus ? 'p."status"' : 'NULL AS status'},
           p."createdAt",
           (SELECT count(*)::int FROM "product_images" i WHERE i."productId" = p."id") AS "imageCount"
      FROM "products" p
     ${hasDeletedAt ? 'WHERE p."deletedAt" IS NULL' : ''}
     ORDER BY p."createdAt"`);
  return { rows: r.rows, hasStatus, hasDeletedAt };
}

async function loadUsersWithPhones(client) {
  const r = await client.query(
    `SELECT "id", "phoneNumber" FROM "users" WHERE "phoneNumber" IS NOT NULL AND "phoneNumber" <> ''`,
  );
  return r.rows;
}

function maskPhone(p) {
  if (!p) return '';
  const s = String(p);
  return s.length <= 6
    ? '***'
    : `${s.slice(0, 4)}${'*'.repeat(s.length - 6)}${s.slice(-2)}`;
}

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = v instanceof Date ? v.toISOString() : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function writeCsv(file, rows, columns) {
  const lines = [columns.join(',')];
  for (const r of rows) lines.push(columns.map((c) => csvCell(r[c])).join(','));
  fs.writeFileSync(file, lines.join('\n') + '\n');
}

function outDir(prefix) {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\..+/, '')
    .replace('T', '-');
  const dir = path.join(__dirname, '..', 'out', `${prefix}-${stamp}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

module.exports = {
  resolveCategorySlug,
  dbConfig,
  rules,
  LISTING_LIMITS,
  parseArgs,
  connect,
  isLocalHost,
  columnExists,
  loadProducts,
  loadUsersWithPhones,
  maskPhone,
  writeCsv,
  outDir,
};
