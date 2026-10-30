// 실행: node --test
const test = require('node:test');
const assert = require('node:assert');
const { createServer } = require('./server.js');
const { buildSceneArtPrompt, normalizeSceneArt, sceneArtWithClaude, parseSceneArtRequest } = require('./sceneart.js');

async function withServer(opts, fn) {
  const server = createServer(opts);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { server.close(); }
}

const post = (base, body) => fetch(`${base}/api/scene-art`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const SCRIPT = 'S#1. 상범집 / 밤\n(낡은 단칸방. 상범이 소주를 마신다.)\n상범: 또 혼자네.';
const SCENES = ['S#1. 상범집 / 밤'];

test('POST /api/scene-art returns an image prompt for each scene', async () => {
  const seen = [];
  const sceneArt = async (args) => { seen.push(args); return { 'S#1. 상범집 / 밤': 'a shabby one-room flat at night' }; };
  await withServer({ sceneArt }, async (base) => {
    const res = await post(base, { script: SCRIPT, scenes: SCENES });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { scenes: { 'S#1. 상범집 / 밤': 'a shabby one-room flat at night' } });
  });
  assert.deepStrictEqual(seen, [{ script: SCRIPT, scenes: SCENES, lang: 'ko' }]);
});

test('without an API key the scene-art endpoint says it is not set up', async () => {
  await withServer({ sceneArt: null }, async (base) => {
    const res = await post(base, { script: SCRIPT, scenes: SCENES });
    assert.strictEqual(res.status, 503);
  });
});

test('a scene-art request needs a script and at least one scene', () => {
  assert.strictEqual(parseSceneArtRequest(Buffer.from(JSON.stringify({ script: SCRIPT, scenes: [] }))).status, 400);
  assert.strictEqual(parseSceneArtRequest(Buffer.from(JSON.stringify({ scenes: SCENES }))).status, 400);
  assert.strictEqual(parseSceneArtRequest(Buffer.from('not json')).status, 400);
  const ok = parseSceneArtRequest(Buffer.from(JSON.stringify({ script: SCRIPT, scenes: [...SCENES, ...SCENES, 3], lang: 'en' })));
  assert.deepStrictEqual(ok, { script: SCRIPT, scenes: SCENES, lang: 'en' });
});

test('normalizeSceneArt keeps only known scenes and trims long prompts', () => {
  const out = normalizeSceneArt({ scenes: [
    { scene: 'S#1. 상범집 / 밤', prompt: '  a shabby one-room flat at night  ' },
    { scene: '모르는 장면', prompt: 'x' },
    { scene: 'S#1. 상범집 / 밤', prompt: 'duplicate' },
  ] }, SCENES);
  assert.deepStrictEqual(out, { 'S#1. 상범집 / 밤': 'a shabby one-room flat at night' });
  assert.ok(normalizeSceneArt({ scenes: [{ scene: SCENES[0], prompt: 'a'.repeat(2000) }] }, SCENES)[SCENES[0]].length <= 400);
  assert.deepStrictEqual(normalizeSceneArt(null, SCENES), {});
});

test('the scene-art prompt lists every scene and asks for English, no names or text', () => {
  const { system, user } = buildSceneArtPrompt(SCRIPT, SCENES);
  assert.match(system, /English/);
  assert.match(system, /이름/);
  assert.match(system, /사람이 없는/);       // 배경(공간)만 그림, 인물은 빼기
  assert.match(user, /S#1\. 상범집 \/ 밤/);
  assert.match(user, /소주/);
});

test('sceneArtWithClaude asks for structured output and parses it', async () => {
  let request = null;
  const answer = { scenes: [{ scene: SCENES[0], prompt: 'a shabby one-room flat at night' }] };
  const client = { beta: { messages: { create: async (req) => { request = req; return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(answer) }] }; } } } };
  const out = await sceneArtWithClaude({ script: SCRIPT, scenes: SCENES }, client);
  assert.strictEqual(request.output_config.format.type, 'json_schema');
  assert.deepStrictEqual(out, { [SCENES[0]]: 'a shabby one-room flat at night' });
});
