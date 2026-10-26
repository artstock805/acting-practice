// 실행: node --test
const test = require('node:test');
const assert = require('node:assert');
const { createServer } = require('./server.js');

async function withServer(opts, fn) {
  const server = createServer(opts);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { server.close(); }
}

const post = (base, body) => fetch(`${base}/api/tts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const VOICE = 'ko-KR-Chirp3-HD-Kore';

test('POST /api/tts returns mp3 audio for a catalog voice', async () => {
  const calls = [];
  const synthesize = async (args) => { calls.push(args); return Buffer.from('ID3fake'); };
  await withServer({ synthesize }, async (base) => {
    const res = await post(base, { text: '  늦었네.  ', voice: VOICE, rate: 1.1 });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('content-type'), 'audio/mpeg');
    assert.strictEqual(Buffer.from(await res.arrayBuffer()).toString(), 'ID3fake');
  });
  assert.deepStrictEqual(calls, [{ text: '늦었네.', voice: VOICE, rate: 1.1 }]);
});

test('the same request is served from cache without calling Google again', async () => {
  let count = 0;
  const synthesize = async () => { count++; return Buffer.from('mp3'); };
  await withServer({ synthesize }, async (base) => {
    await post(base, { text: '안녕', voice: VOICE, rate: 1 });
    const again = await post(base, { text: '안녕', voice: VOICE, rate: 1 });
    assert.strictEqual(again.status, 200);
  });
  assert.strictEqual(count, 1);
});

test('unknown voices, empty or overlong text and bad JSON are rejected without calling Google', async () => {
  let count = 0;
  const synthesize = async () => { count++; return Buffer.from('x'); };
  await withServer({ synthesize }, async (base) => {
    assert.strictEqual((await post(base, { text: '안녕', voice: 'en-US-Evil' })).status, 400);
    assert.strictEqual((await post(base, { text: '   ', voice: VOICE })).status, 400);
    assert.strictEqual((await post(base, { text: '가'.repeat(401), voice: VOICE })).status, 400);
    const bad = await fetch(`${base}/api/tts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
    assert.strictEqual(bad.status, 400);
  });
  assert.strictEqual(count, 0);
});

test('speaking rate is clamped to the allowed range', async () => {
  const rates = [];
  const synthesize = async ({ rate }) => { rates.push(rate); return Buffer.from('x'); };
  await withServer({ synthesize }, async (base) => {
    await post(base, { text: '하나', voice: VOICE, rate: 9 });
    await post(base, { text: '둘', voice: VOICE, rate: 0.1 });
  });
  assert.deepStrictEqual(rates, [1.4, 0.7]);
});

test('the daily character budget stops synthesis once used up', async () => {
  const synthesize = async () => Buffer.from('x');
  await withServer({ synthesize, ttsDailyChars: 5 }, async (base) => {
    assert.strictEqual((await post(base, { text: '가나다', voice: VOICE })).status, 200);
    const over = await post(base, { text: '라마바', voice: VOICE });
    assert.strictEqual(over.status, 429);
    assert.match((await over.json()).error, /오늘/);
  });
});

test('upstream failures are hidden behind a generic 502', async () => {
  const synthesize = async () => { throw new Error('secret upstream detail'); };
  await withServer({ synthesize }, async (base) => {
    const res = await post(base, { text: '안녕', voice: VOICE });
    assert.strictEqual(res.status, 502);
    assert.doesNotMatch(await res.text(), /secret/);
  });
});

test('one client cannot use more than its own daily share of synthesis', async () => {
  const synthesize = async () => Buffer.from('x');
  await withServer({ synthesize, ttsDailyChars: 100, ttsDailyCharsPerClient: 4 }, async (base) => {
    assert.strictEqual((await post(base, { text: '가나', voice: VOICE })).status, 200);
    assert.strictEqual((await post(base, { text: '다라', voice: VOICE })).status, 200);
    assert.strictEqual((await post(base, { text: '마바', voice: VOICE })).status, 429);
  });
});

test('a failed synthesis does not use up the daily budget', async () => {
  let fail = true;
  const synthesize = async () => { if (fail) throw new Error('down'); return Buffer.from('x'); };
  await withServer({ synthesize, ttsDailyChars: 3 }, async (base) => {
    assert.strictEqual((await post(base, { text: '가나다', voice: VOICE })).status, 502);
    fail = false;
    assert.strictEqual((await post(base, { text: '가나다', voice: VOICE })).status, 200);
  });
});

test('English Google voices are accepted and synthesized in English', async () => {
  const calls = [];
  const synthesize = async (args) => { calls.push(args); return Buffer.from('x'); };
  await withServer({ synthesize }, async (base) => {
    assert.strictEqual((await post(base, { text: 'You are still here.', voice: 'en-US-Chirp3-HD-Kore' })).status, 200);
    assert.strictEqual((await post(base, { text: 'Bonjour', voice: 'fr-FR-Chirp3-HD-Kore' })).status, 400);
  });
  assert.strictEqual(calls[0].voice, 'en-US-Chirp3-HD-Kore');
});
