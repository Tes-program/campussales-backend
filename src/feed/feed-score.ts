/**
 * Feed ranking. Tune the weights here; everything else just feeds data in.
 *
 *   score = recency                      exp(-ageDays / 14): 1.0 today, 0.37 at 14 days
 *         + 0.6  if same campus as the viewer
 *         + 0.4  if the category is one of the viewer's interests
 *         + 0.3  if the price dropped in the last 7 days
 *         + 0.2  if the seller was active in the last 3 days
 *         - 0.5  if the listing is older than 60 days
 *
 * After scoring, diversify() keeps at most 3 items in a row from one seller.
 */
export const FEED_WEIGHTS = {
  recencyHalfLifeDays: 14,
  sameCampus: 0.6,
  interest: 0.4,
  priceDrop: 0.3,
  priceDropWindowDays: 7,
  sellerActive: 0.2,
  sellerActiveWindowDays: 3,
  stalePenalty: 0.5,
  staleAfterDays: 60,
  maxRunPerSeller: 3,
} as const;

export interface FeedCandidate {
  id: string;
  sellerId: string;
  createdAt: Date;
  campusId: string | null;
  categorySlug: string | null;
  lastPriceDropAt: Date | null;
  sellerLastActiveAt: Date | null;
}

export interface FeedViewer {
  campusId: string | null;
  interests: string[];
}

const DAY = 86_400_000;

export function scoreItem(
  c: FeedCandidate,
  v: FeedViewer,
  now = Date.now(),
): number {
  const W = FEED_WEIGHTS;
  const ageDays = Math.max(0, (now - c.createdAt.getTime()) / DAY);
  let score = Math.exp(-ageDays / W.recencyHalfLifeDays);
  if (v.campusId && c.campusId === v.campusId) score += W.sameCampus;
  if (c.categorySlug && v.interests.includes(c.categorySlug))
    score += W.interest;
  if (
    c.lastPriceDropAt &&
    now - c.lastPriceDropAt.getTime() <= W.priceDropWindowDays * DAY
  ) {
    score += W.priceDrop;
  }
  if (
    c.sellerLastActiveAt &&
    now - c.sellerLastActiveAt.getTime() <= W.sellerActiveWindowDays * DAY
  ) {
    score += W.sellerActive;
  }
  if (ageDays > W.staleAfterDays) score -= W.stalePenalty;
  return score;
}

/**
 * Re-orders a ranked list so no seller appears more than `maxRun` times in a
 * row, moving the next best item from another seller forward. Order is
 * otherwise preserved. If only one seller is left, the rest are appended.
 */
export function diversify<T extends { sellerId: string }>(
  ranked: T[],
  maxRun: number = FEED_WEIGHTS.maxRunPerSeller,
): T[] {
  const pool = [...ranked];
  const out: T[] = [];
  while (pool.length) {
    const tail = out.slice(-maxRun);
    const blockedSeller =
      tail.length === maxRun &&
      tail.every((x) => x.sellerId === tail[0].sellerId)
        ? tail[0].sellerId
        : null;
    const idx = blockedSeller
      ? pool.findIndex((x) => x.sellerId !== blockedSeller)
      : 0;
    out.push(pool.splice(idx === -1 ? 0 : idx, 1)[0]);
  }
  return out;
}

export function rankFeed(
  cands: FeedCandidate[],
  v: FeedViewer,
  now = Date.now(),
) {
  const scored = cands
    .map((c) => ({ ...c, score: scoreItem(c, v, now) }))
    .sort(
      (a, b) =>
        b.score - a.score || b.createdAt.getTime() - a.createdAt.getTime(),
    );
  return diversify(scored);
}
