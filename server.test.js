// 실행: node --test
const test = require('node:test');
const assert = require('node:assert');
const { createServer, createRateLimiter, validateWav, parseWavHeader, MAX_AUDIO_SECONDS } = require('./server.js');
const { encodeWav } = require('./audiokit.js');

const wavOf = (seconds, rate = 16000) => Buffer.from(encodeWav(new Float32Array(Math.round(seconds * rate)), rate));

async function withServer(opts, fn) {
  const server = createServer(opts);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { server.close(); }
}

test('parseWavHeader rejects non-WAV data', () => {
  assert.strictEqual(parseWavHeader(Buffer.from('not a wav file at all, just some text padding....')), null);
});

test('validateWav enforces format and length limits', () => {
  assert.strictEqual(validateWav(parseWavHeader(wavOf(1))), null);
  assert.match(validateWav(parseWavHeader(wavOf(MAX_AUDIO_SECONDS + 1, 8000))), /너무 깁니다/);
  assert.match(validateWav(null), /WAV/);
});

test('rate limiter allows max requests per window per key', () => {
  let now = 0;
  const allow = createRateLimiter({ max: 2, windowMs: 1000 }, () => now);
  assert.deepStrictEqual([allow('a'), allow('a'), allow('a'), allow('b')], [true, true, false, true]);
  now = 1000;
  assert.strictEqual(allow('a'), true);
});

test('POST /api/stt transcribes a valid WAV', async () => {
  let got = null;
  await withServer({ transcribe: async (_wav, info) => { got = info; return '늦었네'; } }, async (base) => {
    const res = await fetch(`${base}/api/stt`, { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wavOf(1) });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { text: '늦었네' });
    assert.strictEqual(got.sampleRate, 16000);
  });
});

test('POST /api/stt rejects wrong type, oversized and invalid audio without calling Google', async () => {
  let calls = 0;
  await withServer({ transcribe: async () => { calls++; return ''; } }, async (base) => {
    const post = (body, type = 'audio/wav') => fetch(`${base}/api/stt`, { method: 'POST', headers: { 'Content-Type': type }, body });
    assert.strictEqual((await post('hello', 'text/plain')).status, 415);
    assert.strictEqual((await post(Buffer.alloc(1024 * 1024 + 1))).status, 413);
    assert.strictEqual((await post(Buffer.from('RIFF....garbage'))).status, 400);
  });
  assert.strictEqual(calls, 0);
});

test('POST /api/stt hides upstream error details', async () => {
  await withServer({ transcribe: async () => { throw new Error('speech 403: secret detail'); } }, async (base) => {
    const orig = console.error;
    console.error = () => {};
    try {
      const res = await fetch(`${base}/api/stt`, { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wavOf(0.5) });
      assert.strictEqual(res.status, 502);
      assert.doesNotMatch(JSON.stringify(await res.json()), /secret/);
    } finally { console.error = orig; }
  });
});

test('POST /api/stt returns 429 when the limiter says no', async () => {
  await withServer({ allow: () => false, transcribe: async () => '' }, async (base) => {
    const res = await fetch(`${base}/api/stt`, { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wavOf(0.5) });
    assert.strictEqual(res.status, 429);
  });
});

test('static files are served with headers; server code, tests and traversal are not', async () => {
  await withServer({ transcribe: async () => '' }, async (base) => {
    const index = await fetch(`${base}/`);
    assert.strictEqual(index.status, 200);
    assert.match(index.headers.get('content-type'), /text\/html/);
    assert.strictEqual(index.headers.get('cache-control'), 'no-cache');
    assert.match(index.headers.get('permissions-policy'), /microphone=\(self\)/);
    assert.match((await fetch(`${base}/manifest.webmanifest`)).headers.get('content-type'), /manifest\+json/);
    assert.strictEqual((await fetch(`${base}/api/stt/health`)).status, 200);
    for (const p of ['/server.js', '/server.test.js', '/parser.test.js', '/%2e%2e/%2e%2e/windows/win.ini', '/Dockerfile', '/README.md']) {
      assert.strictEqual((await fetch(base + p)).status, 404, p);
    }
  });
});
