import test from 'node:test';
import assert from 'node:assert/strict';
import { RequestQueue, MemoryStorage } from '../../src/queue.js';

const mk = (o = {}) => new RequestQueue({ storage: new MemoryStorage(), ...o });

test('enqueue persists in order', () => {
  const q = mk();
  q.enqueue({ prompt: 'a' }); q.enqueue({ prompt: 'b' });
  assert.deepEqual(q.list().map((i) => i.request.prompt), ['a', 'b']);
});

test('queue survives a new instance on the same storage (page reload)', () => {
  const storage = new MemoryStorage();
  new RequestQueue({ storage }).enqueue({ prompt: 'x' });
  assert.equal(new RequestQueue({ storage }).size(), 1);
});

test('overflow drops oldest', () => {
  const q = mk({ maxItems: 2 });
  q.enqueue({ prompt: '1' }); q.enqueue({ prompt: '2' });
  const { dropped } = q.enqueue({ prompt: '3' });
  assert.equal(dropped, 1);
  assert.deepEqual(q.list().map((i) => i.request.prompt), ['2', '3']);
});

test('replay sends in order and empties the queue', async () => {
  const q = mk();
  ['a', 'b', 'c'].forEach((p) => q.enqueue({ prompt: p }));
  const sent = [];
  const s = await q.replay(async (r) => { sent.push(r.prompt); return { text: r.prompt.toUpperCase() }; });
  assert.deepEqual(sent, ['a', 'b', 'c']);
  assert.equal(s.remaining, 0);
  assert.equal(q.size(), 0);
});

test('replay stops at first failure and keeps order', async () => {
  const q = mk();
  ['a', 'b', 'c'].forEach((p) => q.enqueue({ prompt: p }));
  const s = await q.replay(async (r) => { if (r.prompt === 'b') throw new Error('503'); return { text: 'ok' }; });
  assert.equal(s.replayed.length, 1);
  assert.deepEqual(q.list().map((i) => i.request.prompt), ['b', 'c']);
  assert.equal(q.list()[0].attempts, 1);
});

test('corrupted storage reads as empty', () => {
  const storage = new MemoryStorage();
  storage.setItem('edge-fallback-queue', '{not json');
  assert.equal(new RequestQueue({ storage }).size(), 0);
});
