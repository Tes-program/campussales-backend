/**
 * Scam signals in chat messages. Used only to protect users: a flagged
 * message is still delivered unchanged. Flags are stored on the message and
 * the recipient sees a generic safety tip. If one account triggers signals
 * in more than 5 conversations in 24 hours, the account is surfaced in the
 * admin queue (users.needsReviewAt). See docs/moderation.md "Privacy".
 */
export type ScamSignal = 'account_number' | 'payment_request' | 'external_link';

export const SCAM_REVIEW_THRESHOLD = {
  conversations: 5,
  windowHours: 24,
} as const;

const PAYMENT_PHRASES = [
  'send money',
  'send the money',
  'send me money',
  'pay first',
  'payment first',
  'transfer first',
  'pay before',
  'advance payment',
  'pay upfront',
  'pay up front',
  'deposit first',
  'pay a deposit',
  'pay small deposit',
  'transfer the money',
  'pay half',
  'part payment first',
  'bitcoin',
  'usdt',
  'gift card',
  'itunes card',
  'western union',
];

const LINK =
  /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(?:com|ng|net|org|io|co|me|ly|link|xyz|app|shop)\b(?:\/\S*)?/i;

export function scanMessage(content: string | null | undefined): ScamSignal[] {
  if (!content) return [];
  const flags = new Set<ScamSignal>();
  const lower = content.toLowerCase();

  // Join digit groups split by spaces/dashes/dots ("0123 456 789").
  const digits = content.replace(/(?<=\d)[\s.-](?=\d)/g, '');
  for (const run of digits.match(/\d{10,}/g) ?? []) {
    const isPhone = /^(?:0[789][01]\d{8}|234[789][01]\d{8})$/.test(run);
    if (!isPhone) flags.add('account_number'); // NUBAN is 10 digits; 12+ looks like a card
  }
  if (PAYMENT_PHRASES.some((p) => lower.includes(p)))
    flags.add('payment_request');
  const link = LINK.exec(content);
  if (link && !/campussales/i.test(link[0])) flags.add('external_link');
  return [...flags];
}
