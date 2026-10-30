// 실행: node --test
const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const { createServer, createRateLimiter, validateWav, parseWavHeader, clientIp, lineHint, speechContexts, MAX_AUDIO_SECONDS } = require('./server.js');
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
    assert.strictEqual((await post(Buffer.alloc(2 * 1024 * 1024 + 1))).status, 413);   // 서버 한도 2MB(약 65초) 초과
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

// 원시 요청 한 줄을 보내 상태 줄을 받음 (fetch는 'GET //' 같은 요청을 만들 수 없음)
function rawRequest(port, text) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(text));
    socket.once('data', (d) => { resolve(String(d).split('\r\n')[0]); socket.destroy(); });
    socket.once('error', () => resolve('error'));
    socket.once('close', () => resolve('closed'));
  });
}

test('malformed request URLs get 400 and do not crash the server', async () => {
  const server = createServer({ transcribe: async () => '' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    assert.match(await rawRequest(port, 'GET // HTTP/1.1\r\nHost: x\r\n\r\n'), /400/);
    assert.strictEqual((await fetch(`http://127.0.0.1:${port}/api/stt/health`)).status, 200);  // 아직 살아 있음
  } finally { server.close(); }
});

test('a truncated fmt chunk is rejected instead of crashing', async () => {
  const buf = Buffer.alloc(44);
  buf.write('RIFF', 0, 'ascii'); buf.write('WAVE', 8, 'ascii');
  buf.write('JUNK', 12, 'ascii'); buf.writeUInt32LE(16, 16);
  buf.write('fmt ', 36, 'ascii'); buf.writeUInt32LE(16, 40);
  assert.strictEqual(parseWavHeader(buf), null);
  await withServer({ transcribe: async () => '' }, async (base) => {
    const res = await fetch(`${base}/api/stt`, { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: buf });
    assert.strictEqual(res.status, 400);
    assert.strictEqual((await fetch(`${base}/api/stt/health`)).status, 200);
  });
});

test('clientIp uses the proxy-appended last X-Forwarded-For entry, not the spoofable first one', () => {
  const req = (xff) => ({ headers: xff ? { 'x-forwarded-for': xff } : {}, socket: { remoteAddress: '10.0.0.1' } });
  assert.strictEqual(clientIp(req('6.6.6.6, 203.0.113.7')), '203.0.113.7');
  assert.strictEqual(clientIp(req('203.0.113.7')), '203.0.113.7');
  assert.strictEqual(clientIp(req('')), '10.0.0.1');
});

test('rate limiter evicts only expired entries when it grows large', () => {
  let now = 0;
  const allow = createRateLimiter({ max: 1, windowMs: 1000 }, () => now);
  allow('victim');
  now = 500;
  for (let i = 0; i <= 10_001; i++) allow('spam' + i);
  assert.strictEqual(allow('victim'), false);  // 스팸으로 기록을 밀어도 제한이 풀리지 않음
});

test('the instance-wide limit applies even when every request uses a new IP', async () => {
  let n = 0;
  await withServer({ allow: () => true, allowGlobal: () => ++n <= 1, transcribe: async () => '' }, async (base) => {
    const post = () => fetch(`${base}/api/stt`, { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wavOf(0.2) });
    assert.strictEqual((await post()).status, 200);
    assert.strictEqual((await post()).status, 429);
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

// ---------- 인식률 개선: 대사 힌트·후보 여러 개 ----------
test('the expected line is passed to the recognizer as a hint', async () => {
  let gotHint = null;
  await withServer({ transcribe: async (_wav, _info, hint) => { gotHint = hint; return { text: '늦었네', segments: [['늦었네']] }; } }, async (base) => {
    const res = await fetch(`${base}/api/stt`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav', 'X-Line-Hint': encodeURIComponent('늦었네. 오늘도 비가 오네.') },
      body: wavOf(0.5),
    });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { text: '늦었네', segments: [['늦었네']] });
  });
  assert.strictEqual(gotHint, '늦었네. 오늘도 비가 오네.');
});

test('hints are optional, length-limited and stripped of control characters', () => {
  assert.strictEqual(lineHint({ headers: {} }), '');
  assert.strictEqual(lineHint({ headers: { 'x-line-hint': '%E0%A4%A' } }), '');            // 잘못된 인코딩
  assert.strictEqual(lineHint({ headers: { 'x-line-hint': encodeURIComponent('a\u0000b\nc') } }), 'a b c');
  assert.strictEqual(lineHint({ headers: { 'x-line-hint': encodeURIComponent('가'.repeat(500)) } }).length, 300);
});

test('speechContexts split a hint into phrases of at most 100 characters', () => {
  const ctx = speechContexts('3년 만에 갑자기 나타나서 커피 한 잔 시켜 놓고 두 시간째야. 할 말 있으면 해.');
  assert.strictEqual(ctx.length, 1);
  assert.ok(ctx[0].boost > 0);
  assert.ok(ctx[0].phrases.every((p) => p.length <= 100 && p.length > 0));
  assert.ok(ctx[0].phrases.includes('할 말 있으면 해'));
  assert.deepStrictEqual(speechContexts(''), []);
  assert.ok(speechContexts('가'.repeat(250))[0].phrases.every((p) => p.length <= 100));
});

test('pdf.js module and character maps are served with the right types', async () => {
  await withServer({ transcribe: async () => '' }, async (base) => {
    const mjs = await fetch(`${base}/vendor/pdfjs/pdf.min.mjs`);
    assert.strictEqual(mjs.status, 200);
    assert.match(mjs.headers.get('content-type'), /javascript/);   // 모듈 스크립트는 JS 형식이어야 브라우저가 실행함 (nosniff)
    const cmap = await fetch(`${base}/vendor/pdfjs/cmaps/UniKS-UCS2-H.bcmap`);
    assert.strictEqual(cmap.status, 200);
    assert.strictEqual(cmap.headers.get('content-type'), 'application/octet-stream');
  });
});

// ---------- 휴대폰 로딩 속도: 압축·재검증 ----------
const http = require('node:http');
const zlib = require('node:zlib');
const fsSync = require('node:fs');

function rawGet(base, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get(base + pathname, { headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

test('text files are compressed for browsers that accept it, images are not', async () => {
  await withServer({ transcribe: async () => '' }, async (base) => {
    const original = fsSync.readFileSync(require.resolve('./app.js'));
    const gz = await rawGet(base, '/app.js', { 'Accept-Encoding': 'gzip' });
    assert.strictEqual(gz.headers['content-encoding'], 'gzip');
    assert.match(gz.headers.vary, /Accept-Encoding/);
    assert.ok(zlib.gunzipSync(gz.body).equals(original));
    assert.ok(gz.body.length < original.length / 2);
    const br = await rawGet(base, '/app.js', { 'Accept-Encoding': 'gzip, deflate, br' });
    assert.strictEqual(br.headers['content-encoding'], 'br');
    assert.ok(zlib.brotliDecompressSync(br.body).equals(original));
    const plain = await rawGet(base, '/app.js');
    assert.strictEqual(plain.headers['content-encoding'], undefined);
    assert.ok(plain.body.equals(original));
    const png = await rawGet(base, '/assets/icon-192.png', { 'Accept-Encoding': 'gzip, br' });
    assert.strictEqual(png.headers['content-encoding'], undefined);
  });
});

test('unchanged files answer 304 to a matching ETag', async () => {
  await withServer({ transcribe: async () => '' }, async (base) => {
    const first = await rawGet(base, '/style.css', { 'Accept-Encoding': 'gzip' });
    assert.ok(first.headers.etag);
    const again = await rawGet(base, '/style.css', { 'Accept-Encoding': 'gzip', 'If-None-Match': first.headers.etag });
    assert.strictEqual(again.status, 304);
    assert.strictEqual(again.body.length, 0);
    assert.strictEqual(again.headers['cache-control'], 'no-cache');
    const stale = await rawGet(base, '/style.css', { 'If-None-Match': '"old"' });
    assert.strictEqual(stale.status, 200);
  });
});

test('weak or listed ETags from proxies still get 304', async () => {
  await withServer({ transcribe: async () => '' }, async (base) => {
    const { etag } = (await rawGet(base, '/app.js')).headers;
    assert.strictEqual((await rawGet(base, '/app.js', { 'If-None-Match': `"x", W/${etag}` })).status, 304);
  });
});

test('IPv6 clients are grouped by their /64 so rotating addresses does not dodge rate limits', () => {
  const req = (fwd) => ({ headers: { 'x-forwarded-for': fwd }, socket: { remoteAddress: '10.0.0.1' } });
  assert.strictEqual(clientIp(req('2001:db8:1:2:aaaa::1')), clientIp(req('2001:db8:1:2:bbbb::9')));
  assert.notStrictEqual(clientIp(req('2001:db8:1:2::1')), clientIp(req('2001:db8:1:3::1')));
  assert.strictEqual(clientIp(req('203.0.113.7')), '203.0.113.7');
});

test('the speech language comes from X-Speech-Lang and only Korean or English are allowed', async () => {
  const langs = [];
  await withServer({ transcribe: async (_wav, _info, _hint, lang) => { langs.push(lang); return { text: '', segments: [] }; } }, async (base) => {
    for (const lang of ['en-US', 'ko-KR', 'fr-FR', undefined]) {
      const headers = { 'Content-Type': 'audio/wav', ...(lang ? { 'X-Speech-Lang': lang } : {}) };
      assert.strictEqual((await fetch(`${base}/api/stt`, { method: 'POST', headers, body: wavOf(0.5) })).status, 200);
    }
  });
  assert.deepStrictEqual(langs, ['en-US', 'ko-KR', 'ko-KR', 'ko-KR']);
});

test('the Android app link file and APK are served, other JSON files are not', async () => {
  await withServer({}, async (base) => {
    const links = await fetch(`${base}/.well-known/assetlinks.json`);
    assert.strictEqual(links.status, 200);
    assert.match(links.headers.get('content-type'), /^application\/json/);
    const [entry] = await links.json();
    assert.strictEqual(entry.target.package_name, 'com.artstock805.actingpractice');
    assert.match(entry.target.sha256_cert_fingerprints[0], /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);

    const apk = await fetch(`${base}/download/acting-practice.apk`);
    assert.strictEqual(apk.status, 200);
    assert.strictEqual(apk.headers.get('content-type'), 'application/vnd.android.package-archive');
    assert.match(apk.headers.get('content-disposition'), /attachment; filename="acting-practice.apk"/);
    assert.ok((await apk.arrayBuffer()).byteLength > 100_000);

    assert.strictEqual((await fetch(`${base}/package.json`)).status, 404);
    assert.strictEqual((await fetch(`${base}/android.html`)).status, 200);
  });
});

test('long lines can be recorded for up to 55 seconds', async () => {
  let got = null;
  await withServer({ transcribe: async (_wav, info) => { got = info; return '긴 대사'; } }, async (base) => {
    const res = await fetch(`${base}/api/stt`, { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wavOf(40) });
    assert.strictEqual(res.status, 200);
  });
  assert.ok(got.seconds > 39);
  assert.strictEqual(MAX_AUDIO_SECONDS, 55);
});
