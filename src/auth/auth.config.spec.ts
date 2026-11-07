import { readCookie } from './auth.config';

describe('readCookie', () => {
  it('reads one cookie from the header', () => {
    expect(readCookie('a=1; cs_refresh=abc%2Fdef; b=2', 'cs_refresh')).toBe(
      'abc/def',
    );
    expect(readCookie('a=1', 'cs_refresh')).toBeUndefined();
    expect(readCookie(undefined, 'cs_refresh')).toBeUndefined();
  });
});
