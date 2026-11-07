/**
 * Pure validation + normalisation rules shared by DTOs, services, tests and the
 * data scripts in /scripts. Each validator returns a student-facing message or
 * null when the value is fine. No Nest or TypeORM imports here on purpose.
 */
import { MSG } from '../errors/messages';
import { CATEGORY_SLUGS, resolveCategorySlug } from '../constants/categories';
import { LISTING_LIMITS as L, ProductCondition } from '../constants/listing';
import {
  GENDERS,
  LEVELS,
  normaliseGender,
  normaliseLevel,
} from '../constants/profile';

export type Check = (
  value: unknown,
  object?: Record<string, unknown>,
) => string | null;

const isBlank = (v: unknown) =>
  v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

/** Characters length, counting emoji/accents as one each (code points). */
export const charLength = (s: string) => Array.from(s).length;

/**
 * Control and invisible formatting characters we never accept in user text:
 * C0/C1 controls (except tab/newline handled per field), zero-width space,
 * LRM/RLM, bidi overrides and BOM. ZWJ (U+200D) is allowed because emoji
 * sequences need it.
 */
/* eslint-disable no-control-regex */
const CONTROL_STRICT =
  /[\u0000-\u001F\u007F-\u009F\u200B\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/;
const CONTROL_MULTILINE =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/;
/* eslint-enable no-control-regex */

export const hasControlChars = (s: string) => CONTROL_STRICT.test(s);

// ---------------------------------------------------------------- text ----

export function normaliseText(value: unknown): unknown {
  return typeof value === 'string' ? value.normalize('NFC').trim() : value;
}

export const validateTitle: Check = (v) => {
  if (isBlank(v)) return MSG.titleRequired;
  if (typeof v !== 'string') return MSG.titleType;
  if (CONTROL_STRICT.test(v)) return MSG.titleControl;
  const len = charLength(v.trim());
  if (len < L.titleMin) return MSG.titleShort;
  if (len > L.titleMax) return MSG.titleLong;
  return null;
};

export const validateDescription: Check = (v) => {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string') return MSG.descriptionType;
  if (CONTROL_MULTILINE.test(v)) return MSG.descriptionControl;
  if (charLength(v.trim()) > L.descriptionMax) return MSG.descriptionLong;
  return null;
};

// ------------------------------------------------------------- numbers ----

/** "2500" -> 2500. Anything that is not a plain integer string is left as is. */
export function coerceIntegerString(value: unknown): unknown {
  if (typeof value === 'string' && /^\s*-?\d+\s*$/.test(value)) {
    return Number(value.trim());
  }
  return value;
}

export const validatePrice: Check = (v) => {
  if (isBlank(v)) return MSG.priceRequired;
  if (typeof v !== 'number' || !Number.isFinite(v)) return MSG.priceNotNumber;
  if (!Number.isInteger(v)) return MSG.priceWhole;
  if (v < L.priceMin) return MSG.priceMin;
  if (v > L.priceMax) return MSG.priceMax;
  return null;
};

export const validateQuantity: Check = (v) => {
  if (v === undefined) return null; // defaults to 1
  if (typeof v !== 'number' || !Number.isFinite(v))
    return MSG.quantityNotNumber;
  if (!Number.isInteger(v)) return MSG.quantityWhole;
  if (v < L.quantityMin) return MSG.quantityMin;
  if (v > L.quantityMax) return MSG.quantityMax;
  return null;
};

// ------------------------------------------------------ category/condition --

export function normaliseCategory(value: unknown): unknown {
  return resolveCategorySlug(value) ?? value;
}

export const validateCategorySlug: Check = (v) => {
  if (isBlank(v)) return MSG.categoryRequired;
  if (typeof v !== 'string' || !CATEGORY_SLUGS.includes(v)) {
    return MSG.categoryInvalid;
  }
  return null;
};

const CONDITION_LOOKUP: Record<string, ProductCondition> = {
  new: ProductCondition.NEW,
  'like new': ProductCondition.LIKE_NEW,
  likenew: ProductCondition.LIKE_NEW,
  used: ProductCondition.USED,
  fair: ProductCondition.FAIR,
};

/** Accepts stored values (like_new) and UI labels (Like New). */
export function normaliseCondition(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const key = value
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ');
  return CONDITION_LOOKUP[key] ?? value;
}

export const validateCondition: Check = (v) => {
  if (isBlank(v)) return MSG.conditionRequired;
  if (!(Object.values(ProductCondition) as unknown[]).includes(v)) {
    return MSG.conditionInvalid;
  }
  return null;
};

// -------------------------------------------------------------- images ----

export interface ImageHostPolicy {
  /** Cloudinary cloud name; only https://res.cloudinary.com/<name>/... allowed. */
  cloudName?: string;
  /** Extra URL prefixes, e.g. local-disk uploads in development. */
  extraPrefixes: string[];
}

/**
 * Read lazily from the environment so tests and scripts can set it. When the
 * API stores uploads on local disk (STORAGE_TYPE != cloudinary, i.e. local
 * development) our own /uploads/ URLs are also accepted; production uses
 * Cloudinary only.
 */
export function imageHostPolicyFromEnv(env = process.env): ImageHostPolicy {
  const extraPrefixes: string[] = [];
  if ((env.STORAGE_TYPE || 'local') !== 'cloudinary') {
    const base = (
      env.BACKEND_URL || `http://localhost:${env.PORT || 3000}`
    ).replace(/\/+$/, '');
    extraPrefixes.push(`${base}/uploads/`);
  }
  return {
    cloudName: env.CLOUDINARY_CLOUD_NAME?.trim() || undefined,
    extraPrefixes,
  };
}

export function isAllowedImageUrl(
  url: string,
  policy: ImageHostPolicy,
): boolean {
  if (policy.extraPrefixes.some((p) => url.startsWith(p))) return true;
  if (!policy.cloudName) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (
    parsed.protocol === 'https:' &&
    parsed.hostname === 'res.cloudinary.com' &&
    !parsed.username &&
    !parsed.password &&
    !parsed.port &&
    parsed.pathname.startsWith(`/${policy.cloudName}/`)
  );
}

export function normaliseImages(value: unknown): unknown {
  return Array.isArray(value)
    ? (value as unknown[]).map((u) => (typeof u === 'string' ? u.trim() : u))
    : value;
}

export function makeValidateImages(
  policy: () => ImageHostPolicy = () => imageHostPolicyFromEnv(),
): Check {
  return (v) => {
    if (v === undefined || v === null) return MSG.imagesRequired;
    if (!Array.isArray(v)) return MSG.imagesType;
    if (v.length < L.imagesMin) return MSG.imagesRequired;
    if (v.length > L.imagesMax) return MSG.imagesMax;
    if (v.some((u) => typeof u !== 'string' || !u)) return MSG.imagesType;
    const p = policy();
    if (v.some((u: string) => !isAllowedImageUrl(u, p))) return MSG.imagesHost;
    if (new Set(v).size !== v.length) return MSG.imagesDuplicate;
    return null;
  };
}

export const validateImages = makeValidateImages();

// ---------------------------------------------------------------- tags ----

/** Trims, lowercases, collapses spaces and de-duplicates. */
export function normaliseTags(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  if (value.some((t) => typeof t !== 'string')) return value;
  const out: string[] = [];
  for (const raw of value as string[]) {
    const t = raw.normalize('NFC').trim().toLowerCase().replace(/\s+/g, ' ');
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

const TAG_CHARS = /^[\p{L}\p{N}][\p{L}\p{N}\p{M} -]*$/u;

export const validateTags: Check = (v) => {
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v) || v.some((t) => typeof t !== 'string'))
    return MSG.tagsType;
  if (v.length > L.tagsMax) return MSG.tagsMax;
  for (const t of v as string[]) {
    const len = charLength(t);
    if (len < L.tagMin || len > L.tagMax) return MSG.tagLength;
    if (!TAG_CHARS.test(t)) return MSG.tagChars;
  }
  return null;
};

// --------------------------------------------------------------- phone ----

const NG_MOBILE_PREFIXES = ['70', '80', '81', '90', '91'];

/**
 * Nigerian mobile numbers. Accepts 0XXXXXXXXXX (11 digits, 070/080/081/090/091),
 * +234XXXXXXXXXX and 234XXXXXXXXXX, with spaces, dashes, dots or brackets.
 * Returns +234XXXXXXXXXX, or null if it is not a valid number.
 */
export function normaliseNigerianPhone(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const compact = value.trim().replace(/[\s\-().]/g, '');
  let national: string | null = null;
  let m: RegExpExecArray | null;
  if ((m = /^0(\d{10})$/.exec(compact))) national = m[1];
  else if ((m = /^\+?234(\d{10})$/.exec(compact))) national = m[1];
  if (!national) return null;
  if (!NG_MOBILE_PREFIXES.includes(national.slice(0, 2))) return null;
  return `+234${national}`;
}

export function normalisePhoneInput(value: unknown): unknown {
  return normaliseNigerianPhone(value) ?? value;
}

export const validatePhone: Check = (v) => {
  if (isBlank(v)) return MSG.phoneRequired;
  if (typeof v !== 'string' || !/^\+234\d{10}$/.test(v))
    return MSG.phoneInvalid;
  return normaliseNigerianPhone(v) ? null : MSG.phoneInvalid;
};

// ------------------------------------------------------------- profile ----

export function normaliseLevelInput(value: unknown): unknown {
  return normaliseLevel(value) ?? value;
}

export const validateLevel: Check = (v) => {
  if (isBlank(v)) return MSG.levelRequired;
  return (LEVELS as readonly unknown[]).includes(v) ? null : MSG.levelInvalid;
};

export function normaliseGenderInput(value: unknown): unknown {
  return normaliseGender(value) ?? value;
}

export const validateGender: Check = (v) => {
  if (v === undefined || v === null || v === '') return null;
  return (GENDERS as readonly unknown[]).includes(v) ? null : MSG.genderInvalid;
};

/** Accepts arrays, JSON strings or comma lists; maps aliases to slugs. */
export function normaliseInterests(value: unknown): unknown {
  let v = value;
  if (typeof value === 'string') {
    try {
      v = JSON.parse(value);
    } catch {
      v = value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }
  if (!Array.isArray(v)) return value;
  const out: unknown[] = [];
  for (const item of v) {
    const slug = resolveCategorySlug(item) ?? item;
    if (!out.includes(slug)) out.push(slug);
  }
  return out;
}

export const validateInterests: Check = (v) => {
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v)) return MSG.interestsType;
  if (v.length > 8) return MSG.interestsMax;
  if (v.some((i) => typeof i !== 'string' || !CATEGORY_SLUGS.includes(i))) {
    return MSG.interestsInvalid;
  }
  return null;
};

export function makeValidateName(message: string): Check {
  return (v) => {
    if (typeof v !== 'string') return message;
    if (CONTROL_STRICT.test(v)) return message;
    const len = charLength(v.trim());
    return len < 2 || len > 50 ? message : null;
  };
}

export const validateSchoolRef: Check = (v) => {
  if (isBlank(v)) return MSG.schoolRequired;
  if (typeof v !== 'string' || charLength(v) > 150) return MSG.schoolInvalid;
  return null;
};

// ------------------------------------------------------- whole listing ----

/**
 * Checks a stored listing before it is (re)activated. Image hosts are not
 * re-checked here so listings created before B1 can be relisted.
 */
export function listingProblems(p: {
  title?: unknown;
  description?: unknown;
  price?: unknown;
  quantity?: unknown;
  imageCount: number;
}): Record<string, string> {
  const problems: Record<string, string> = {};
  const title = validateTitle(p.title);
  if (title) problems.title = title;
  const description = validateDescription(p.description);
  if (description) problems.description = description;
  const price = validatePrice(
    typeof p.price === 'string' ? Number(p.price) : p.price,
  );
  if (price) problems.price = price;
  const quantity = validateQuantity(p.quantity);
  if (quantity) problems.quantity = quantity;
  if (p.imageCount < L.imagesMin) problems.images = MSG.imagesRequired;
  return problems;
}

const STRICT_TEST_TITLES = new Set([
  'test',
  'testing',
  'test item',
  'test product',
  'test listing',
  'test post',
  'qa',
  'qa test',
  'qa item',
  'dummy',
  'asdf',
  'lorem ipsum',
]);

/**
 * Placeholder/test titles that should never be live (e.g. "QA Test").
 * Deliberately strict so real items like "Test tube set" are not caught;
 * fix-data acts on this.
 */
export function looksLikeTestListing(title: unknown): boolean {
  if (typeof title !== 'string') return false;
  const t = title
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (STRICT_TEST_TITLES.has(t)) return true;
  return /\bqa\b/.test(t) && /\btest(ing)?\b/.test(t);
}

/** Broad match for the audit's "please review" list. Never acted on automatically. */
export function maybeTestListing(title: unknown): boolean {
  return (
    typeof title === 'string' &&
    /\b(qa|test(ing)?|dummy|asdf|lorem)\b/i.test(title)
  );
}

/**
 * Junk titles: fail the title rule, contain no letters/digits, or are
 * obvious test placeholders.
 */
export function isJunkTitle(title: unknown): boolean {
  if (validateTitle(title)) return true;
  if (typeof title === 'string' && !/[\p{L}\p{N}]/u.test(title)) return true;
  return looksLikeTestListing(title);
}
