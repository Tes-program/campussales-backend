/**
 * The one source of truth for the current Terms and Privacy Policy versions.
 * Bump these (ISO date of the change) whenever the legal pages change; sign-up
 * then rejects older versions with TERMS_VERSION_MISMATCH until the client
 * shows the new text. Clients read them from GET /api/legal/versions.
 */
export const TERMS_VERSION = '2026-11-01';
export const PRIVACY_VERSION = '2026-11-01';

export interface LegalVersions {
  termsVersion: string;
  privacyVersion: string;
  termsUrl: string;
  privacyUrl: string;
}

/** `frontendBase` is FRONTEND_URL without a trailing slash. */
export function legalVersions(frontendBase: string): LegalVersions {
  return {
    termsVersion: TERMS_VERSION,
    privacyVersion: PRIVACY_VERSION,
    termsUrl: `${frontendBase}/terms`,
    privacyUrl: `${frontendBase}/privacy`,
  };
}
