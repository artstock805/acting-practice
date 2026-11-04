// 실행: node --test
// 충전 결제: 주문 → (토스 결제창) → 승인. 토스와 Supabase는 가짜로 바꿔 끼워 서버가 언제 승인·충전·거절하는지 봄
const test = require('node:test');
const assert = require('node:assert');
const { createServer } = require('./server.js');
const { createTossClient, PRODUCT } = require('./payments.js');

const CLIENT = '11111111-2222-4333-8444-555555555555';
const OTHER = '99999999-2222-4333-8444-555555555555';
const PAYMENT_KEY = 'tgen_20261104abcDEF';

async function withServer(opts, fn) {
  const server = createServer({ analyze: null, insight: null, sceneArt: null, ...opts });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { server.close(); }
}

const post = (base, path, body, client = CLIENT) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Client-Id': client }, body: JSON.stringify(body || {}) });

// complete_payment_order·fail_payment_order와 같은 규칙의 메모리 주문표
function fakeLedger() {
  const orders = new Map();
  let balance = 0;
  return {
    orders,
    balance: async () => balance,
    createOrder: async ({ clientId, orderId, amount, credits, orderName }) => {
      orders.set(orderId, { order_id: orderId, client_id: clientId, amount, credits, order_name: orderName, status: 'pending' });
    },
    getOrder: async (id) => (orders.has(id) ? { ...orders.get(id) } : null),
    completeOrder: async ({ orderId, amount }) => {
      const o = orders.get(orderId);
      if (o.amount !== amount) throw new Error('amount mismatch');
      if (o.status === 'paid') return { status: 'already', credits: o.credits, balance };
      o.status = 'paid';
      balance += o.credits;
      return { status: 'paid', credits: o.credits, balance };
    },
    failOrder: async ({ orderId }) => {
      const o = orders.get(orderId);
      if (o && o.status !== 'paid') o.status = 'failed';
    },
  };
}

function fakeToss(answer) {
  const calls = [];
  return {
    calls,
    confirm: async (args) => { calls.push(['confirm', args]); return answer(args); },
    get: async (key) => { calls.push(['get', key]); return answer({ paymentKey: key, lookup: true }); },
  };
}

const done = ({ orderId, amount }) => ({ ok: true, status: 200, body: { status: 'DONE', orderId, totalAmount: amount } });
const opts = (credits, toss) => ({ credits, toss, tossClientKey: 'test_ck_x' });

async function order(base, client = CLIENT) {
  const res = await post(base, '/api/pay/order', {}, client);
  assert.strictEqual(res.status, 200);
  return res.json();
}

test('an order is saved on the server first with the product price, and the payment window gets its values', async () => {
  const ledger = fakeLedger();
  await withServer(opts(ledger, fakeToss(done)), async (base) => {
    const o = await order(base);
    assert.deepStrictEqual({ amount: o.amount, credits: o.credits, clientKey: o.clientKey, customerKey: o.customerKey }, { amount: 1000, credits: 100, clientKey: 'test_ck_x', customerKey: CLIENT });
    assert.match(o.orderId, /^[0-9a-f-]{36}$/);
    assert.strictEqual(ledger.orders.get(o.orderId).amount, PRODUCT.amount);
    const credits = await (await fetch(`${base}/api/credits`, { headers: { 'X-Client-Id': CLIENT } })).json();
    assert.deepStrictEqual(credits.pay, { amount: 1000, credits: 100 });
  });
});

test('a confirmed payment adds 100 credits once, even if the success page is reloaded', async () => {
  const ledger = fakeLedger();
  const toss = fakeToss(done);
  await withServer(opts(ledger, toss), async (base) => {
    const o = await order(base);
    const body = { paymentKey: PAYMENT_KEY, orderId: o.orderId, amount: '1000' };   // 결제창은 금액을 문자열로 돌려줌
    const first = await post(base, '/api/pay/confirm', body);
    assert.strictEqual(first.status, 200);
    assert.deepStrictEqual(await first.json(), { ok: true, credits: 100, balance: 100 });
    assert.strictEqual((await post(base, '/api/pay/confirm', body)).status, 200);
  });
  assert.strictEqual(await ledger.balance(), 100);
  assert.strictEqual(toss.calls.filter(([k]) => k === 'confirm').length, 1);   // 두 번째는 토스를 다시 부르지 않음
});

test('a changed amount is refused before asking Toss to approve it', async () => {
  const toss = fakeToss(done);
  const ledger = fakeLedger();
  await withServer(opts(ledger, toss), async (base) => {
    const o = await order(base);
    const res = await post(base, '/api/pay/confirm', { paymentKey: PAYMENT_KEY, orderId: o.orderId, amount: 100 });
    assert.strictEqual(res.status, 400);
  });
  assert.deepStrictEqual(toss.calls, []);
  assert.strictEqual(await ledger.balance(), 0);
});

test('someone else cannot confirm an order that is not theirs, and unknown orders are not found', async () => {
  const toss = fakeToss(done);
  await withServer(opts(fakeLedger(), toss), async (base) => {
    const o = await order(base);
    assert.strictEqual((await post(base, '/api/pay/confirm', { paymentKey: PAYMENT_KEY, orderId: o.orderId, amount: 1000 }, OTHER)).status, 404);
    assert.strictEqual((await post(base, '/api/pay/confirm', { paymentKey: PAYMENT_KEY, orderId: OTHER, amount: 1000 })).status, 404);
    assert.strictEqual((await post(base, '/api/pay/confirm', { paymentKey: 'bad key!', orderId: o.orderId, amount: 1000 })).status, 400);
  });
  assert.deepStrictEqual(toss.calls, []);
});

test('a payment Toss refuses adds no credits and marks the order failed with its code', async () => {
  const ledger = fakeLedger();
  const toss = fakeToss(() => ({ ok: false, status: 403, body: { code: 'REJECT_CARD_COMPANY', message: '카드사에서 거절했어요.' } }));
  await withServer(opts(ledger, toss), async (base) => {
    const o = await order(base);
    const res = await post(base, '/api/pay/confirm', { paymentKey: PAYMENT_KEY, orderId: o.orderId, amount: 1000 });
    assert.strictEqual(res.status, 402);
    assert.deepStrictEqual(await res.json(), { error: '카드사에서 거절했어요.', code: 'REJECT_CARD_COMPANY' });
    assert.strictEqual(ledger.orders.get(o.orderId).status, 'failed');
  });
  assert.strictEqual(await ledger.balance(), 0);
});

test('when Toss says the payment was already processed, the server checks it is done for this order before adding credits', async () => {
  const ledger = fakeLedger();
  const toss = fakeToss((args) => (args.lookup
    ? { ok: true, status: 200, body: { status: 'DONE', orderId: [...ledger.orders.keys()][0], totalAmount: 1000 } }
    : { ok: false, status: 400, body: { code: 'ALREADY_PROCESSED_PAYMENT', message: '이미 처리된 결제 입니다.' } }));
  await withServer(opts(ledger, toss), async (base) => {
    const o = await order(base);
    assert.strictEqual((await post(base, '/api/pay/confirm', { paymentKey: PAYMENT_KEY, orderId: o.orderId, amount: 1000 })).status, 200);
  });
  assert.strictEqual(await ledger.balance(), 100);
});

test('Toss approving a payment for a different order or amount adds no credits', async () => {
  const ledger = fakeLedger();
  const toss = fakeToss(({ orderId }) => ({ ok: true, status: 200, body: { status: 'DONE', orderId, totalAmount: 500 } }));
  await withServer(opts(ledger, toss), async (base) => {
    const o = await order(base);
    assert.strictEqual((await post(base, '/api/pay/confirm', { paymentKey: PAYMENT_KEY, orderId: o.orderId, amount: 1000 })).status, 402);
  });
  assert.strictEqual(await ledger.balance(), 0);
});

test('a cancelled payment window marks the order failed, and a cancel without an order is fine', async () => {
  const ledger = fakeLedger();
  await withServer(opts(ledger, fakeToss(done)), async (base) => {
    const o = await order(base);
    assert.strictEqual((await post(base, '/api/pay/fail', { orderId: o.orderId, code: 'PAY_PROCESS_ABORTED' })).status, 200);
    assert.strictEqual(ledger.orders.get(o.orderId).status, 'failed');
    assert.strictEqual((await post(base, '/api/pay/fail', { code: 'PAY_PROCESS_CANCELED' })).status, 200);
    const other = await order(base, OTHER);
    await post(base, '/api/pay/fail', { orderId: other.orderId, code: 'X' });   // 남의 주문은 바꾸지 못함
    assert.strictEqual(ledger.orders.get(other.orderId).status, 'pending');
  });
});

test('without Toss keys the payment endpoints are off and nothing is saved', async () => {
  const ledger = fakeLedger();
  await withServer({ credits: ledger, toss: null, tossClientKey: '' }, async (base) => {
    assert.strictEqual((await post(base, '/api/pay/order')).status, 404);
    assert.strictEqual((await post(base, '/api/pay/confirm', { paymentKey: PAYMENT_KEY, orderId: CLIENT, amount: 1000 })).status, 404);
  });
  assert.strictEqual(ledger.orders.size, 0);
});

test('the Toss client sends the secret key as Basic auth with a trailing colon', async () => {
  const seen = [];
  const toss = createTossClient({ secretKey: 'test_sk_abc', fetchImpl: async (url, init) => { seen.push({ url, init }); return { ok: true, status: 200, json: async () => ({ status: 'DONE' }) }; } });
  await toss.confirm({ paymentKey: 'pk', orderId: 'o', amount: 1000 });
  assert.strictEqual(seen[0].url, 'https://api.tosspayments.com/v1/payments/confirm');
  assert.strictEqual(seen[0].init.headers.Authorization, 'Basic ' + Buffer.from('test_sk_abc:').toString('base64'));
  assert.deepStrictEqual(JSON.parse(seen[0].init.body), { paymentKey: 'pk', orderId: 'o', amount: 1000 });
});
