// 실행: node --test
const test = require('node:test');
const assert = require('node:assert');
const { traceClaude, createLangfuseTracing, createLangfuseScorer, captureTraceId, appVersion } = require('./langfuse.js');

// 가짜 Langfuse: 기록된 generation을 모아 둠
function fakeTracing() {
  const generations = [];
  let flushed = 0;
  return {
    generations,
    flushed: () => flushed,
    startObservation(name, attrs, opts) {
      const g = { name, attrs, opts, updates: [], ended: false };
      generations.push(g);
      return { update: (u) => g.updates.push(u), end: () => { g.ended = true; } };
    },
    flush: async () => { flushed++; },
  };
}

const fakeClient = (respond) => ({ beta: { messages: { create: async (req) => respond(req) } } });
const REQUEST = { model: 'claude-haiku-5-5', max_tokens: 100, system: '지시문', messages: [{ role: 'user', content: '대본' }] };
const RESPONSE = {
  model: 'claude-haiku-5-5', stop_reason: 'end_turn',
  content: [{ type: 'text', text: '{"scenes":[]}' }],
  usage: { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 0 },
};

test('without Langfuse keys the Claude client is used as is', () => {
  const client = fakeClient(() => RESPONSE);
  assert.strictEqual(traceClaude(client, 'scene-art', null), client);
  assert.strictEqual(traceClaude(null, 'scene-art', fakeTracing()), null);
  assert.strictEqual(createLangfuseTracing({}), null);
  assert.strictEqual(createLangfuseTracing({ LANGFUSE_PUBLIC_KEY: 'pk', LANGFUSE_SECRET_KEY: '  ' }), null);
});

test('a Claude call is recorded as one generation with input, output and tokens', async () => {
  const tracing = fakeTracing();
  const seen = [];
  const traced = traceClaude(fakeClient((req) => { seen.push(req); return RESPONSE; }), 'scene-art', tracing);
  const res = await traced.beta.messages.create(REQUEST);
  assert.strictEqual(res, RESPONSE);
  assert.deepStrictEqual(seen, [REQUEST]);
  const [g] = tracing.generations;
  assert.strictEqual(g.name, 'claude-scene-art');
  assert.strictEqual(g.opts.asType, 'generation');
  assert.strictEqual(g.attrs.model, 'claude-haiku-5-5');
  assert.deepStrictEqual(g.attrs.input, { system: '지시문', messages: REQUEST.messages });
  const u = g.updates.at(-1);
  assert.strictEqual(u.output, '{"scenes":[]}');
  assert.deepStrictEqual(u.usageDetails, { input: 120, output: 30, cache_read_input_tokens: 0 });
  assert.strictEqual(u.level, 'DEFAULT');
  assert.ok(g.ended);
  assert.strictEqual(tracing.flushed(), 1);
});

test('a refusal or cut-off answer is marked as a warning', async () => {
  const tracing = fakeTracing();
  const traced = traceClaude(fakeClient(() => ({ ...RESPONSE, stop_reason: 'max_tokens' })), 'analyze', tracing);
  await traced.beta.messages.create(REQUEST);
  const u = tracing.generations[0].updates.at(-1);
  assert.strictEqual(u.level, 'WARNING');
  assert.strictEqual(u.statusMessage, 'max_tokens');
});

test('a failed Claude call is recorded as an error and still thrown', async () => {
  const tracing = fakeTracing();
  const traced = traceClaude(fakeClient(() => { throw new Error('overloaded'); }), 'insight', tracing);
  await assert.rejects(traced.beta.messages.create(REQUEST), /overloaded/);
  const g = tracing.generations[0];
  assert.deepStrictEqual(g.updates.at(-1), { level: 'ERROR', statusMessage: 'overloaded' });
  assert.ok(g.ended);
  assert.strictEqual(tracing.flushed(), 1);
});

test('a broken tracer never breaks the Claude answer', async () => {
  const broken = () => { throw new Error('tracer bug'); };
  const tracings = [
    { startObservation: broken, flush: async () => {} },
    { startObservation: () => ({ update: broken, end: broken }), flush: async () => {} },
  ];
  const original = console.error;
  console.error = () => {};
  try {
    for (const tracing of tracings) {
      const traced = traceClaude(fakeClient(() => RESPONSE), 'analyze', tracing);
      assert.strictEqual(await traced.beta.messages.create(REQUEST), RESPONSE);
      const failing = traceClaude(fakeClient(() => { throw new Error('overloaded'); }), 'analyze', tracing);
      await assert.rejects(failing.beta.messages.create(REQUEST), /overloaded/);
    }
  } finally { console.error = original; }
});

test('a Langfuse outage never breaks the Claude answer', async () => {
  const tracing = { ...fakeTracing(), flush: async () => { throw new Error('langfuse down'); } };
  const traced = traceClaude(fakeClient(() => RESPONSE), 'analyze', tracing);
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    assert.strictEqual(await traced.beta.messages.create(REQUEST), RESPONSE);
  } finally { console.error = original; }
  assert.match(errors.join('\n'), /langfuse down/);
});

test('the deployed version is the commit Cloud Build passes in, or local', () => {
  assert.strictEqual(appVersion({ APP_VERSION: ' 91d0f4e \n' }), '91d0f4e');
  assert.strictEqual(appVersion({}), 'local');
  assert.strictEqual(appVersion({ APP_VERSION: '  ' }), 'local');
});

test('every Claude generation carries the deployed version', async () => {
  const tracing = { ...fakeTracing(), version: 'a1b2c3d' };
  await traceClaude(fakeClient(() => RESPONSE), 'analyze', tracing).beta.messages.create(REQUEST);
  assert.strictEqual(tracing.generations[0].attrs.version, 'a1b2c3d');
});

// startObservation이 돌려준 generation의 traceId를 그 요청의 응답에 실어 보냄
function tracingWithIds() {
  const t = fakeTracing();
  let n = 0;
  const start = t.startObservation;
  t.startObservation = (...args) => { n++; return { ...start(...args), traceId: String(n).padStart(32, '0'), id: String(n).padStart(16, 'f') }; };
  return t;
}

test('the trace id of the Claude call is handed back with the answer', async () => {
  const traced = traceClaude(fakeClient(() => RESPONSE), 'analyze', tracingWithIds());
  const analyze = captureTraceId(async (script) => { await traced.beta.messages.create(REQUEST); return `분석:${script}`; });
  const [a, b] = await Promise.all([analyze('가'), analyze('나')]);   // 동시에 들어온 요청도 서로 섞이지 않음
  assert.strictEqual(a.value, '분석:가');
  assert.strictEqual(b.value, '분석:나');
  assert.notStrictEqual(a.traceId, b.traceId);
  assert.match(a.traceId, /^0+[12]$/);
  assert.match(a.observationId, /^f+[12]$/);   // 점수를 루트 관측(generation)에도 붙이려고 함께 돌려줌
  assert.strictEqual(a.traceId.at(-1), a.observationId.at(-1));
});

test('without Langfuse the trace id is null and nothing is scored', async () => {
  const analyze = captureTraceId(async () => traceClaude(fakeClient(() => RESPONSE), 'analyze', null).beta.messages.create(REQUEST));
  const out = await analyze();
  assert.strictEqual(out.value, RESPONSE);
  assert.strictEqual(out.traceId, null);
  assert.strictEqual(out.observationId, null);
  assert.strictEqual(createLangfuseScorer({}), null);
  assert.strictEqual(createLangfuseScorer({ LANGFUSE_PUBLIC_KEY: 'pk' }), null);
});
