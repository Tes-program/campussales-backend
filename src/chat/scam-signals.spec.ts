import { scanMessage } from './scam-signals';

describe('scam signals', () => {
  it.each([
    ['My account is 0123456789 GTBank', ['account_number']],
    ['acct: 0123 456 789', ['account_number']],
    ['Please pay first before I send it', ['payment_request']],
    ['send money to my opay', ['payment_request']],
    ['see photos at https://bit.ly/abc', ['external_link']],
    ['check www.dealz.ng', ['external_link']],
  ])('%p', (text, flags) => {
    expect(scanMessage(text)).toEqual(flags);
  });
  it('ignores normal messages, phone numbers and our own links', () => {
    expect(
      scanMessage('Is it still available? Can we meet at the library'),
    ).toEqual([]);
    expect(scanMessage('Call me on 08031234567')).toEqual([]);
    expect(scanMessage('Here: https://campussales.ng/item/1')).toEqual([]);
    expect(scanMessage('Price is 15000')).toEqual([]);
  });
  it('can raise several flags', () => {
    expect(
      scanMessage('pay first to 0123456789 or visit pay.me').sort(),
    ).toEqual(['account_number', 'external_link', 'payment_request'].sort());
  });
});
