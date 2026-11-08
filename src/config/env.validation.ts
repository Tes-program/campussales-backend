/**
 * Startup configuration check (B2, extended in B5). In production every
 * problem is collected and reported together, so a deploy fails once with
 * the full list of what is missing instead of one variable at a time.
 * Recommended-but-optional settings are printed as warnings.
 *
 * Called from main.ts before the app is created. Values are never printed.
 */
const POSITIVE_INT = [
  'DB_POOL_MAX',
  'DB_STATEMENT_TIMEOUT_MS',
  'DB_CONNECTION_TIMEOUT_MS',
  'REQUEST_TIMEOUT_MS',
  'SHUTDOWN_GRACE_MS',
];

export function envProblems(env: NodeJS.ProcessEnv = process.env): {
  errors: string[];
  warnings: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];
  const missing = (name: string, hint: string) =>
    !env[name] && errors.push(`${name} is required (${hint}).`);

  const url = env.FRONTEND_URL;
  if (!url) {
    errors.push(
      'FRONTEND_URL is required (e.g. https://campus-sales.onrender.com).',
    );
  } else {
    try {
      const u = new URL(url);
      if (u.protocol !== 'https:') errors.push('FRONTEND_URL must use https.');
      if (u.pathname !== '/' && u.pathname !== '') {
        errors.push('FRONTEND_URL must be an origin with no path.');
      }
    } catch {
      errors.push('FRONTEND_URL is not a valid URL.');
    }
  }
  if (!env.JWT_SECRET) {
    // Without it, tokens would be signed with the code's fallback secret.
    errors.push('JWT_SECRET is required.');
  } else if (env.JWT_SECRET.length < 32) {
    warnings.push(
      'JWT_SECRET is shorter than 32 characters; consider rotating it.',
    );
  }
  if (env.AUTH_COOKIE_SECURE === 'false') {
    errors.push('AUTH_COOKIE_SECURE=false is not allowed in production.');
  }

  missing('DATABASE_HOST', 'Railway Postgres host');
  missing('DATABASE_NAME', 'database name');
  missing('DATABASE_USERNAME', 'database user');
  missing('DATABASE_PASSWORD', 'database password');

  if ((env.STORAGE_TYPE || 'local') === 'cloudinary') {
    missing('CLOUDINARY_CLOUD_NAME', 'STORAGE_TYPE=cloudinary');
    missing('CLOUDINARY_API_KEY', 'STORAGE_TYPE=cloudinary');
    missing('CLOUDINARY_API_SECRET', 'STORAGE_TYPE=cloudinary');
  } else {
    warnings.push(
      'STORAGE_TYPE is not cloudinary: signed direct uploads (POST /api/uploads/sign) are unavailable.',
    );
  }

  for (const name of POSITIVE_INT) {
    if (env[name] !== undefined) {
      const n = Number(env[name]);
      if (!Number.isInteger(n) || n <= 0)
        errors.push(`${name} must be a positive whole number.`);
    }
  }
  if (env.FEATURE_FLAGS) {
    try {
      const v: unknown = JSON.parse(env.FEATURE_FLAGS);
      if (!v || typeof v !== 'object' || Array.isArray(v))
        errors.push('FEATURE_FLAGS must be a JSON object.');
    } catch {
      errors.push('FEATURE_FLAGS is not valid JSON.');
    }
  }
  if (
    env.UPLOAD_CLEANUP_MODE &&
    !['dry-run', 'delete', 'off'].includes(env.UPLOAD_CLEANUP_MODE)
  ) {
    errors.push('UPLOAD_CLEANUP_MODE must be dry-run, delete or off.');
  }
  if (env.ALERT_WEBHOOK_URL) {
    try {
      if (new URL(env.ALERT_WEBHOOK_URL).protocol !== 'https:')
        errors.push('ALERT_WEBHOOK_URL must use https.');
    } catch {
      errors.push('ALERT_WEBHOOK_URL is not a valid URL.');
    }
  }

  const recommend = (name: string, why: string) =>
    !env[name] && warnings.push(`${name} is not set: ${why}.`);
  recommend('CORS_ORIGIN', 'only localhost origins are allowed outside dev');
  recommend('REDIS_HOST', 'rate limits fall back to per-instance memory');
  recommend('ADMIN_API_KEY', 'admin routes are disabled');
  if (!env.ALERT_WEBHOOK_URL && !env.ALERT_EMAIL && !env.ADMIN_ALERT_EMAIL)
    warnings.push(
      'No ALERT_WEBHOOK_URL / ALERT_EMAIL / ADMIN_ALERT_EMAIL: alerts are only logged.',
    );
  recommend(
    'LOG_HASH_SALT',
    'user ids in logs are hashed with JWT_SECRET instead of a dedicated salt',
  );
  return { errors, warnings };
}

export function validateEnv(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV !== 'production') return;
  const { errors, warnings } = envProblems(env);
  for (const w of warnings) console.warn(`[config] ${w}`);
  if (errors.length) {
    throw new Error(
      `Invalid production configuration:\n- ${errors.join('\n- ')}`,
    );
  }
}
