/**
 * Feature flags the frontend reads from GET /api/bootstrap. Defaults live
 * here; FEATURE_FLAGS (JSON, e.g. {"signedUploads":false}) overrides them per
 * environment without a deploy of the frontend. Only booleans; unknown keys
 * in FEATURE_FLAGS are ignored so a typo can't invent a flag.
 */
export const DEFAULT_FLAGS = {
  /** Frontend F5: load the first screen from /api/bootstrap. */
  bootstrap: true,
  /** Direct-to-Cloudinary signed uploads (POST /api/uploads/sign). */
  signedUploads: true,
  /** POST /api/events product analytics. */
  analytics: true,
  /** Typo-tolerant search with didYouMean. */
  searchSuggestions: true,
} as const;

export type FeatureFlags = {
  -readonly [K in keyof typeof DEFAULT_FLAGS]: boolean;
};

export function featureFlags(
  raw: string | undefined = process.env.FEATURE_FLAGS,
): FeatureFlags {
  const flags: FeatureFlags = { ...DEFAULT_FLAGS };
  if (!raw) return flags;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const key of Object.keys(DEFAULT_FLAGS) as (keyof FeatureFlags)[]) {
      if (typeof parsed[key] === 'boolean') flags[key] = parsed[key];
    }
  } catch {
    // invalid JSON: keep defaults (env validation warns at startup)
  }
  return flags;
}
