/** Process-wide flags shared by main.ts (signals) and the health routes. */
export const lifecycle = {
  /** Set on SIGTERM: /health/ready starts failing so the host stops routing to us. */
  draining: false,
  startedAt: Date.now(),
};
