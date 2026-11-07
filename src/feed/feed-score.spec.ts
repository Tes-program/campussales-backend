import {
  diversify,
  FEED_WEIGHTS,
  rankFeed,
  scoreItem,
  FeedCandidate,
} from './feed-score';

const now = Date.UTC(2026, 10, 7);
const day = 86_400_000;
const cand = (o: Partial<FeedCandidate> = {}): FeedCandidate => ({
  id: Math.random().toString(36).slice(2),
  sellerId: 's1',
  createdAt: new Date(now),
  campusId: null,
  categorySlug: null,
  lastPriceDropAt: null,
  sellerLastActiveAt: null,
  ...o,
});
const viewer = { campusId: 'c1', interests: ['electronics'] };

describe('feed score', () => {
  it('decays recency over 14 days', () => {
    expect(scoreItem(cand(), viewer, now)).toBeCloseTo(1);
    expect(
      scoreItem(cand({ createdAt: new Date(now - 14 * day) }), viewer, now),
    ).toBeCloseTo(Math.exp(-1));
  });
  it('adds each boost', () => {
    const base = scoreItem(cand(), viewer, now);
    expect(scoreItem(cand({ campusId: 'c1' }), viewer, now) - base).toBeCloseTo(
      FEED_WEIGHTS.sameCampus,
    );
    expect(
      scoreItem(cand({ categorySlug: 'electronics' }), viewer, now) - base,
    ).toBeCloseTo(FEED_WEIGHTS.interest);
    expect(
      scoreItem(
        cand({ lastPriceDropAt: new Date(now - 2 * day) }),
        viewer,
        now,
      ) - base,
    ).toBeCloseTo(FEED_WEIGHTS.priceDrop);
    expect(
      scoreItem(
        cand({ lastPriceDropAt: new Date(now - 9 * day) }),
        viewer,
        now,
      ),
    ).toBeCloseTo(base);
    expect(
      scoreItem(
        cand({ sellerLastActiveAt: new Date(now - day) }),
        viewer,
        now,
      ) - base,
    ).toBeCloseTo(FEED_WEIGHTS.sellerActive);
  });
  it('penalises items older than 60 days', () => {
    const at61 = scoreItem(
      cand({ createdAt: new Date(now - 61 * day) }),
      viewer,
      now,
    );
    expect(at61).toBeCloseTo(Math.exp(-61 / 14) - FEED_WEIGHTS.stalePenalty);
  });
  it('a same-campus interest item from yesterday beats a brand-new unrelated one', () => {
    const ranked = rankFeed(
      [
        cand({ id: 'new' }),
        cand({
          id: 'rel',
          campusId: 'c1',
          categorySlug: 'electronics',
          createdAt: new Date(now - day),
        }),
      ],
      viewer,
      now,
    );
    expect(ranked[0].id).toBe('rel');
  });
});

describe('diversify', () => {
  it('allows at most 3 in a row from one seller', () => {
    const items = ['a', 'a', 'a', 'a', 'a', 'b', 'c'].map((s, i) => ({
      id: String(i),
      sellerId: s,
    }));
    const out = diversify(items)
      .map((x) => x.sellerId)
      .join('');
    expect(out).toBe('aaabaac');
    expect(out).not.toMatch(/(.)\1\1\1/);
  });
  it('appends the rest when only one seller is left', () => {
    expect(
      diversify([1, 2, 3, 4, 5].map((i) => ({ id: String(i), sellerId: 'x' }))),
    ).toHaveLength(5);
  });
});
