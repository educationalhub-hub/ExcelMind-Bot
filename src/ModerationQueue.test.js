import test from 'node:test';
import assert from 'node:assert/strict';
import { ModerationQueue } from './ModerationQueue.js';

function message(id, group = 'test@g.us') {
  return { key: { id, remoteJid: group }, message: { conversation: 'https://example.com' } };
}

function setup(t, overrides = {}) {
  const processed = [];
  const errors = [];
  const drops = [];
  const queue = new ModerationQueue({
    isReady: () => true,
    process: async msg => { processed.push(msg.key.id); },
    shouldRetry: error => error.message === 'Connection Closed',
    onError: error => errors.push(error.message),
    onDrop: (msg, reason) => drops.push({ id: msg.key.id, reason }),
    ...overrides,
  });
  t.after(() => queue.clear());
  return { queue, processed, errors, drops };
}

test('buffers messages until ready and processes the entire delivered batch', async t => {
  let ready = false;
  const { queue, processed } = setup(t, { isReady: () => ready });
  queue.add([message('one'), message('two')]);
  await queue.drain();
  assert.deepEqual(processed, []);
  assert.equal(queue.pending.size, 2);
  ready = true;
  await queue.drain();
  assert.deepEqual(processed, ['one', 'two']);
  assert.equal(queue.pending.size, 0);
});

test('deduplicates queued and already processed replays within each group', async t => {
  const { queue, processed } = setup(t);
  queue.add([message('same'), message('same')]);
  await queue.drain();
  queue.add([message('same'), message('same', 'other@g.us')]);
  await queue.drain();
  assert.deepEqual(processed, ['same', 'same']);
});

test('serializes overlapping batches without double processing the in-flight message', async t => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const processed = [];
  const { queue } = setup(t, { process: async msg => {
    if (msg.key.id === 'one') await blocked;
    processed.push(msg.key.id);
  } });
  queue.add([message('one')]);
  const first = queue.drain();
  queue.add([message('one'), message('two')]);
  const second = queue.drain();
  release();
  await Promise.all([first, second]);
  assert.deepEqual(processed, ['one', 'two']);
});

test('retains the in-flight message if its deletion fails during disconnect', async t => {
  let ready = true;
  let attempts = 0;
  const { queue, errors } = setup(t, {
    isReady: () => ready,
    process: async () => {
      if (++attempts === 1) { ready = false; throw new Error('Connection Closed'); }
    },
  });
  queue.add([message('retry')]);
  await queue.drain();
  assert.equal(queue.pending.size, 1);
  assert.deepEqual(errors, []);
  ready = true;
  await queue.drain();
  assert.equal(attempts, 2);
  assert.equal(queue.pending.size, 0);
});

test('retries a ready-socket timeout after three seconds, without requiring new traffic', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let attempts = 0;
  const { queue } = setup(t, { process: async () => {
    if (++attempts === 1) throw new Error('Connection Closed');
  } });
  queue.add([message('retry')]);
  await queue.drain();
  assert.equal(attempts, 1);
  t.mock.timers.tick(3000);
  await queue.drain();
  assert.equal(attempts, 2);
  assert.equal(queue.pending.size, 0);
});

test('logs permanent deletion errors and still processes the rest of the batch', async t => {
  const processed = [];
  const { queue, errors } = setup(t, { process: async msg => {
    if (msg.key.id === 'bad') throw new Error('Permission denied');
    processed.push(msg.key.id);
  } });
  queue.add([message('bad'), message('good')]);
  await queue.drain();
  assert.deepEqual(errors, ['Permission denied']);
  assert.deepEqual(processed, ['good']);
});

test('bounds retries and continues after a repeatedly failing message', async t => {
  const processed = [];
  const { queue, errors } = setup(t, { process: async msg => {
    if (msg.key.id === 'bad') throw new Error('Connection Closed');
    processed.push(msg.key.id);
  } });
  queue.add([message('bad'), message('good')]);
  for (let i = 0; i < 4; i++) await queue.drain();
  assert.deepEqual(errors, ['Connection Closed']);
  assert.deepEqual(processed, ['good']);
  assert.equal(queue.pending.size, 0);
});

test('bounds backlog memory and reports messages it cannot retain', async t => {
  const { queue, drops } = setup(t, { maxSize: 2, isReady: () => false });
  queue.add([message('one'), message('two'), message('three')]);
  assert.equal(queue.pending.size, 2);
  assert.equal(drops[0].id, 'three');
});

test('expires stale queued messages instead of retaining them indefinitely', async t => {
  const { queue, drops, processed } = setup(t, { retentionMs: 0 });
  queue.add([message('old')]);
  await queue.drain();
  assert.deepEqual(processed, []);
  assert.equal(drops[0].id, 'old');
  assert.equal(queue.pending.size, 0);
});

test('ignores direct chats, own messages and incomplete message keys', async t => {
  const { queue, processed } = setup(t);
  const own = message('own');
  own.key.fromMe = true;
  queue.add([message('dm', 'person@s.whatsapp.net'), own, {}, null]);
  await queue.drain();
  assert.deepEqual(processed, []);
  assert.equal(queue.pending.size, 0);
});

test('clearing the queue during a request does not restore deduplication state', async t => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const { queue } = setup(t, { process: async () => blocked });
  queue.add([message('one')]);
  const drain = queue.drain();
  queue.clear();
  release();
  await drain;
  assert.equal(queue.pending.size, 0);
  assert.equal(queue.completed.size, 0);
});
