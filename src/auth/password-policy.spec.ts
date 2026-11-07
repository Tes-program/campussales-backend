import { checkPassword, PASSWORD_MESSAGES as M } from './password-policy';

describe('password policy', () => {
  it.each([
    ['', M.required],
    [undefined, M.required],
    ['abc1234', M.short],
    ['abcdefgh', M.letterAndNumber],
    ['12345678', M.letterAndNumber],
    ['password1', M.common],
    ['Passw0rd', M.common],
    ['1q2w3e4r', M.common],
    ['iloveyou1', M.common],
    ['a1' + 'é'.repeat(36), M.long], // 74 bytes
  ])('rejects %p', (pw, message) => {
    expect(checkPassword(pw)).toBe(message);
  });

  it('accepts 8+ characters with a letter and a number', () => {
    expect(checkPassword('kola-nut-42')).toBeNull();
    expect(checkPassword('Ọ̀kọ̀ 2026 bus')).toBeNull();
    expect(checkPassword('a1' + 'x'.repeat(70))).toBeNull(); // exactly 72 bytes
  });

  it('rejects the email or name', () => {
    const ctx = { email: 'ada.okafor@unilag.edu.ng', name: 'Ada Okafor' };
    expect(checkPassword('AdaOkafor99', ctx)).toBe(M.personal);
    expect(checkPassword('okafor-2026', ctx)).toBe(M.personal);
    expect(checkPassword('adaokafor1', ctx)).toBe(M.personal);
    expect(checkPassword('mango-tree-77', ctx)).toBeNull();
  });
});
