// 실행: node --test
const test = require('node:test');
const assert = require('node:assert');
const { createPortraitQueue } = require('./portraitqueue.js');

// 가짜 시계·저장소·그림 서비스: 요청 시각과 기다린 시간을 기록
function fakeWorld(serve) {
  let clock = 0;
  const fetched = [];
  const store = new Map();
  const cache = {
    match: async (url) => (store.has(url) ? new Response(store.get(url)) : undefined),
    put: async (url, res) => { store.set(url, await res.blob()); },
  };
  const queue = createPortraitQueue({
    fetchImpl: async (url) => { fetched.push({ url, at: clock }); return serve(url, fetched.length); },
    openCache: async () => cache,
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
    makeUrl: (blob) => `blob:${blob.size}:${fetched.length}`,
    minGapMs: 46_000,
  });
  return { queue, fetched, store, at: () => clock };
}
const jpeg = () => new Response(new Blob([new Uint8Array(10)], { type: 'image/jpeg' }), { status: 200 });
const limited = (seconds) => new Response('{"error":{"code":"FREE_LIMIT"}}', { status: 402, headers: { 'Retry-After': String(seconds) } });

test('portraits are fetched one at a time with a gap, and saved', async () => {
  const w = fakeWorld(() => jpeg());
  const [a, b] = await Promise.all([w.queue.request('A'), w.queue.request('B')]);
  assert.match(a, /^blob:/);
  assert.match(b, /^blob:/);
  assert.deepStrictEqual(w.fetched.map((f) => f.url), ['A', 'B']);
  assert.ok(w.fetched[1].at - w.fetched[0].at >= 46_000);
  assert.ok(w.store.has('A') && w.store.has('B'));
  assert.strictEqual(w.queue.ready('A'), a);
});

test('a saved portrait comes back at once without asking the service', async () => {
  const w = fakeWorld(() => jpeg());
  await w.queue.request('A');
  const again = createPortraitQueue({
    fetchImpl: async () => { throw new Error('should not fetch'); },
    openCache: async () => ({ match: async (url) => (w.store.has(url) ? new Response(w.store.get(url)) : undefined), put: async () => {} }),
    sleep: async () => {}, now: () => 0, makeUrl: () => 'blob:saved', minGapMs: 46_000,
  });
  assert.strictEqual(await again.request('A'), 'blob:saved');
});

test('when the free limit is reached it waits as told and tries again', async () => {
  const w = fakeWorld((url, n) => (n === 1 ? limited(38) : jpeg()));
  await w.queue.request('A');
  assert.strictEqual(w.fetched.length, 2);
  assert.ok(w.fetched[1].at - w.fetched[0].at >= 38_000);
});

test('the role speaking now jumps ahead of the queue', async () => {
  const w = fakeWorld(() => jpeg());
  const done = [w.queue.request('A'), w.queue.request('B'), w.queue.request('C')];
  w.queue.request('C', { urgent: true });
  await Promise.all(done);
  assert.deepStrictEqual(w.fetched.map((f) => f.url), ['A', 'C', 'B']);
});

test('listeners hear when a portrait is ready; a broken one can be asked for again', async () => {
  let fail = true;
  const w = fakeWorld(() => (fail ? new Response('oops', { status: 500 }) : jpeg()));
  const heard = [];
  w.queue.onReady((url) => heard.push(url));
  await assert.rejects(w.queue.request('A'));
  assert.strictEqual(w.queue.ready('A'), null);
  fail = false;
  await w.queue.request('A');
  assert.deepStrictEqual(heard, ['A']);
});
