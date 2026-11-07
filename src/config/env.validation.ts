/**
 * Fails fast on configuration that would break auth in production.
 * Called from main.ts before the app is created.
 */
export function validateEnv(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV !== 'production') return;
  const problems: string[] = [];
  const url = env.FRONTEND_URL;
  if (!url) {
    problems.push(
      'FRONTEND_URL is required (e.g. https://campus-sales.onrender.com).',
    );
  } else {
    try {
      const u = new URL(url);
      if (u.protocol !== 'https:')
        problems.push('FRONTEND_URL must use https.');
      if (u.pathname !== '/' && u.pathname !== '') {
        problems.push('FRONTEND_URL must be an origin with no path.');
      }
    } catch {
      problems.push('FRONTEND_URL is not a valid URL.');
    }
  }
  if (!env.JWT_SECRET) {
    // Without it, tokens would be signed with the code's fallback secret.
    problems.push('JWT_SECRET is required.');
  } else if (env.JWT_SECRET.length < 32) {
    console.warn(
      '[config] JWT_SECRET is shorter than 32 characters; consider rotating it.',
    );
  }
  if (env.AUTH_COOKIE_SECURE === 'false') {
    problems.push('AUTH_COOKIE_SECURE=false is not allowed in production.');
  }
  if (problems.length) {
    throw new Error(
      `Invalid production configuration:\n- ${problems.join('\n- ')}`,
    );
  }
}
