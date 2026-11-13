/* eslint-disable */
// Shared by scripts/audit-uploads.js (read-only report) and
// scripts/mark-missing-images.js (marks missing photos, tells sellers).
//
// Every product image URL is sorted into one of:
//   local       <BACKEND_URL>/uploads/<file> (or /uploads/<file>): the file is
//               looked up in the uploads folder and its size read from the header
//   cloudinary  res.cloudinary.com/<our cloud>/...: looked up with the
//               Cloudinary Admin API (read-only listing + lookups)
//   other       anything else (another Cloudinary account, external hosts):
//               reported but not checked
//
// `exists` is 'yes', 'no' or 'unknown'. Only 'no' means the file is missing;
// 'unknown' (Cloudinary not configured, lookup failed) is never treated as
// missing.

const fs = require('fs');
const path = require('path');
// common.js registers ts-node, so the API's own TypeScript rules load here.
const { columnExists } = require('./common');
const {
  imageSize,
  IMAGE_HEADER_BYTES,
} = require('../../src/uploads/image-size');
const {
  isTooSmall,
  isExtremeAspect,
  UPLOAD_RULES,
} = require('../../src/uploads/upload-rules');
const { parseCloudinaryUrl } = require('../../src/uploads/cloudinary-url');

const CSV_COLUMNS = [
  'productId',
  'sellerId',
  'productTitle',
  'productStatus',
  'imageId',
  'imageUrl',
  'storage',
  'exists',
  'width',
  'height',
  'aspectRatio',
  'issues',
  'markedUnavailableAt',
  'note',
];

/** Live (not deleted) listings' images, oldest listing first. */
async function loadProductImages(client) {
  const hasUnavailable = await columnExists(
    client,
    'product_images',
    'unavailableAt',
  );
  const hasDeletedAt = await columnExists(client, 'products', 'deletedAt');
  const hasStatus = await columnExists(client, 'products', 'status');
  const r = await client.query(`
    SELECT i."id" AS "imageId", i."productId", i."imageUrl", i."publicId",
           ${hasUnavailable ? 'i."unavailableAt"' : 'NULL::timestamptz AS "unavailableAt"'},
           p."sellerId", p."title" AS "productTitle",
           ${hasStatus ? 'p."status"' : 'NULL'} AS "productStatus"
      FROM "product_images" i
      JOIN "products" p ON p."id" = i."productId"
     ${hasDeletedAt ? 'WHERE p."deletedAt" IS NULL' : ''}
     ORDER BY p."createdAt", i."sortOrder"`);
  return { rows: r.rows, hasUnavailable };
}

function localHostSet(extra) {
  const hosts = new Set(['localhost', '127.0.0.1', '[::1]']);
  for (const u of [process.env.BACKEND_URL, ...(extra || [])]) {
    if (!u) continue;
    try {
      hosts.add(new URL(u.includes('://') ? u : `http://${u}`).hostname);
    } catch {
      hosts.add(u);
    }
  }
  return hosts;
}

/** { storage, file?, publicId?, cloudName? } for one URL. */
function classifyUrl(url, { localHosts, cloudName }) {
  const raw = String(url || '').trim();
  let pathname = null;
  if (raw.startsWith('/uploads/')) pathname = raw;
  else {
    try {
      const u = new URL(raw);
      if (u.hostname === 'res.cloudinary.com') {
        const ref = parseCloudinaryUrl(raw);
        if (ref && cloudName && ref.cloudName === cloudName)
          return { storage: 'cloudinary', publicId: ref.publicId };
        return {
          storage: 'other',
          note: ref
            ? `Cloudinary account "${ref.cloudName}" is not ours (${cloudName || 'CLOUDINARY_CLOUD_NAME not set'})`
            : 'Unrecognised Cloudinary URL',
        };
      }
      if (localHosts.has(u.hostname)) pathname = u.pathname;
    } catch {
      return { storage: 'other', note: 'Not a valid URL' };
    }
  }
  const m = pathname && /^\/uploads\/([^/]+)$/.exec(pathname);
  if (m) {
    const file = decodeURIComponent(m[1]);
    // Never look outside the uploads folder.
    if (/^[\w.-]+$/.test(file) && !file.startsWith('.'))
      return { storage: 'local', file };
    return { storage: 'other', note: 'Unsafe file name' };
  }
  return { storage: 'other', note: 'External host, not checked' };
}

function readLocal(uploadsDir, file) {
  const full = path.join(uploadsDir, file);
  let fd;
  try {
    fd = fs.openSync(full, 'r');
  } catch (e) {
    if (e.code === 'ENOENT') return { exists: 'no' };
    return {
      exists: 'unknown',
      note: `Could not open: ${e.code || e.message}`,
    };
  }
  try {
    const buf = Buffer.alloc(IMAGE_HEADER_BYTES);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const size = imageSize(buf.subarray(0, n));
    return size
      ? { exists: 'yes', width: size.width, height: size.height }
      : { exists: 'yes', note: 'Could not read the image size' };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Read-only Cloudinary lookups. Lists every image under the prefixes our
 * public ids use (500 per call), then looks up the rest one by one.
 * Pass `api` to replace the Cloudinary SDK (tests).
 */
function cloudinaryLookup({ api, prefixes, maxSingleLookups = 400 } = {}) {
  let sdk = api;
  if (!sdk) {
    const { v2 } = require('cloudinary');
    v2.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
      secure: true,
    });
    sdk = v2.api;
  }
  const known = new Map();
  const listed = new Set();
  let singles = 0;

  async function listPrefix(prefix) {
    let cursor;
    do {
      const r = await sdk.resources({
        type: 'upload',
        resource_type: 'image',
        prefix,
        max_results: 500,
        ...(cursor ? { next_cursor: cursor } : {}),
      });
      for (const x of r.resources || [])
        known.set(x.public_id, { width: x.width, height: x.height });
      cursor = r.next_cursor;
    } while (cursor);
    listed.add(prefix);
  }

  return {
    async prepare(publicIds) {
      const wanted = new Set(
        (prefixes || ['campussales/']).filter((p) =>
          publicIds.some((id) => id.startsWith(p)),
        ),
      );
      for (const p of wanted) await listPrefix(p);
    },
    async check(publicId) {
      if (known.has(publicId)) return { exists: 'yes', ...known.get(publicId) };
      if ([...listed].some((p) => publicId.startsWith(p)))
        return { exists: 'no' };
      if (singles >= maxSingleLookups)
        return {
          exists: 'unknown',
          note: 'Skipped: Admin API lookup budget used up',
        };
      singles++;
      try {
        const x = await sdk.resource(publicId, { resource_type: 'image' });
        known.set(publicId, { width: x.width, height: x.height });
        return { exists: 'yes', width: x.width, height: x.height };
      } catch (e) {
        if (e && e.error && e.error.http_code === 404) return { exists: 'no' };
        return {
          exists: 'unknown',
          note: `Cloudinary lookup failed: ${(e && (e.error?.message || e.message)) || e}`,
        };
      }
    },
  };
}

function cloudinaryConfigured() {
  return !!(
    process.env.CLOUDINARY_CLOUD_NAME &&
    process.env.CLOUDINARY_API_KEY &&
    process.env.CLOUDINARY_API_SECRET
  );
}

/** Size/shape problems for a file that exists. */
function issuesFor(result) {
  const issues = [];
  if (result.exists === 'no') issues.push('missing');
  if (result.width && result.height) {
    if (isTooSmall(result.width, result.height)) issues.push('too_small');
    if (isExtremeAspect(result.width, result.height))
      issues.push('extreme_aspect');
  }
  return issues;
}

/**
 * Checks every image. Options:
 *   uploadsDir   local uploads folder (default ./uploads)
 *   localHosts   extra hosts whose /uploads/<file> URLs are local
 *   cloudinary   'auto' (default: on when configured) | 'off' | a lookup object
 *   log          progress logger
 */
async function checkImages(rows, opts = {}) {
  const uploadsDir = path.resolve(opts.uploadsDir || 'uploads');
  const localHosts = localHostSet(opts.localHosts);
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME || null;
  const log = opts.log || (() => undefined);
  const uploadsDirExists = fs.existsSync(uploadsDir);

  let cloud = null;
  let cloudNote = null;
  if (opts.cloudinary && typeof opts.cloudinary === 'object')
    cloud = opts.cloudinary;
  else if (opts.cloudinary === 'off') cloudNote = 'Cloudinary check turned off';
  else if (!cloudinaryConfigured())
    cloudNote = 'Cloudinary credentials not set';
  else cloud = cloudinaryLookup();

  const classified = rows.map((r) => ({
    row: r,
    where: classifyUrl(r.imageUrl, { localHosts, cloudName }),
  }));
  const cloudIds = classified
    .filter((c) => c.where.storage === 'cloudinary')
    .map((c) => c.row.publicId || c.where.publicId);
  if (cloud && cloudIds.length) {
    log(`Listing ${cloudIds.length} Cloudinary image(s)...`);
    try {
      await cloud.prepare(cloudIds);
    } catch (e) {
      cloudNote = `Cloudinary listing failed: ${e.error?.message || e.message}`;
      cloud = null;
    }
  }

  const out = [];
  for (const { row, where } of classified) {
    let result;
    if (where.storage === 'local') {
      result = uploadsDirExists
        ? readLocal(uploadsDir, where.file)
        : {
            exists: 'unknown',
            note: `Uploads folder not found: ${uploadsDir}`,
          };
    } else if (where.storage === 'cloudinary') {
      result = cloud
        ? await cloud.check(row.publicId || where.publicId)
        : { exists: 'unknown', note: cloudNote };
    } else {
      result = { exists: 'unknown', note: where.note };
    }
    const issues = issuesFor(result);
    const ratio =
      result.width && result.height
        ? (result.width / result.height).toFixed(2)
        : '';
    out.push({
      ...row,
      storage: where.storage,
      exists: result.exists,
      width: result.width ?? '',
      height: result.height ?? '',
      aspectRatio: ratio,
      issues: issues.join(';'),
      issueList: issues,
      markedUnavailableAt: row.unavailableAt || '',
      note: result.note || '',
    });
  }
  return { results: out, uploadsDir, uploadsDirExists, cloudNote };
}

function summarise(results) {
  const count = (f) => results.filter(f).length;
  return {
    images: results.length,
    listings: new Set(results.map((r) => r.productId)).size,
    byStorage: {
      local: count((r) => r.storage === 'local'),
      cloudinary: count((r) => r.storage === 'cloudinary'),
      other: count((r) => r.storage === 'other'),
    },
    missing: count((r) => r.issueList.includes('missing')),
    tooSmall: count((r) => r.issueList.includes('too_small')),
    extremeAspect: count((r) => r.issueList.includes('extreme_aspect')),
    unchecked: count((r) => r.exists === 'unknown'),
    alreadyMarkedUnavailable: count((r) => !!r.unavailableAt),
  };
}

module.exports = {
  CSV_COLUMNS,
  UPLOAD_RULES,
  loadProductImages,
  classifyUrl,
  localHostSet,
  cloudinaryLookup,
  checkImages,
  summarise,
};
