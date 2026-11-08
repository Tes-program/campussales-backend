import { EVENT_LIMITS, looksLikePhone, validateEvents } from './event-schema';

const now = Date.parse('2026-11-08T12:00:00Z');
const ev = (over: Record<string, unknown> = {}) => ({
  name: 'search',
  ts: now - 1000,
  anonId: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
  props: { query: 'laptop', resultCount: 3 },
  ...over,
});
const errs = (body: unknown) => {
  const r = validateEvents(body, now);
  return 'errors' in r ? r.errors : null;
};

describe('validateEvents', () => {
  it('accepts a valid batch (object or bare array)', () => {
    expect(errs({ events: [ev()] })).toBeNull();
    expect(
      errs([ev(), ev({ name: 'feed_view', props: undefined })]),
    ).toBeNull();
    const r = validateEvents(
      { events: [ev({ ts: new Date(now).toISOString() })] },
      now,
    );
    expect('events' in r && r.events[0].occurredAt.getTime()).toBe(now);
  });
  it('rejects unknown event names and property keys', () => {
    expect(errs({ events: [ev({ name: 'page_view' })] })).toEqual({
      'events[0].name': 'Unknown event name.',
    });
    expect(errs({ events: [ev({ props: { email: 'x' } })] })).toHaveProperty([
      'events[0].props.email',
    ]);
  });
  it('rejects emails, phone numbers and long text in props', () => {
    expect(
      errs([ev({ props: { query: 'ada@unilag.edu.ng' } })]),
    ).toHaveProperty(
      ['events[0].props.query'],
      'Email addresses are not allowed in events.',
    );
    expect(
      errs([ev({ props: { query: 'call 0803 123 4567' } })]),
    ).toHaveProperty(
      ['events[0].props.query'],
      'Phone numbers are not allowed in events.',
    );
    expect(errs([ev({ props: { query: '+2348031234567' } })])).not.toBeNull();
    expect(errs([ev({ props: { value: 8031234567 } })])).not.toBeNull();
    expect(errs([ev({ props: { query: 'x'.repeat(61) } })])).not.toBeNull();
    expect(errs([ev({ props: { query: 'x'.repeat(60) } })])).toBeNull();
  });
  it('allows ids that contain long digit runs', () => {
    expect(looksLikePhone('550e8400-e29b-41d4-a716-446655440000')).toBe(false);
    expect(
      errs([ev({ props: { itemId: '550e8400-e29b-41d4-a716-446655440000' } })]),
    ).toBeNull();
  });
  it('rejects nested values, bad anonIds, stale timestamps and big batches', () => {
    expect(errs([ev({ props: { filter: { a: 1 } } })])).not.toBeNull();
    expect(errs([ev({ anonId: 'short' })])).toHaveProperty([
      'events[0].anonId',
    ]);
    expect(errs([ev({ ts: now - 8 * 86_400_000 })])).toHaveProperty([
      'events[0].ts',
    ]);
    expect(errs([ev({ ip: '1.2.3.4' })])).toHaveProperty(['events[0].ip']);
    expect(
      errs({
        events: Array.from({ length: EVENT_LIMITS.maxBatch + 1 }, () => ev()),
      }),
    ).toHaveProperty('events');
    expect(errs({ events: [] })).toHaveProperty('events');
  });
});
