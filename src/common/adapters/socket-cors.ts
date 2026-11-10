/**
 * Socket.IO CORS: the same origins as the HTTP API (CORS_ORIGIN, plus local
 * dev servers outside production). Read at handshake time, so it follows the
 * environment without a rebuild.
 */
export function socketCorsOrigin(
  origin: string | undefined,
  cb: (err: Error | null, allow?: boolean) => void,
): void {
  const configured = (process.env.CORS_ORIGIN || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  const dev =
    process.env.NODE_ENV === 'production'
      ? []
      : [
          'http://localhost:5173',
          'http://localhost:4173',
          'http://localhost:3000',
          'http://localhost:3001',
        ];
  // Native apps and server-side clients send no Origin.
  cb(null, !origin || [...configured, ...dev].includes(origin));
}
