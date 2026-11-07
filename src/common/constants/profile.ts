/** Allowed student levels. Stored exactly as written here. */
export const LEVELS = [
  '100',
  '200',
  '300',
  '400',
  '500',
  '600',
  'Postgraduate',
  'Alumnus',
] as const;
export type Level = (typeof LEVELS)[number];

/**
 * Accepts "300", "300L", "300 Level", "postgraduate"... The deployed
 * onboarding screen sends "Graduate"; we read that as Alumnus (finished their
 * degree). Remove the alias once the frontend offers "Alumnus".
 */
export function normaliseLevel(value: unknown): Level | null {
  if (typeof value === 'number') value = String(value);
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase().replace(/\s+/g, ' ');
  const numeric = /^([1-6])00\s?(l|lvl|level)?$/.exec(v);
  if (numeric) return `${numeric[1]}00` as Level;
  if (['postgraduate', 'post graduate', 'post-graduate', 'pg'].includes(v)) {
    return 'Postgraduate';
  }
  if (['alumnus', 'alumna', 'alumni', 'graduate', 'graduated'].includes(v)) {
    return 'Alumnus';
  }
  return null;
}

export const GENDERS = ['Male', 'Female', 'Prefer not to say'] as const;
export type Gender = (typeof GENDERS)[number];

export function normaliseGender(value: unknown): Gender | null {
  if (typeof value !== 'string') return null;
  const v = value
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ');
  if (v === 'male') return 'Male';
  if (v === 'female') return 'Female';
  if (v === 'prefer not to say' || v === 'prefer not say') {
    return 'Prefer not to say';
  }
  return null;
}
