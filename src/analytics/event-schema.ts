/**
 * The only events and property keys POST /api/events accepts (B5). Adding
 * one is a deliberate code change, reviewed for privacy: never add keys that
 * could carry message text, names, emails, phone numbers or free-form input.
 */
export const EVENT_NAMES = [
  'landing_view',
  'signup_start',
  'signup_complete',
  'onboarding_step_view',
  'onboarding_step_complete',
  'onboarding_error',
  'feed_view',
  'search',
  'search_zero_results',
  'filter_change',
  'item_view',
  'message_start',
  'wishlist_add',
  'sell_open',
  'photo_added',
  'post_error',
  'post_success',
  'report_open',
  'report_submit',
  'block_user',
  'share_click',
] as const;

export type EventName = (typeof EVENT_NAMES)[number];

export const PROP_KEYS = [
  // where / navigation
  'screen',
  'source',
  'referrer',
  'section',
  'position',
  'page',
  'variant',
  // onboarding / forms
  'step',
  'field',
  'errorCode',
  'method',
  // listings / search
  'itemId',
  'productId',
  'sellerId',
  'category',
  'condition',
  'campusId',
  'sort',
  'filter',
  'value',
  'query',
  'resultCount',
  'priceBucket',
  'photoCount',
  'hasDidYouMean',
  // moderation / sharing
  'reason',
  'targetType',
  'channel',
  // performance
  'durationMs',
  'network',
] as const;

export const EVENT_LIMITS = {
  maxBatch: 20,
  maxProps: 12,
  maxString: 60,
  /** Offline phones flush queued events later; older events are rejected. */
  maxAgeMs: 7 * 86_400_000,
  maxFutureMs: 10 * 60_000,
} as const;

export interface ValidEvent {
  name: EventName;
  occurredAt: Date;
  anonId: string;
  props: Record<string, string | number | boolean | null>;
}

const NAMES = new Set<string>(EVENT_NAMES);
const KEYS = new Set<string>(PROP_KEYS);
const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ANON_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** True if the text looks like a phone number (10+ digits once separators are removed). */
export function looksLikePhone(text: string): boolean {
  if (UUID.test(text)) return false;
  return /\d{10,}/.test(text.replace(/[\s().\-+/]/g, ''));
}

export function looksLikeEmail(text: string): boolean {
  return EMAIL.test(text);
}

function checkValue(v: unknown): string | null {
  if (v === null || typeof v === 'boolean') return null;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return 'Numbers must be finite.';
    // 10+ digit integers are phone numbers or ids we don't want.
    if (Math.abs(v) >= 1e9) return 'This number is too large.';
    return null;
  }
  if (typeof v === 'string') {
    if (v.length > EVENT_LIMITS.maxString)
      return `Text values are limited to ${EVENT_LIMITS.maxString} characters.`;
    if (looksLikeEmail(v)) return 'Email addresses are not allowed in events.';
    if (looksLikePhone(v)) return 'Phone numbers are not allowed in events.';
    return null;
  }
  return 'Values must be text, numbers, true/false or null.';
}

function parseTs(ts: unknown, now: number): Date | null {
  const t =
    typeof ts === 'number' ? ts : typeof ts === 'string' ? Date.parse(ts) : NaN;
  if (!Number.isFinite(t)) return null;
  if (t < now - EVENT_LIMITS.maxAgeMs || t > now + EVENT_LIMITS.maxFutureMs)
    return null;
  return new Date(t);
}

/**
 * Validates a batch. Returns field errors keyed like `events[2].props.query`
 * (any error rejects the whole batch with 400), or the cleaned events.
 */
export function validateEvents(
  body: unknown,
  now = Date.now(),
): { events: ValidEvent[] } | { errors: Record<string, string> } {
  const list: unknown = Array.isArray(body)
    ? body
    : (body as { events?: unknown } | null)?.events;
  const errors: Record<string, string> = {};
  if (!Array.isArray(list) || list.length === 0) {
    return { errors: { events: 'Send a list of events.' } };
  }
  if (list.length > EVENT_LIMITS.maxBatch) {
    return {
      errors: {
        events: `Send at most ${EVENT_LIMITS.maxBatch} events at a time.`,
      },
    };
  }
  const events: ValidEvent[] = [];
  list.forEach((raw, i) => {
    const at = `events[${i}]`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      errors[at] = 'Each event must be an object.';
      return;
    }
    const e = raw as Record<string, unknown>;
    for (const k of Object.keys(e)) {
      if (!['name', 'ts', 'anonId', 'props'].includes(k))
        errors[`${at}.${k}`] = 'This field is not allowed.';
    }
    if (typeof e.name !== 'string' || !NAMES.has(e.name))
      errors[`${at}.name`] = 'Unknown event name.';
    const occurredAt = parseTs(e.ts, now);
    if (!occurredAt)
      errors[`${at}.ts`] =
        'Send the event time (ms or ISO) from the last 7 days.';
    if (typeof e.anonId !== 'string' || !ANON_ID.test(e.anonId))
      errors[`${at}.anonId`] =
        'anonId must be 8 to 64 letters, digits, - or _.';
    const props: Record<string, string | number | boolean | null> = {};
    if (e.props !== undefined && e.props !== null) {
      if (typeof e.props !== 'object' || Array.isArray(e.props)) {
        errors[`${at}.props`] = 'props must be an object.';
      } else {
        const entries = Object.entries(e.props as Record<string, unknown>);
        if (entries.length > EVENT_LIMITS.maxProps)
          errors[`${at}.props`] =
            `Send at most ${EVENT_LIMITS.maxProps} properties.`;
        for (const [k, v] of entries) {
          if (!KEYS.has(k)) {
            errors[`${at}.props.${k}`] = 'Unknown property.';
            continue;
          }
          const problem = checkValue(v);
          if (problem) errors[`${at}.props.${k}`] = problem;
          else props[k] = v as string | number | boolean | null;
        }
      }
    }
    if (Object.keys(errors).length === 0 && occurredAt) {
      events.push({
        name: e.name as EventName,
        occurredAt,
        anonId: e.anonId as string,
        props,
      });
    }
  });
  return Object.keys(errors).length ? { errors } : { events };
}
