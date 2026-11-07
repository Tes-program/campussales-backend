/**
 * Listing screening (B4). Pure and synchronous: the service gathers the
 * counts (duplicates, posting rate) and passes them in. Run on create and
 * edit, and by fix-data.js --screening for existing listings.
 *
 * Order: hard rules -> prohibited items -> spam rate.
 *
 * Outcomes:
 *   approved      shows immediately
 *   needs_review  visible only to the owner ("Under review. This usually takes
 *                 under 24 hours.") until a moderator approves it
 *   rejected      not saved: 400 MODERATION_REJECTED with the reason
 *
 * We never reject on a guess: only clearly prohibited keywords and contact
 * details in the title are rejected. Everything doubtful goes to review.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { LISTING_LIMITS } from '../common/constants/listing';

export type ModerationStatus = 'approved' | 'needs_review' | 'rejected';

export interface ScreeningReason {
  code: string;
  message: string;
  field?: string;
}

export interface ScreeningInput {
  title?: string | null;
  description?: string | null;
  tags?: string[] | null;
  price?: number | null;
  imageCount?: number;
}

export interface ScreeningContext {
  /** Same seller has an active listing with the same title in the last 24h. */
  duplicateInLast24h?: boolean;
  /** Listings this seller created in the last hour / day (excluding this one). */
  postsLastHour?: number;
  postsLastDay?: number;
}

export interface ScreeningResult {
  status: ModerationStatus;
  reasons: ScreeningReason[];
}

export const SPAM_LIMITS = { perHour: 10, perDay: 30 } as const;

/** MODERATION_SPAM_PER_HOUR / _PER_DAY override the defaults (tests, tuning). */
export function spamLimits() {
  const num = (v: string | undefined, d: number) =>
    v && /^\d+$/.test(v) ? Number(v) : d;
  return {
    perHour: num(process.env.MODERATION_SPAM_PER_HOUR, SPAM_LIMITS.perHour),
    perDay: num(process.env.MODERATION_SPAM_PER_DAY, SPAM_LIMITS.perDay),
  };
}
export const UNDER_REVIEW_NOTE =
  'Under review. This usually takes under 24 hours.';

interface CategoryRules {
  message: string;
  block: string[];
  review: string[];
}

let rules: Record<string, CategoryRules> | null = null;
function prohibited(): Record<string, CategoryRules> {
  if (!rules) {
    rules = (
      JSON.parse(
        readFileSync(
          join(__dirname, '..', '..', 'data', 'prohibited.json'),
          'utf8',
        ),
      ) as {
        categories: Record<string, CategoryRules>;
      }
    ).categories;
  }
  return rules;
}

const LEET: Record<string, string> = {
  '0': 'o',
  '1': 'i',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '8': 'b',
  '@': 'a',
  $: 's',
  '!': 'i',
};

/**
 * Lowercase, undo leetspeak, and join letters split by spaces/dots/dashes
 * ("c.0.c.a.i.n.e", "g u n") so whole-word matching still works.
 */
export function normaliseForScreening(text: string): string {
  let t = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '');
  // 1) join single characters split by spaces, dots, dashes, underscores or
  //    stars ("c.0.c.a.1.n.e", "g u n")
  t = t.replace(
    /(?<![\p{L}\p{N}])(?:[a-z0-9@$][\s.\-_*]){2,}[a-z0-9@$](?![\p{L}\p{N}])/gu,
    (m) => m.replace(/[\s.\-_*]/g, ''),
  );
  // 2) undo leetspeak inside words that mix letters and digits/symbols, but
  //    not tokens that start with a digit (prices, "4k") or end in digits
  //    after letters (model numbers like "ak47")
  t = t.replace(/[\p{L}0-9@$!]+/gu, (w) =>
    /[a-z]/.test(w) &&
    /[0-9@$!]/.test(w) &&
    !/^\d/.test(w) &&
    !/^[a-z]+\d+$/.test(w)
      ? w.replace(/[0134578@$!]/g, (c) => LEET[c] ?? c)
      : w,
  );
  return t.replace(/\s+/g, ' ').trim();
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function findTerm(haystack: string, terms: string[]): string | null {
  for (const term of terms) {
    const re = new RegExp(
      `(^|[^\\p{L}\\p{N}])${escapeRe(term)}($|[^\\p{L}\\p{N}])`,
      'u',
    );
    if (re.test(haystack)) return term;
  }
  return null;
}

const PHONE_IN_TEXT = /(?:\+?234|0)[\s.-]?[789][01](?:[\s.-]?\d){8}/;
const EMAIL_IN_TEXT = /[\w.+-]+@[\w-]+\.[\w.]+/;
const LINK_IN_TEXT =
  /\b(?:https?:\/\/|www\.)\S+|\b[\w-]+\.(?:com|ng|net|org|io|co|me|ly|link|xyz)\b/i;
const WHATSAPP = /\b(?:whatsapp|wa\.me|call me on|dm me on|telegram|t\.me)\b/i;

export function screenListing(
  input: ScreeningInput,
  ctx: ScreeningContext = {},
): ScreeningResult {
  const reject: ScreeningReason[] = [];
  const review: ScreeningReason[] = [];
  const title = (input.title ?? '').trim();
  const text = [title, input.description ?? '', ...(input.tags ?? [])].join(
    ' \n ',
  );

  // ---- hard rules ----
  if (
    typeof input.price === 'number' &&
    input.price < LISTING_LIMITS.priceMin
  ) {
    review.push({
      code: 'price_too_low',
      field: 'price',
      message: 'Price must be at least ₦50.',
    });
  }
  if (input.imageCount !== undefined && input.imageCount < 1) {
    review.push({
      code: 'no_image',
      field: 'images',
      message: 'Please add at least one image.',
    });
  }
  if (title && !/[\p{L}\p{N}]/u.test(title)) {
    review.push({
      code: 'symbols_only',
      field: 'title',
      message: 'Use words in your title, not just symbols.',
    });
  }
  if (
    /(.)\1{5,}/u.test(title.replace(/\s/g, '')) ||
    /^(\p{L})\1+$/u.test(title.replace(/\s/g, ''))
  ) {
    review.push({
      code: 'repeated_characters',
      field: 'title',
      message:
        'Your title repeats the same character. Describe the item instead.',
    });
  }
  const letters = title.replace(/[^\p{L}]/gu, '');
  if (
    title.length >= 20 &&
    letters.length >= 10 &&
    letters === letters.toUpperCase() &&
    letters !== letters.toLowerCase()
  ) {
    review.push({
      code: 'all_caps',
      field: 'title',
      message: 'Please avoid writing the title in capitals.',
    });
  }
  if (
    PHONE_IN_TEXT.test(title) ||
    EMAIL_IN_TEXT.test(title) ||
    LINK_IN_TEXT.test(title) ||
    WHATSAPP.test(title)
  ) {
    reject.push({
      code: 'contact_in_title',
      field: 'title',
      message:
        'Please remove phone numbers, emails, links or WhatsApp details from the title. Buyers can message you in the app.',
    });
  }
  if (ctx.duplicateInLast24h) {
    review.push({
      code: 'duplicate',
      field: 'title',
      message: 'You already listed an item with this title today.',
    });
  }

  // ---- prohibited items ----
  const hay = normaliseForScreening(text);
  for (const [category, r] of Object.entries(prohibited())) {
    const blocked = findTerm(hay, r.block);
    if (blocked) {
      reject.push({
        code: `prohibited_${category}`,
        field: 'title',
        message: r.message,
      });
      continue;
    }
    if (findTerm(hay, r.review)) {
      review.push({
        code: `possibly_prohibited_${category}`,
        message: 'This listing needs a quick check by our team.',
      });
    }
  }

  // ---- spam rate ----
  const limits = spamLimits();
  if (
    (ctx.postsLastHour ?? 0) >= limits.perHour ||
    (ctx.postsLastDay ?? 0) >= limits.perDay
  ) {
    review.push({
      code: 'posting_rate',
      message:
        "You've posted a lot of items quickly, so we'll check them first.",
    });
  }

  if (reject.length) return { status: 'rejected', reasons: reject };
  if (review.length) return { status: 'needs_review', reasons: review };
  return { status: 'approved', reasons: [] };
}
