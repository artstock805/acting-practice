// 실행: node --test
const test = require('node:test');
const assert = require('node:assert');
const { createServer } = require('./server.js');
const { buildPrompt, normalizeCasting, analyzeWithClaude } = require('./analyze.js');

async function withServer(opts, fn) {
  const server = createServer(opts);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { server.close(); }
}

const post = (base, body) => fetch(`${base}/api/analyze`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const SCRIPT = '민수: 늦었네.\n지연(화가 나서): 미안하다고 했잖아!';

test('POST /api/analyze returns the casting for the requested characters', async () => {
  const seen = [];
  const analyze = async (args) => { seen.push(args); return [{ name: '민수', gender: 'male', age: '20대', personality: '무뚝뚝함', speech: '짧게', voice: 'ko-KR-Chirp3-HD-Charon', rate: 1, reason: '…' }]; };
  await withServer({ analyze }, async (base) => {
    const res = await post(base, { script: SCRIPT, characters: ['민수', '지연'] });
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await res.json()).characters[0].voice, 'ko-KR-Chirp3-HD-Charon');
  });
  assert.deepStrictEqual(seen, [{ script: SCRIPT, characters: ['민수', '지연'] }]);
});

test('missing script, no characters, too many characters and oversized scripts are rejected before calling Claude', async () => {
  let count = 0;
  const analyze = async () => { count++; return []; };
  await withServer({ analyze }, async (base) => {
    assert.strictEqual((await post(base, { script: '', characters: ['민수'] })).status, 400);
    assert.strictEqual((await post(base, { script: SCRIPT, characters: [] })).status, 400);
    assert.strictEqual((await post(base, { script: SCRIPT, characters: Array.from({ length: 41 }, (_, i) => 'n' + i) })).status, 400);
    assert.strictEqual((await post(base, { script: '가'.repeat(150_001), characters: ['민수'] })).status, 413);
  });
  assert.strictEqual(count, 0);
});

test('without an API key the endpoint says AI analysis is not set up', async () => {
  await withServer({ analyze: null }, async (base) => {
    const res = await post(base, { script: SCRIPT, characters: ['민수'] });
    assert.strictEqual(res.status, 503);
    assert.match((await res.json()).error, /설정/);
  });
});

test('Claude errors are hidden behind a generic 502', async () => {
  const analyze = async () => { throw new Error('sk-ant-secret detail'); };
  await withServer({ analyze }, async (base) => {
    const res = await post(base, { script: SCRIPT, characters: ['민수'] });
    assert.strictEqual(res.status, 502);
    assert.doesNotMatch(await res.text(), /secret/);
  });
});

test('normalizeCasting keeps only requested names and catalog voices and clamps the rate', () => {
  const out = normalizeCasting([
    { name: '민수', gender: 'male', age: '20대', personality: 'p', speech: 's', voice: 'ko-KR-Chirp3-HD-Charon', rate: 3, reason: 'r' },
    { name: '모르는사람', gender: 'male', age: '20대', personality: 'p', speech: 's', voice: 'ko-KR-Chirp3-HD-Charon', rate: 1, reason: 'r' },
    { name: '지연', gender: 'female', age: '20대', personality: 'p', speech: 's', voice: 'en-US-Fake', rate: 1, reason: 'r' },
  ], ['민수', '지연']);
  assert.deepStrictEqual(out.map((c) => [c.name, c.voice, c.rate]), [['민수', 'ko-KR-Chirp3-HD-Charon', 1.4], ['지연', null, 1]]);
});

test('the prompt lists every character and every catalog voice', () => {
  const { system, user } = buildPrompt(SCRIPT, ['민수', '지연']);
  assert.match(system, /ko-KR-Chirp3-HD-Algenib/);
  assert.match(user, /민수/);
  assert.match(user, /지연/);
  assert.match(user, /미안하다고/);
});

test('analyzeWithClaude sends a structured-output request and parses the JSON answer', async () => {
  let request = null;
  const client = { beta: { messages: { create: async (req) => {
    request = req;
    return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ characters: [{ name: '민수', gender: 'male', age: '20대', personality: 'p', speech: 's', voice: 'ko-KR-Chirp3-HD-Puck', rate: 1.1, reason: 'r' }] }) }] };
  } } } };
  const out = await analyzeWithClaude({ script: SCRIPT, characters: ['민수'] }, client);
  assert.strictEqual(request.model, 'claude-opus-5-5');
  assert.strictEqual(request.output_config.format.type, 'json_schema');
  assert.strictEqual(request.fallbacks, 'default');
  assert.strictEqual(out[0].voice, 'ko-KR-Chirp3-HD-Puck');
});

test('a refusal from Claude becomes an error instead of an empty casting', async () => {
  const client = { beta: { messages: { create: async () => ({ stop_reason: 'refusal', content: [] }) } } };
  await assert.rejects(analyzeWithClaude({ script: SCRIPT, characters: ['민수'] }, client), /refusal/);
});

test('a failed analysis gives its daily allowance back', async () => {
  let fail = true;
  const analyze = async () => { if (fail) throw new Error('down'); return []; };
  await withServer({ analyze, analyzeDaily: 1 }, async (base) => {
    assert.strictEqual((await post(base, { script: SCRIPT, characters: ['민수'] })).status, 502);
    fail = false;
    assert.strictEqual((await post(base, { script: SCRIPT, characters: ['민수'] })).status, 200);
  });
});

test('only a few analyses run at once; the rest get a busy answer', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const analyze = async () => { await gate; return []; };
  await withServer({ analyze, analyzeMaxInFlight: 1 }, async (base) => {
    const first = post(base, { script: SCRIPT, characters: ['민수'] });
    await new Promise((r) => setTimeout(r, 50));
    const second = await post(base, { script: SCRIPT, characters: ['민수'] });
    assert.strictEqual(second.status, 503);
    release();
    assert.strictEqual((await first).status, 200);
  });
});
