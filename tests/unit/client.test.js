import test from 'node:test';
import assert from 'node:assert/strict';
import { EdgeFallbackClient } from '../../src/client.js';
import { RequestQueue, MemoryStorage } from '../../src/queue.js';
import { callCloud, CloudUnavailable, CloudClientError } from '../../src/cloud.js';

const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
const engine = { name: 'fake', generate: async (p) => `local:${p}` };

function client(fetchImpl, o = {}) {
  let t = 0;
  return new EdgeFallbackClient({
    cloudUrl: '/api/chat', healthUrl: '/api/health', fetchImpl, localEngine: engine,
    queue: new RequestQueue({ storage: new MemoryStorage() }), timeoutMs: 50, cooldownMs: 1000,
    now: o.now || (() => t), ...o,
  });
}

test('cloud OK -> cloud answer, nothing queued', async () => {
  const c = client(async () => json(200, { text: 'hi' }));
  const r = await c.ask('q');
  assert.equal(r.source, 'cloud'); assert.equal(r.text, 'hi'); assert.equal(c.queue.size(), 0);
});

test('503 -> local fallback and queued', async () => {
  const c = client(async () => new Response('busy', { status: 503 }));
  const r = await c.ask('q');
  assert.equal(r.source, 'local'); assert.equal(r.text, 'local:q'); assert.equal(r.reason, 'http_5xx');
  assert.equal(c.queue.size(), 1);
});

test('timeout -> local fallback with reason timeout', async () => {
  const hang = (_u, { signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('aborted'))));
  const c = client(hang, { now: () => performance.now() });
  const r = await c.ask('q');
  assert.equal(r.source, 'local'); assert.equal(r.reason, 'timeout');
  assert.ok(r.fallbackDecisionMs >= 45, `decision ${r.fallbackDecisionMs}`);
});

test('network error -> reason network', async () => {
  const c = client(async () => { throw new TypeError('Failed to fetch'); });
  assert.equal((await c.ask('q')).reason, 'network');
});

test('4xx is a caller error: thrown, not masked by fallback', async () => {
  const c = client(async () => json(400, { error: 'bad' }));
  await assert.rejects(c.ask('q'), CloudClientError);
  assert.equal(c.queue.size(), 0);
});

test('breaker skips cloud during cooldown, then retries', async () => {
  let t = 0; let calls = 0;
  const c = client(async () => { calls++; return new Response('', { status: 503 }); }, { now: () => t });
  await c.ask('a'); t = 500; const r = await c.ask('b');
  assert.equal(calls, 1); assert.equal(r.reason, 'breaker_open');
  t = 1500; await c.ask('c'); assert.equal(calls, 2);
});

test('no local engine -> queued result', async () => {
  const c = client(async () => new Response('', { status: 503 }), { localEngine: null });
  const r = await c.ask('q');
  assert.equal(r.source, 'queued'); assert.equal(r.text, null); assert.equal(c.queue.size(), 1);
});

test('local engine throws -> queued, event emitted', async () => {
  const events = [];
  const c = client(async () => new Response('', { status: 503 }), {
    localEngine: { name: 'x', generate: async () => { throw new Error('OOM'); } }, onEvent: (e) => events.push(e.type),
  });
  assert.equal((await c.ask('q')).source, 'queued');
  assert.ok(events.includes('local_failed'));
});

test('replayIfHealthy: skips while unhealthy, replays when healthy', async () => {
  let up = false;
  const f = async (url) => {
    if (url === '/api/health') return new Response('', { status: up ? 200 : 503 });
    return up ? json(200, { text: 'cloud' }) : new Response('', { status: 503 });
  };
  const c = client(f);
  await c.ask('q1'); await c.ask('q2');
  assert.equal((await c.replayIfHealthy()).skipped, 'unhealthy');
  up = true;
  const got = [];
  const s = await c.replayIfHealthy((item, res) => got.push([item.request.prompt, res.text]));
  assert.deepEqual(got, [['q1', 'cloud'], ['q2', 'cloud']]);
  assert.equal(s.remaining, 0); assert.equal(c.breakerOpen(), false);
});

test('callCloud rejects a 200 without text field', async () => {
  await assert.rejects(callCloud({ fetchImpl: async () => json(200, { nope: 1 }), url: '/x', body: {} }), CloudClientError);
});

test('429 is treated as unavailable', async () => {
  await assert.rejects(callCloud({ fetchImpl: async () => new Response('', { status: 429 }), url: '/x', body: {} }),
    (e) => e instanceof CloudUnavailable && e.reason === 'http_429');
});
