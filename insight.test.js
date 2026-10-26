// 실행: node --test
const test = require('node:test');
const assert = require('node:assert');
const { createServer } = require('./server.js');
const { buildInsightPrompt, normalizeInsight, insightWithClaude } = require('./insight.js');

async function withServer(opts, fn) {
  const server = createServer(opts);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { server.close(); }
}

const post = (base, body) => fetch(`${base}/api/insight`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const SCRIPT = '민수: 늦었네.\n지연(화가 나서): 미안하다고 했잖아!';
const SAMPLE = {
  play: { super_objective: '떠나기 전에 서로의 진심을 확인하고 싶다', theme: '타이밍', through_action: '붙잡을까 보낼까', summary: '3년 만의 재회' },
  characters: [
    { name: '민수', super_objective: '지연을 붙잡고 싶다', through_action: '무심한 척 곁을 지킨다', obstacle: '자존심', evidence: ['우산, 내가 씌워 줄게.'] },
    { name: '모르는사람', super_objective: 'x', through_action: 'x', obstacle: 'x', evidence: [] },
  ],
  relationships: [
    { a: '민수', b: '지연', kind: 'love', label: '헤어진 연인', direction: 'mutual', note: '아직 미련' },
    { a: '민수', b: '민수', kind: 'love', label: '자기 자신', direction: 'mutual', note: '' },
    { a: '민수', b: '유령', kind: 'friend', label: '없는 사람', direction: 'mutual', note: '' },
    { a: '지연', b: '민수', kind: 'secret', label: '헤어진 연인', direction: 'a_to_b', note: '' },
  ],
};

test('POST /api/insight returns the play, character and relationship analysis', async () => {
  const seen = [];
  const insight = async (args) => { seen.push(args); return normalizeInsight(SAMPLE, args.characters); };
  await withServer({ insight }, async (base) => {
    const res = await post(base, { script: SCRIPT, characters: ['민수', '지연'] });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.play.super_objective, '떠나기 전에 서로의 진심을 확인하고 싶다');
    assert.strictEqual(body.characters.length, 1);
  });
  assert.deepStrictEqual(seen, [{ script: SCRIPT, characters: ['민수', '지연'], lang: 'ko' }]);
});

test('without an API key the insight endpoint says it is not set up', async () => {
  await withServer({ insight: null }, async (base) => {
    const res = await post(base, { script: SCRIPT, characters: ['민수'] });
    assert.strictEqual(res.status, 503);
  });
});

test('normalizeInsight drops unknown names, self-links, duplicates and unknown kinds', () => {
  const out = normalizeInsight(SAMPLE, ['민수', '지연']);
  assert.deepStrictEqual(out.characters.map((c) => c.name), ['민수']);
  assert.strictEqual(out.relationships.length, 1);
  assert.deepStrictEqual(out.relationships[0], { a: '민수', b: '지연', kind: 'love', label: '헤어진 연인', direction: 'mutual', note: '아직 미련' });
});

test('normalizeInsight survives a missing or malformed answer', () => {
  const out = normalizeInsight({}, ['민수']);
  assert.deepStrictEqual(out, { play: { super_objective: '', theme: '', through_action: '', summary: '' }, characters: [], relationships: [] });
});

test('the insight prompt names every character and includes the script', () => {
  const { system, user } = buildInsightPrompt(SCRIPT, ['민수', '지연']);
  assert.match(system, /초목표/);
  assert.match(user, /민수, 지연/);
  assert.match(user, /미안하다고/);
});

test('insightWithClaude asks for structured output and parses it', async () => {
  let request = null;
  const client = { beta: { messages: { create: async (req) => { request = req; return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(SAMPLE) }] }; } } } };
  const out = await insightWithClaude({ script: SCRIPT, characters: ['민수', '지연'] }, client);
  assert.strictEqual(request.output_config.format.type, 'json_schema');
  assert.strictEqual(out.relationships.length, 1);
});

test('the insight prompt for an English script keeps quotes in English', () => {
  const { system } = buildInsightPrompt('MAYA: Hi.', ['MAYA'], 'en');
  assert.match(system, /영어 원문/);
});
