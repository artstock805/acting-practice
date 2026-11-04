// 실행: node --test
// 원장 SQL(supabase/credits.sql) 자체는 Supabase에서 확인. 여기서는 서버가 언제 차감·환불하는지와 Supabase 호출 모양을 봄
const test = require('node:test');
const assert = require('node:assert');
const { createServer } = require('./server.js');
const { scriptHash, clientIdOf, requestIdOf, createSupabaseCreditStore, createCreditStoreFromEnv, ANALYSIS_COST } = require('./credits.js');

const CLIENT = '11111111-2222-4333-8444-555555555555';
const SCRIPT = '민수: 늦었네.\n지연(화가 나서): 미안하다고 했잖아!';

async function withServer(opts, fn) {
  const server = createServer(opts);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { server.close(); }
}

const post = (base, path, body, headers = { 'X-Client-Id': CLIENT }) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

// spend_analysis와 같은 규칙의 메모리 원장 (같은 대본은 한 번만, 환불된 건 다시 차감)
function fakeCredits(balance) {
  const calls = { spend: [], refund: [] };
  const entries = [];
  return {
    calls,
    spend: async (args) => {
      calls.spend.push(args);
      const paid = entries.find((e) => e.hash === args.scriptHash && !e.refunded);
      if (paid) return { status: 'covered', balance };
      if (balance < ANALYSIS_COST) return { status: 'insufficient', balance };
      balance -= ANALYSIS_COST;
      entries.push({ id: entries.length + 1, hash: args.scriptHash });
      return { status: 'charged', ledger_id: entries.length, balance };
    },
    refund: async (id) => {
      calls.refund.push(id);
      const e = entries[id - 1];
      if (!e.refunded) { e.refunded = true; balance += ANALYSIS_COST; }
      return { status: 'refunded', balance };
    },
    balance: async () => balance,
  };
}

const casting = async () => [];
const insight = async () => ({ play: {}, characters: [], relationships: [] });

test('the first of the three analyses for a script charges 100 credits and the others are free', async () => {
  const credits = fakeCredits(250);
  await withServer({ credits, analyze: casting, insight, sceneArt: async () => ({}) }, async (base) => {
    assert.strictEqual((await post(base, '/api/analyze', { script: SCRIPT, characters: ['민수'] })).status, 200);
    assert.strictEqual((await post(base, '/api/insight', { script: SCRIPT, characters: ['민수'] })).status, 200);
    assert.strictEqual((await post(base, '/api/scene-art', { script: SCRIPT, scenes: ['1장'] })).status, 200);
  });
  assert.strictEqual(await credits.balance(), 150);
  assert.deepStrictEqual(credits.calls.spend.map((c) => c.scriptHash), Array(3).fill(scriptHash(SCRIPT)));
  assert.ok(credits.calls.spend.every((c) => c.clientId === CLIENT));
});

test('without enough credits the analysis is refused with 402 before calling Claude', async () => {
  let called = 0;
  const credits = fakeCredits(50);
  await withServer({ credits, analyze: async () => { called++; return []; } }, async (base) => {
    const res = await post(base, '/api/analyze', { script: SCRIPT, characters: ['민수'] });
    assert.strictEqual(res.status, 402);
    const body = await res.json();
    assert.strictEqual(body.balance, 50);
    assert.match(body.error, /크레딧이 부족해요\(남은 크레딧 50\)/);
  });
  assert.strictEqual(called, 0);
});

test('a failed Claude call refunds the credits it charged, so the same script is charged again next time', async () => {
  const credits = fakeCredits(200);
  let fail = true;
  await withServer({ credits, analyze: async () => { if (fail) throw new Error('claude max_tokens'); return []; } }, async (base) => {
    assert.strictEqual((await post(base, '/api/analyze', { script: SCRIPT, characters: ['민수'] })).status, 502);
    assert.deepStrictEqual(credits.calls.refund, [1]);
    assert.strictEqual(await credits.balance(), 200);
    fail = false;
    assert.strictEqual((await post(base, '/api/analyze', { script: SCRIPT, characters: ['민수'] })).status, 200);
  });
  assert.strictEqual(await credits.balance(), 100);
});

test('a failed call that was covered by an earlier charge does not refund that charge', async () => {
  const credits = fakeCredits(200);
  await withServer({ credits, analyze: casting, insight: async () => { throw new Error('claude refusal'); } }, async (base) => {
    assert.strictEqual((await post(base, '/api/analyze', { script: SCRIPT, characters: ['민수'] })).status, 200);
    assert.strictEqual((await post(base, '/api/insight', { script: SCRIPT, characters: ['민수'] })).status, 502);
  });
  assert.deepStrictEqual(credits.calls.refund, []);
  assert.strictEqual(await credits.balance(), 100);
});

test('requests without a temporary ID or with a broken ledger are refused without calling Claude', async () => {
  let called = 0;
  const analyze = async () => { called++; return []; };
  await withServer({ credits: fakeCredits(500), analyze }, async (base) => {
    assert.strictEqual((await post(base, '/api/analyze', { script: SCRIPT, characters: ['민수'] }, {})).status, 400);
    assert.strictEqual((await post(base, '/api/analyze', { script: SCRIPT, characters: ['민수'] }, { 'X-Client-Id': 'not-a-uuid' })).status, 400);
  });
  const broken = { spend: async () => { throw new Error('supabase spend_analysis 500'); }, refund: async () => {}, balance: async () => 0 };
  await withServer({ credits: broken, analyze }, async (base) => {
    assert.strictEqual((await post(base, '/api/analyze', { script: SCRIPT, characters: ['민수'] })).status, 503);
  });
  assert.strictEqual(called, 0);
});

test('without a credit store nothing is charged and /api/credits says credits are off', async () => {
  await withServer({ credits: null, analyze: casting }, async (base) => {
    assert.strictEqual((await post(base, '/api/analyze', { script: SCRIPT, characters: ['민수'] }, {})).status, 200);
    assert.deepStrictEqual(await (await fetch(`${base}/api/credits`)).json(), { enabled: false });
  });
});

test('/api/credits returns the balance for the temporary ID', async () => {
  await withServer({ credits: fakeCredits(300) }, async (base) => {
    const res = await fetch(`${base}/api/credits`, { headers: { 'X-Client-Id': CLIENT } });
    assert.deepStrictEqual(await res.json(), { enabled: true, balance: 300, cost: 100, pay: null });   // 토스 키가 없으면 충전 결제는 꺼짐
    assert.strictEqual((await fetch(`${base}/api/credits`)).status, 400);
  });
});

test('IDs are read only when they look like UUIDs, and a missing request ID gets a fresh one', () => {
  assert.strictEqual(clientIdOf({ headers: { 'x-client-id': CLIENT.toUpperCase() } }), CLIENT);
  assert.strictEqual(clientIdOf({ headers: { 'x-client-id': "x' or 1=1" } }), '');
  assert.match(requestIdOf({ headers: {} }), /^[0-9a-f-]{36}$/);
  assert.notStrictEqual(requestIdOf({ headers: {} }), requestIdOf({ headers: {} }));
});

test('the Supabase store calls the ledger functions with the service key and hides error bodies', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, init });
    return url.endsWith('/refund_analysis')
      ? { ok: false, status: 500, json: async () => ({ message: 'secret detail' }) }
      : { ok: true, status: 200, json: async () => ({ status: 'charged', ledger_id: 7, balance: 0 }) };
  };
  const store = createSupabaseCreditStore({ url: 'https://abc.supabase.co/', serviceKey: 'svc', fetchImpl });
  assert.deepStrictEqual(await store.spend({ clientId: CLIENT, scriptHash: 'h', requestId: 'r' }), { status: 'charged', ledger_id: 7, balance: 0 });
  assert.strictEqual(seen[0].url, 'https://abc.supabase.co/rest/v1/rpc/spend_analysis');
  assert.strictEqual(seen[0].init.headers.Authorization, 'Bearer svc');
  assert.deepStrictEqual(JSON.parse(seen[0].init.body), { p_client_id: CLIENT, p_script_hash: 'h', p_request_id: 'r', p_cost: 100 });
  await assert.rejects(store.refund(7), (err) => err.message === 'supabase refund_analysis 500');
});

test('credits turn on only when both the Supabase URL and the service key are set', () => {
  assert.strictEqual(createCreditStoreFromEnv({}), null);
  assert.strictEqual(createCreditStoreFromEnv({ SUPABASE_URL: 'https://abc.supabase.co' }), null);
  assert.strictEqual(createCreditStoreFromEnv({ SUPABASE_SERVICE_KEY: 'svc' }), null);
  assert.ok(createCreditStoreFromEnv({ SUPABASE_URL: 'https://abc.supabase.co', SUPABASE_SERVICE_KEY: ' svc\n' }));
});
