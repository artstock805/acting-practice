// 실행: node --test
const test = require('node:test');
const assert = require('node:assert');
const { createServer } = require('./server.js');
const { readingMarkup, createGoogleSynthesizer } = require('./tts.js');

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

// 의미읽기: 의미 단위에서 쉬도록 Chirp 3의 쉼 표시([pause …])를 넣음 (그냥 글자로 보내면 문장 끝에서만 쉼)
test('a "..." inside a line gets a long pause, one at the end does not', () => {
  assert.strictEqual(readingMarkup('그건...', VOICE), '그건...');
  assert.strictEqual(readingMarkup('혹시 웃어 주면 어떡하나... 근데 컵만 닦았어.', VOICE), '혹시 웃어 주면 어떡하나... [pause long] 근데 컵만 닦았어.');
  assert.strictEqual(readingMarkup('그건… 미안해.', VOICE), '그건… [pause long] 미안해.');
});

test('sentences inside one line are separated by a pause', () => {
  assert.strictEqual(readingMarkup('쉬워서 하는 말 아니야. 3년 동안 매일 연습한 말이야.', VOICE), '쉬워서 하는 말 아니야. [pause] 3년 동안 매일 연습한 말이야.');
  assert.strictEqual(readingMarkup('진심이야? 아니.', VOICE), '진심이야? [pause] 아니.');
});

test('a long sentence without commas gets short breaths after connecting endings', () => {
  assert.strictEqual(readingMarkup('3년 만에 갑자기 나타나서 커피 한 잔 시켜 놓고 두 시간째야.', VOICE),
    '3년 만에 갑자기 나타나서 [pause short] 커피 한 잔 시켜 놓고 [pause short] 두 시간째야.');
  assert.strictEqual(readingMarkup('할 말 있으면 해.', VOICE), '할 말 있으면 해.');                  // 짧은 문장은 끊지 않음
  assert.strictEqual(readingMarkup('시험은 세 번 떨어졌고, 통장엔 돈이 없었어.', VOICE), '시험은 세 번 떨어졌고, 통장엔 돈이 없었어.');   // 쉼표가 이미 끊어 줌
});

test('dashes pause, English lines skip the Korean ending rule, plain lines stay as they are', () => {
  assert.strictEqual(readingMarkup('잠깐 — 그게 무슨 말이야?', VOICE), '잠깐 — [pause] 그게 무슨 말이야?');
  assert.strictEqual(readingMarkup('Wait... I mean it. Really.', 'en-US-Chirp3-HD-Kore'), 'Wait... [pause long] I mean it. [pause] Really.');
  assert.strictEqual(readingMarkup('늦었네.', VOICE), '늦었네.');
});

test('Google gets markup only when pauses were added', async () => {
  const sent = [];
  const original = global.fetch;
  global.fetch = async (_url, init) => { sent.push(JSON.parse(init.body).input); return { ok: true, json: async () => ({ audioContent: '' }) }; };
  try {
    const synthesize = createGoogleSynthesizer({ getAuth: async () => ({ token: 't' }), timeoutMs: 1000 });
    await synthesize({ text: '늦었네.', voice: VOICE, rate: 1 });
    await synthesize({ text: '진심이야? 아니.', voice: VOICE, rate: 1 });
  } finally { global.fetch = original; }
  assert.deepStrictEqual(sent, [{ text: '늦었네.' }, { markup: '진심이야? [pause] 아니.' }]);
});
