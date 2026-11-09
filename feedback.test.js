// 실행: node --test
const test = require('node:test');
const assert = require('node:assert');
const { parseFeedback, createFeedbackHandler, MAX_BODY_BYTES } = require('./feedback.js');

const TRACE = '0123456789abcdef0123456789abcdef';
const raw = (body) => Buffer.from(JSON.stringify(body));

test('a like or dislike becomes a boolean user-feedback score, one per result', () => {
  assert.deepStrictEqual(parseFeedback(raw({ traceId: TRACE, name: 'user-feedback', value: 1 })).score,
    { id: `${TRACE}-user-feedback`, traceId: TRACE, name: 'user-feedback', value: 1, dataType: 'BOOLEAN' });
  assert.strictEqual(parseFeedback(raw({ traceId: TRACE, name: 'user-feedback', value: 0 })).score.value, 0);
  assert.strictEqual(parseFeedback(raw({ traceId: TRACE, name: 'user-feedback', value: false })).score.value, 0);
});

test('a voice change becomes a voice-changed score with its comment', () => {
  const { score } = parseFeedback(raw({ traceId: TRACE, name: 'voice-changed', value: 1, comment: '  민수: A → B ' }));
  assert.deepStrictEqual(score, { traceId: TRACE, name: 'voice-changed', value: 1, dataType: 'BOOLEAN', comment: '민수: A → B' });
});

test('only allowed names, values and trace ids are accepted', () => {
  const bad = [
    'not json',
    { traceId: TRACE, name: 'hacked', value: 1 },
    { traceId: TRACE, name: 'voice-changed', value: 0 },
    { traceId: TRACE, name: 'user-feedback', value: 5 },
    { traceId: TRACE, name: 'user-feedback', value: '1' },
    { traceId: 'abc', name: 'user-feedback', value: 1 },
    { traceId: TRACE.toUpperCase(), name: 'user-feedback', value: 1 },
    { name: 'user-feedback', value: 1 },
    { traceId: TRACE, name: 'user-feedback', value: 1, comment: 7 },
  ];
  for (const body of bad) {
    const out = parseFeedback(typeof body === 'string' ? Buffer.from(body) : raw(body));
    assert.strictEqual(out.status, 400, JSON.stringify(body));
  }
  const long = parseFeedback(raw({ traceId: TRACE, name: 'voice-changed', value: 1, comment: 'ㄱ'.repeat(1000) }));
  assert.strictEqual(long.score.comment.length, 300);
});

// 가짜 서버 도구들
function harness({ scorer, allow = () => true, body = raw({ traceId: TRACE, name: 'user-feedback', value: 1 }), readError } = {}) {
  const sent = [];
  const handler = createFeedbackHandler({
    scorer,
    readBody: async (_req, limit) => { assert.strictEqual(limit, MAX_BODY_BYTES); if (readError) throw readError; return body; },
    sendJson: (_res, status, json) => sent.push({ status, json }),
    send: (_res, status) => sent.push({ status }),
    clientIp: () => '1.2.3.4',
    createRateLimiter: () => allow,
  });
  return { sent, run: () => handler({ resume() {} }, {}) };
}

const fakeScorer = () => {
  const scores = [];
  let flushed = 0;
  return { scores, flushed: () => flushed, score: (s) => scores.push(s), flush: async () => { flushed++; } };
};

test('feedback is sent to Langfuse and answered with 204', async () => {
  const scorer = fakeScorer();
  const h = harness({ scorer });
  await h.run();
  assert.deepStrictEqual(h.sent, [{ status: 204 }]);
  assert.strictEqual(scorer.scores[0].name, 'user-feedback');
  assert.strictEqual(scorer.flushed(), 1);
});

test('without Langfuse keys feedback is quietly ignored with 204', async () => {
  const h = harness({ scorer: null });
  await h.run();
  assert.deepStrictEqual(h.sent, [{ status: 204 }]);
});

test('a Langfuse error never reaches the user', async () => {
  const broken = { score: () => { throw new Error('langfuse down'); }, flush: async () => { throw new Error('still down'); } };
  const h = harness({ scorer: broken });
  await h.run();
  assert.deepStrictEqual(h.sent, [{ status: 204 }]);
});

test('bad input, too large bodies and too many requests are refused', async () => {
  let h = harness({ scorer: fakeScorer(), body: raw({ traceId: TRACE, name: 'nope', value: 1 }) });
  await h.run();
  assert.strictEqual(h.sent[0].status, 400);
  h = harness({ scorer: fakeScorer(), readError: Object.assign(new Error('big'), { status: 413 }) });
  await h.run();
  assert.strictEqual(h.sent[0].status, 413);
  const scorer = fakeScorer();
  h = harness({ scorer, allow: () => false });
  await h.run();
  assert.strictEqual(h.sent[0].status, 429);
  assert.strictEqual(scorer.scores.length, 0);
});
