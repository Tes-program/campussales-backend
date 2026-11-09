import { checkPassword, PASSWORD_MESSAGES as M } from './password-policy';

describe('password policy (matches the sign-up form exactly)', () => {
  it.each([
    ['', M.required],
    [undefined, M.required],
    [12345678, M.required],
    ['abc1234', M.rule], // 7 characters
    ['abcdefgh', M.rule], // no number
    ['        ', M.rule],
    ['a1' + 'é'.repeat(36), M.long], // 74 bytes
  ])('rejects %p', (pw, message) => {
    expect(checkPassword(pw)).toBe(message);
  });

  it('accepts 8+ characters with a number, nothing stricter', () => {
    expect(checkPassword('abcdefg1')).toBeNull();
    expect(checkPassword('12345678')).toBeNull(); // no letter needed
    expect(checkPassword('password1')).toBeNull(); // no common-password list
    expect(checkPassword('Ọ̀kọ̀ 2026 bus')).toBeNull();
    expect(checkPassword('a1' + 'x'.repeat(70))).toBeNull(); // exactly 72 bytes
  });

  it('uses the same text as the form', () => {
    expect(M.rule).toBe('Use at least 8 characters, including a number.');
    expect(M.required).toBe('Enter a password.');
  });
});
