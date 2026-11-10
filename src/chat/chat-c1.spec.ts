import { safePreview } from './chat-notifier';
import { messageStatus, messageView, MessageRow } from './chat-views';
import {
  ChatPresence,
  PRESENCE_GRACE_MS,
  TYPING_TTL_MS,
} from './chat-presence';
import { chatMetrics, CHAT_METRIC } from './chat-metrics';
import { metrics, MetricsRegistry } from '../common/observability/metrics';
import { evaluateAlerts } from '../health/alerts.service';
import { MessageType } from './enums/chat.enums';

const row = (o: Partial<MessageRow> = {}): MessageRow => ({
  id: 'm1',
  conversationId: 'c1',
  seq: 3,
  clientMessageId: 'cid',
  senderId: 'a',
  content: 'Hello there',
  type: MessageType.TEXT,
  attachments: [],
  flags: [],
  deletedAt: null,
  createdAt: new Date('2026-11-10T10:00:00Z'),
  ...o,
});

describe('C1 chat units', () => {
  describe('safePreview (B4 copy rules)', () => {
    it.each([
      ['Is it still available?', 'Is it still available?'],
      ['Pay into 0123456789 first', 'Sent you a message'],
      ['call 0803 123 4567', 'Sent you a message'],
      ['see https://evil.example', 'Sent you a message'],
      ['go to www.deals.com', 'Sent you a message'],
      ['buy at cheap-deals.xyz', 'Sent you a message'],
    ])('%s -> %s', (text, preview) => {
      expect(safePreview(messageView(row({ content: text })))).toBe(preview);
    });
    it('flagged messages, photos and long text', () => {
      expect(
        safePreview(messageView(row({ flags: ['payment_request'] }))),
      ).toBe('Sent you a message');
      expect(
        safePreview(
          messageView(row({ content: '', attachments: [{ url: 'u' }] })),
        ),
      ).toBe('Sent a photo');
      expect(safePreview(messageView(row({ content: 'a'.repeat(200) })))).toBe(
        `${'a'.repeat(80)}…`,
      );
    });
  });

  describe('message view', () => {
    it('computes receipts from the read/delivered pointers', () => {
      const ctx = {
        viewerId: 'a',
        otherReadSeq: 2,
        otherDeliveredSeq: 4,
        myReadSeq: 1,
      };
      expect(messageStatus(2, 'a', ctx)).toBe('read');
      expect(messageStatus(4, 'a', ctx)).toBe('delivered');
      expect(messageStatus(5, 'a', ctx)).toBe('sent');
      expect(messageStatus(1, 'b', ctx)).toBe('read');
      expect(messageStatus(2, 'b', ctx)).toBe('delivered');
    });
    it('never returns the text of deleted or hidden messages', () => {
      const del = messageView(row({ deletedAt: new Date(), flags: ['x'] }));
      expect(del).toMatchObject({
        text: null,
        content: 'Message deleted',
        deleted: true,
        safetyTip: false,
      });
      const hidden = messageView(row({ hidden: true }));
      expect(hidden).toMatchObject({ text: null, deletedForMe: true });
      expect(messageView(row()).createdAt).toBe('2026-11-10T10:00:00.000Z');
    });
  });

  describe('presence', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('waits 5 s before going offline and survives a quick reconnect', () => {
      const p = new ChatPresence();
      const offline = jest.fn();
      expect(p.connect('u', 's1')).toBe(true);
      expect(p.connect('u', 's2')).toBe(false);
      p.disconnect('u', 's1', offline);
      p.disconnect('u', 's2', offline);
      expect(p.isOnline('u')).toBe(true);
      expect(p.isReconnect('u')).toBe(true);
      jest.advanceTimersByTime(PRESENCE_GRACE_MS - 1);
      expect(p.connect('u', 's3')).toBe(false); // back in time: no flicker
      p.disconnect('u', 's3', offline);
      jest.advanceTimersByTime(PRESENCE_GRACE_MS);
      expect(offline).toHaveBeenCalledTimes(1);
      expect(p.isOnline('u')).toBe(false);
      p.onModuleDestroy();
    });

    it('typing expires after 5 s of silence', () => {
      const p = new ChatPresence();
      const expired = jest.fn();
      p.startTyping('c:u', expired);
      jest.advanceTimersByTime(TYPING_TTL_MS - 100);
      p.startTyping('c:u', expired); // refreshed
      jest.advanceTimersByTime(TYPING_TTL_MS - 100);
      expect(expired).not.toHaveBeenCalled();
      expect(p.typingKeysFor('u')).toEqual(['c:u']);
      jest.advanceTimersByTime(200);
      expect(expired).toHaveBeenCalledTimes(1);
      expect(p.stopTyping('c:u')).toBe(false);
    });
  });

  describe('metrics and alert', () => {
    afterEach(() => {
      metrics.reset();
      chatMetrics.reset();
    });

    it('tracks sends, refusals by code and delivery p50/p95', () => {
      for (let i = 1; i <= 20; i++) chatMetrics.delivered(i);
      chatMetrics.sent(12);
      chatMetrics.sendError('BLOCKED', false);
      chatMetrics.sendError('SERVER_ERROR', true);
      const s = chatMetrics.snapshot(60_000);
      expect(s).toMatchObject({
        messagesSent: 1,
        sendFailures: 1,
        sendErrorsByCode: { BLOCKED: 1, SERVER_ERROR: 1 },
        deliveryMs: { count: 20, p50: 10, p95: 19 },
      });
    });

    it('fires when more than 2% of sends fail (server errors only)', () => {
      const m = new MetricsRegistry();
      const now = Date.now();
      const state = { dbFailures: 0, poolSaturatedStreak: 0, pool: null };
      for (let i = 0; i < 98; i++) m.count(CHAT_METRIC.sent, now);
      for (let i = 0; i < 40; i++) m.count(CHAT_METRIC.refused, now);
      m.count(CHAT_METRIC.failed, now);
      m.count(CHAT_METRIC.failed, now);
      expect(evaluateAlerts(m, state, now).map((a) => a.key)).not.toContain(
        'chat_send_failures',
      );
      m.count(CHAT_METRIC.failed, now);
      expect(evaluateAlerts(m, state, now).map((a) => a.key)).toContain(
        'chat_send_failures',
      );
    });
  });
});
