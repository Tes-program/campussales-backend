import { normaliseForScreening, screenListing } from './screening';

const clean = {
  title: 'Casio fx-991ES calculator',
  description: 'Works well',
  price: 7500,
  imageCount: 2,
  tags: ['calculator'],
};

describe('listing screening', () => {
  it('approves a clean listing', () => {
    expect(screenListing(clean)).toEqual({ status: 'approved', reasons: [] });
  });

  describe('hard rules -> needs_review', () => {
    it.each([
      [{ price: 0 }, 'price_too_low'],
      [{ imageCount: 0 }, 'no_image'],
      [{ title: '!!!!!!!' }, 'symbols_only'],
      [{ title: 'aaaaaaaa' }, 'repeated_characters'],
      [{ title: 'Nice phoneeeeeeee' }, 'repeated_characters'],
      [{ title: 'BRAND NEW IPHONE FOR SALE CHEAP' }, 'all_caps'],
    ])('%j', (patch, code) => {
      const r = screenListing({ ...clean, ...patch });
      expect(r.status).toBe('needs_review');
      expect(r.reasons.map((x) => x.code)).toContain(code);
    });
    it('flags a same-title duplicate within 24h', () => {
      expect(
        screenListing(clean, { duplicateInLast24h: true }).reasons[0].code,
      ).toBe('duplicate');
    });
    it('short capitals like "HP" are fine', () => {
      expect(screenListing({ ...clean, title: 'HP laptop 8GB' }).status).toBe(
        'approved',
      );
    });
  });

  it.each([
    'iPhone 11 call 08031234567',
    'Laptop +234 803 123 4567',
    'Shoes, WhatsApp me',
    'Bag ada@gmail.com',
    'Visit www.mystore.ng',
  ])('rejects contact details in the title: %p', (title) => {
    const r = screenListing({ ...clean, title });
    expect(r.status).toBe('rejected');
    expect(r.reasons[0].code).toBe('contact_in_title');
  });

  describe('prohibited items', () => {
    it.each([
      ['Pistol for sale', 'prohibited_weapons'],
      ['Clean c0caine', 'prohibited_drugs'],
      ['c.o.c.a.i.n.e', 'prohibited_drugs'],
      ['g r e n a d e', 'prohibited_weapons'],
      ['CSC 201 exam leak', 'prohibited_exam_cheating'],
      ['Fake naira notes', 'prohibited_counterfeit'],
    ])('rejects %p', (title, code) => {
      const r = screenListing({ ...clean, title });
      expect(r.status).toBe('rejected');
      expect(r.reasons[0]).toMatchObject({ code });
      expect(r.reasons[0].message).toMatch(/can't be/);
    });

    it.each([
      'Kitchen knife set',
      'Glue gun for crafts',
      'Replica jersey',
      'Vape pen',
    ])('sends borderline %p to review, never rejects', (title) => {
      expect(screenListing({ ...clean, title }).status).toBe('needs_review');
    });

    it.each([
      'Expo markers (12 pack)',
      'Begun textbook',
      'Gunther guitar strings',
      'Stroud engineering maths',
    ])('does not match inside other words: %p', (title) => {
      expect(screenListing({ ...clean, title }).status).not.toBe('rejected');
    });

    it('checks description and tags too', () => {
      expect(
        screenListing({ ...clean, description: 'also have ammunition' }).status,
      ).toBe('rejected');
      expect(screenListing({ ...clean, tags: ['tramadol'] }).status).toBe(
        'rejected',
      );
    });
  });

  it('spam rate goes to review', () => {
    expect(screenListing(clean, { postsLastHour: 10 }).reasons[0].code).toBe(
      'posting_rate',
    );
    expect(screenListing(clean, { postsLastDay: 30 }).status).toBe(
      'needs_review',
    );
    expect(
      screenListing(clean, { postsLastHour: 9, postsLastDay: 29 }).status,
    ).toBe('approved');
  });

  it('normalises obfuscation', () => {
    expect(normaliseForScreening('C.0.C.A.1.N.E')).toBe('cocaine');
    expect(normaliseForScreening('p1st0l 2024')).toBe('pistol 2024');
    expect(normaliseForScreening('AK47')).toBe('ak47');
  });
});
