import { test } from 'node:test';
import assert from 'node:assert/strict';

import { generateSecretKey, getPublicKey, bytesToHex } from './primitives.js';
import { signEvent, type NostrEvent, type UnsignedEvent } from './event.js';
import { FakeRelay } from './fake-relay.js';
import { matchesFilter, Relay, RelayError } from './relay.js';

const secretKey = generateSecretKey();
const pubkey = bytesToHex(getPublicKey(secretKey));

async function make(
  content: string,
  overrides: Partial<UnsignedEvent> = {},
): Promise<NostrEvent> {
  const unsigned: UnsignedEvent = {
    pubkey,
    created_at: 1_700_000_000,
    kind: 9078,
    tags: [],
    content,
    ...overrides,
  };
  return signEvent(unsigned, secretKey);
}

function client(relay: FakeRelay, timeoutMs = 200): Relay {
  return new Relay(relay.url, { socket: relay.connect, timeoutMs });
}

test('a published event reaches the relay and the OK resolves', async () => {
  const relay = new FakeRelay();
  const connection = client(relay);
  const event = await make('hello');

  await connection.publish(event);

  assert.equal(relay.events.length, 1);
  assert.equal(relay.events[0]?.id, event.id);
  connection.close();
});

test('a rejected publish surfaces the relay reason', async () => {
  const relay = new FakeRelay();
  relay.faults.rejectPublish = 'blocked: pubkey not on the allow list';
  const connection = client(relay);

  const event = await make('hello');
  await assert.rejects(
    () => connection.publish(event),
    (error: unknown) =>
      error instanceof RelayError && error.message.includes('not on the allow list'),
  );
  connection.close();
});

test('a relay that never says OK times out rather than reporting success', async () => {
  const relay = new FakeRelay();
  relay.faults.dropOk = true;
  const connection = client(relay, 50);

  const event = await make('hello');
  await assert.rejects(() => connection.publish(event), /timed out waiting for OK/);
  connection.close();
});

test('a query returns the stored events matching the filter', async () => {
  const relay = new FakeRelay();
  relay.seed(await make('one', { created_at: 100 }));
  relay.seed(await make('two', { created_at: 200 }));
  relay.seed(await make('three', { created_at: 300 }));
  const connection = client(relay);

  const found = await connection.query([{ kinds: [9078], authors: [pubkey], since: 200 }]);

  assert.deepEqual(
    found.map((event) => event.content).sort(),
    ['three', 'two'],
  );
  connection.close();
});

test('an empty result is an empty array, not a hang', async () => {
  const relay = new FakeRelay();
  const connection = client(relay);
  assert.deepEqual(await connection.query([{ kinds: [9078] }]), []);
  connection.close();
});

test('a tampered event is discarded: the id no longer matches the contents', async () => {
  const relay = new FakeRelay();
  relay.faults.tamper = true;
  relay.seed(await make('the real card'));
  const notices: string[] = [];
  const connection = new Relay(relay.url, {
    socket: relay.connect,
    timeoutMs: 200,
    onNotice: (message) => notices.push(message),
  });

  assert.deepEqual(await connection.query([{ kinds: [9078] }]), []);
  assert.ok(notices.some((notice) => notice.includes('bad-id')), notices.join('; '));
  connection.close();
});

test('an event nobody asked for is discarded even though it verifies', async () => {
  // Signed by a different key: perfectly valid, and none of our business.
  const stranger = generateSecretKey();
  const strangerKey = bytesToHex(getPublicKey(stranger));
  const intruder = await signEvent(
    { pubkey: strangerKey, created_at: 1_700_000_000, kind: 9078, tags: [], content: 'theirs' },
    stranger,
  );

  const relay = new FakeRelay();
  relay.faults.injectUnrequested = intruder;
  relay.seed(await make('ours'));

  const notices: string[] = [];
  const connection = new Relay(relay.url, {
    socket: relay.connect,
    timeoutMs: 200,
    onNotice: (message) => notices.push(message),
  });

  const found = await connection.query([{ kinds: [9078], authors: [pubkey] }]);

  assert.deepEqual(found.map((event) => event.content), ['ours']);
  assert.ok(notices.some((notice) => notice.includes('matched no filter')), notices.join('; '));
  connection.close();
});

test('a relay repeating one event does not repeat it to the caller', async () => {
  const relay = new FakeRelay();
  relay.faults.duplicate = 5;
  relay.seed(await make('once'));
  const connection = client(relay);

  const found = await connection.query([{ kinds: [9078] }]);

  assert.equal(found.length, 1);
  connection.close();
});

test('a flood is cut off at maxEvents instead of growing without bound', async () => {
  const relay = new FakeRelay();
  for (let i = 0; i < 40; i += 1) relay.seed(await make(`event ${i}`, { created_at: 1000 + i }));
  const connection = new Relay(relay.url, {
    socket: relay.connect,
    timeoutMs: 500,
    maxEvents: 10,
  });

  const found = await connection.query([{ kinds: [9078] }]);

  assert.equal(found.length, 10);
  connection.close();
});

test('events already received survive a relay that never sends EOSE', async () => {
  const relay = new FakeRelay();
  relay.faults.dropEose = true;
  relay.seed(await make('kept'));
  const connection = client(relay, 60);

  // The timeout fires, but throwing away verified events would make a slow
  // relay indistinguishable from a broken one.
  const found = await connection.query([{ kinds: [9078] }]);
  assert.deepEqual(found.map((event) => event.content), ['kept']);
  connection.close();
});

test('a silent relay with nothing to give times out', async () => {
  const relay = new FakeRelay();
  relay.faults.dropEose = true;
  const connection = client(relay, 60);

  await assert.rejects(() => connection.query([{ kinds: [9078] }]), /timed out waiting for EOSE/);
  connection.close();
});

test('a CLOSED with no events rejects with the relay reason', async () => {
  const relay = new FakeRelay();
  relay.faults.closeSubscriptions = 'rate-limited: slow down';
  const connection = client(relay);

  await assert.rejects(() => connection.query([{ kinds: [9078] }]), /slow down/);
  connection.close();
});

test('a closed relay fails cleanly instead of hanging', async () => {
  const relay = new FakeRelay();
  const connection = client(relay);
  await connection.connect();
  connection.close();

  await assert.rejects(() => connection.query([{ kinds: [9078] }]), /closed/);
});

test('oversized and unparseable messages are dropped, not thrown', async () => {
  const relay = new FakeRelay();
  relay.seed(await make('x'.repeat(200)));
  const notices: string[] = [];
  const connection = new Relay(relay.url, {
    socket: relay.connect,
    timeoutMs: 200,
    maxMessageChars: 100,
    onNotice: (message) => notices.push(message),
  });

  assert.deepEqual(await connection.query([{ kinds: [9078] }]), []);
  assert.ok(notices.some((notice) => notice.includes('oversized')), notices.join('; '));
  connection.close();
});

test('matchesFilter agrees with NIP-01 on tags and bounds', async () => {
  const event = await make('tagged', { created_at: 500, tags: [['d', 'device-a'], ['e', 'x']] });

  assert.ok(matchesFilter(event, {}));
  assert.ok(matchesFilter(event, { kinds: [9078], authors: [pubkey] }));
  assert.ok(matchesFilter(event, { since: 500, until: 500 }));
  assert.ok(!matchesFilter(event, { since: 501 }));
  assert.ok(!matchesFilter(event, { until: 499 }));
  assert.ok(matchesFilter(event, { '#d': ['device-a', 'device-b'] }));
  assert.ok(!matchesFilter(event, { '#d': ['device-b'] }));
  assert.ok(!matchesFilter(event, { '#p': ['device-a'] }));
  assert.ok(!matchesFilter(event, { ids: ['00'.repeat(32)] }));
});
