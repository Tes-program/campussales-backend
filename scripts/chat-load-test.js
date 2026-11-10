#!/usr/bin/env node
/* eslint-disable */
// C1 chat load test: N concurrent sockets, M messages per second.
//
//   npm run chat:load-test -- --url=http://localhost:3000 --sockets=200 --rate=50 --seconds=30
//
// Creates sockets/2 throw-away conversations (sockets users) directly in the
// LOCAL database the API uses (refuses any other host), signs access tokens
// with JWT_SECRET, connects every user to /chat over WebSocket, then sends
// `rate` messages per second through message:send from random participants.
// Measures, per message:
//   ack       = send -> server ack (saved, seq assigned)
//   delivery  = send -> the other participant's message:new
// and prints p50/p95/p99, error codes and lost messages. Test users and
// conversations are removed at the end (--keep to leave them).

const { randomUUID } = require('crypto');
const { parseArgs, connect, dbConfig, isLocalHost } = require('./lib/common');
const jwt = require('jsonwebtoken');
const { io } = require('socket.io-client');

const pct = (sorted, p) =>
  sorted.length
    ? sorted[
        Math.min(
          sorted.length - 1,
          Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
        )
      ]
    : 0;
const stats = (list) => {
  const s = [...list].sort((a, b) => a - b);
  const r = (v) => Math.round(v * 10) / 10;
  return {
    count: s.length,
    p50: r(pct(s, 50)),
    p95: r(pct(s, 95)),
    p99: r(pct(s, 99)),
    max: r(s[s.length - 1] ?? 0),
  };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const args = parseArgs();
  const url = (
    args.url || `http://localhost:${process.env.PORT || 3000}`
  ).replace(/\/$/, '');
  const nSockets = Number(args.sockets || 200);
  const rate = Number(args.rate || 50);
  const seconds = Number(args.seconds || 30);
  if (!isLocalHost(dbConfig(args).host)) {
    console.error('The load test only runs against a local database.');
    process.exit(2);
  }
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is required');

  const { client } = await connect(args);
  const run = randomUUID().slice(0, 8);
  const users = [];
  const convs = [];
  try {
    console.log(
      `Creating ${nSockets} users and ${nSockets / 2} conversations…`,
    );
    for (let i = 0; i < nSockets; i++) {
      const r = await client.query(
        `INSERT INTO users (email, "passwordHash", username, "emailVerifiedAt")
         VALUES ($1, 'x', $2, now()) RETURNING id`,
        [`load-${run}-${i}@test.campussales.ng`, `load_${run}_${i}`],
      );
      users.push(r.rows[0].id);
    }
    for (let i = 0; i < nSockets / 2; i++) {
      const a = users[i];
      const b = users[i + nSockets / 2];
      const [lo, hi] = [a, b].sort();
      const r = await client.query(
        `INSERT INTO conversations (type, "userLowId", "userHighId") VALUES ('direct', $1, $2) RETURNING id`,
        [lo, hi],
      );
      await client.query(
        `INSERT INTO conversation_participants ("conversationId", "userId", "lastMessageAt") VALUES ($1, $2, now()), ($1, $3, now())`,
        [r.rows[0].id, a, b],
      );
      convs.push({ id: r.rows[0].id, a, b });
    }

    const pending = new Map(); // clientMessageId -> { sentAt, to }
    const ackMs = [];
    const deliveryMs = [];
    const errors = {};
    let reconnects = 0;

    console.log(`Connecting ${nSockets} sockets to ${url}/chat…`);
    const t0 = Date.now();
    const sockets = new Map();
    await Promise.all(
      users.map(
        (id) =>
          new Promise((resolve, reject) => {
            const token = jwt.sign({ sub: id }, secret, { expiresIn: '1h' });
            const s = io(`${url}/chat`, {
              auth: { token },
              transports: ['websocket'],
              forceNew: true,
            });
            s.on('message:new', (m, ack) => {
              if (typeof ack === 'function') ack({ ok: true });
              const p = pending.get(m.clientMessageId);
              if (p && p.to === id) {
                deliveryMs.push(Date.now() - p.sentAt);
                pending.delete(m.clientMessageId);
              }
            });
            s.io.on('reconnect', () => reconnects++);
            s.once('connected', () => {
              sockets.set(id, s);
              resolve();
            });
            s.once('connect_error', reject);
          }),
      ),
    );
    console.log(
      `Connected in ${Date.now() - t0} ms. Sending ${rate} msg/s for ${seconds} s…`,
    );

    let sent = 0;
    const total = rate * seconds;
    const interval = 1000 / rate;
    const start = Date.now();
    const inflight = [];
    for (let i = 0; i < total; i++) {
      const due = start + i * interval;
      const wait = due - Date.now();
      if (wait > 0) await sleep(wait);
      const c = convs[Math.floor(Math.random() * convs.length)];
      const fromA = Math.random() < 0.5;
      const from = fromA ? c.a : c.b;
      const to = fromA ? c.b : c.a;
      const clientMessageId = randomUUID();
      const sentAt = Date.now();
      pending.set(clientMessageId, { sentAt, to });
      sent++;
      inflight.push(
        sockets
          .get(from)
          .timeout(10_000)
          .emitWithAck('message:send', {
            conversationId: c.id,
            clientMessageId,
            text: `load ${i}`,
          })
          .then((ack) => {
            if (ack && ack.ok) ackMs.push(Date.now() - sentAt);
            else {
              const code = (ack && ack.error && ack.error.code) || 'UNKNOWN';
              errors[code] = (errors[code] || 0) + 1;
              pending.delete(clientMessageId);
            }
          })
          .catch(() => {
            errors.ACK_TIMEOUT = (errors.ACK_TIMEOUT || 0) + 1;
          }),
      );
    }
    await Promise.all(inflight);
    await sleep(2000);
    const elapsed = (Date.now() - start) / 1000;
    for (const s of sockets.values()) s.disconnect();

    const report = {
      sockets: nSockets,
      targetRate: rate,
      achievedRate: Math.round((sent / elapsed) * 10) / 10,
      sent,
      acked: ackMs.length,
      delivered: deliveryMs.length,
      lost: pending.size,
      errors,
      reconnects,
      ackMs: stats(ackMs),
      deliveryMs: stats(deliveryMs),
    };
    console.log(JSON.stringify(report, null, 2));
    return report;
  } finally {
    if (!args.keep) {
      await client.query(
        `DELETE FROM conversations WHERE id = ANY($1::uuid[])`,
        [convs.map((c) => c.id)],
      );
      await client.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [
        users,
      ]);
    }
    await client.end();
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e.message);
    process.exit(1);
  },
);
