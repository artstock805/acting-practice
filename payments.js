// 크레딧 충전 결제 (토스페이먼츠 결제창, staging 시험 단계)
// 1) POST /api/pay/order   서버가 주문(금액·크레딧)을 먼저 저장하고 결제창에 넘길 값을 돌려줌
// 2) 브라우저가 토스 결제창을 띄움 → 성공하면 /?pay=success&paymentKey=…&orderId=…&amount=… 로 돌아옴
// 3) POST /api/pay/confirm 돌아온 금액이 저장한 주문 금액과 같을 때만 토스 승인 API를 부르고, 승인되면 원장에 충전 기록
// 결제 키(TOSS_SECRET_KEY)는 서버에만. TOSS_CLIENT_KEY·TOSS_SECRET_KEY·크레딧 원장이 모두 있을 때만 켜짐
'use strict';
const crypto = require('node:crypto');
const { clientIdOf } = require('./credits.js');

const TOSS_API = 'https://api.tosspayments.com/v1/payments';
const TOSS_TIMEOUT_MS = 15_000;
const ORDER_RATE_LIMIT = { max: 10, windowMs: 10 * 60_000 };   // 주문만 만들고 결제하지 않는 남용 대비
const MAX_BODY_BYTES = 4 * 1024;
// 지금은 한 상품만: AI 분석 1회 = 1,000원 = 100크레딧
const PRODUCT = { amount: 1000, credits: 100, name: 'AI 분석 1회 (100크레딧)' };
const PAYMENT_KEY_RE = /^[A-Za-z0-9_-]{1,200}$/;
const ORDER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// 토스 승인 API. 시크릿 키 뒤에 콜론을 붙여 Basic 인증 (비밀번호 없음)
function createTossClient({ secretKey, fetchImpl = fetch, timeoutMs = TOSS_TIMEOUT_MS }) {
  const auth = 'Basic ' + Buffer.from(secretKey + ':').toString('base64');
  async function call(url, init = {}) {
    const res = await fetchImpl(url, { ...init, headers: { Authorization: auth, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, body };
  }
  return {
    confirm: ({ paymentKey, orderId, amount }) => call(`${TOSS_API}/confirm`, { method: 'POST', body: JSON.stringify({ paymentKey, orderId, amount }) }),
    get: (paymentKey) => call(`${TOSS_API}/${encodeURIComponent(paymentKey)}`),
  };
}

// 토스가 '결제 완료'라고 한 결제가 이 주문·금액의 것인지
const isDoneFor = (payment, order) => payment && payment.status === 'DONE' && payment.orderId === order.order_id && payment.totalAmount === order.amount;

function createPaymentHandlers({ credits, toss, clientKey, readBody, sendJson, clientIp, createRateLimiter }) {
  const enabled = !!(credits && toss && clientKey);
  const allowOrder = createRateLimiter(ORDER_RATE_LIMIT);

  async function handleOrder(req, res) {
    req.resume();
    if (!enabled) return sendJson(res, 404, { error: '결제를 쓰지 않는 버전입니다.' });
    const clientId = clientIdOf(req);
    if (!clientId) return sendJson(res, 400, { error: '시험 ID가 없습니다.' });
    if (!allowOrder(clientIp(req))) return sendJson(res, 429, { error: '잠시 뒤 다시 해 주세요.' });
    const orderId = crypto.randomUUID();
    try {
      await credits.createOrder({ clientId, orderId, amount: PRODUCT.amount, credits: PRODUCT.credits, orderName: PRODUCT.name });
    } catch (err) {
      console.error('[pay] order', err.message);
      return sendJson(res, 503, { error: '주문을 만들지 못했어요. 잠시 뒤 다시 해 주세요.' });
    }
    return sendJson(res, 200, { orderId, amount: PRODUCT.amount, orderName: PRODUCT.name, credits: PRODUCT.credits, clientKey, customerKey: clientId });
  }

  // 결제 완료를 원장에 기록 (이미 기록했으면 그대로 성공)
  async function complete(res, order, paymentKey) {
    const done = await credits.completeOrder({ orderId: order.order_id, paymentKey, amount: order.amount });
    return sendJson(res, 200, { ok: true, credits: done.credits, balance: done.balance });
  }

  async function readJson(req) {
    try { return JSON.parse((await readBody(req, MAX_BODY_BYTES)).toString('utf8')) || {}; } catch { return null; }
  }

  async function handleConfirm(req, res) {
    if (!enabled) { req.resume(); return sendJson(res, 404, { error: '결제를 쓰지 않는 버전입니다.' }); }
    const body = await readJson(req);
    if (!body) return sendJson(res, 400, { error: '요청 형식이 잘못되었습니다.' });
    const paymentKey = typeof body.paymentKey === 'string' ? body.paymentKey : '';
    const orderId = typeof body.orderId === 'string' ? body.orderId : '';
    const amount = Number(body.amount);
    if (!PAYMENT_KEY_RE.test(paymentKey) || !ORDER_ID_RE.test(orderId) || !Number.isInteger(amount)) return sendJson(res, 400, { error: '결제 정보가 올바르지 않습니다.' });

    let order;
    try { order = await credits.getOrder(orderId); } catch (err) {
      console.error('[pay] get order', err.message);
      return sendJson(res, 503, { error: '주문을 확인하지 못했어요. 이 화면을 새로 고치면 다시 확인합니다.' });
    }
    if (!order || order.client_id !== clientIdOf(req)) return sendJson(res, 404, { error: '주문을 찾지 못했습니다.' });
    // 결제창에서 돌아온 금액이 서버에 저장한 금액과 다르면 승인하지 않음 (금액 조작 방지)
    if (amount !== order.amount) return sendJson(res, 400, { error: '결제 금액이 주문과 달라 승인하지 않았습니다.' });

    try {
      if (order.status === 'paid') return await complete(res, order, paymentKey);   // 새로 고침 등으로 다시 온 경우
      const result = await toss.confirm({ paymentKey, orderId, amount });
      if (result.ok && isDoneFor(result.body, order)) return await complete(res, order, paymentKey);
      // 앞선 승인 응답을 못 받고 다시 온 경우: 토스에 결제 상태를 물어 이미 완료됐으면 기록
      if (result.body && result.body.code === 'ALREADY_PROCESSED_PAYMENT') {
        const found = await toss.get(paymentKey);
        if (found.ok && isDoneFor(found.body, order)) return await complete(res, order, paymentKey);
      }
      const code = (result.body && result.body.code) || `HTTP_${result.status}`;
      await credits.failOrder({ orderId, code }).catch((e) => console.error('[pay] fail order', orderId, e.message));
      console.error('[pay] confirm rejected', orderId, code);
      return sendJson(res, 402, { error: (result.body && result.body.message) || '결제를 승인하지 못했습니다.', code });
    } catch (err) {
      // 토스 승인은 됐는데 원장 기록이 실패했을 수 있음 → 같은 정보로 다시 부르면 위의 ALREADY_PROCESSED 경로로 기록됨
      console.error('[pay] confirm error', orderId, err.message);
      return sendJson(res, 503, { error: '결제 확인 중 오류가 났어요. 이 화면을 새로 고치면 다시 확인합니다.' });
    }
  }

  // 결제창에서 취소·실패하고 돌아온 주문 정리 (크레딧은 그대로)
  async function handleFail(req, res) {
    if (!enabled) { req.resume(); return sendJson(res, 404, { error: '결제를 쓰지 않는 버전입니다.' }); }
    const body = await readJson(req);
    if (!body) return sendJson(res, 400, { error: '요청 형식이 잘못되었습니다.' });
    const orderId = typeof body.orderId === 'string' ? body.orderId : '';
    const code = typeof body.code === 'string' ? body.code.slice(0, 100) : 'UNKNOWN';
    if (!ORDER_ID_RE.test(orderId)) return sendJson(res, 200, { ok: true });   // 결제창에서 취소하면 orderId가 오지 않음
    try {
      const order = await credits.getOrder(orderId);
      if (order && order.client_id === clientIdOf(req)) await credits.failOrder({ orderId, code });
    } catch (err) { console.error('[pay] fail', orderId, err.message); }
    return sendJson(res, 200, { ok: true });
  }

  return { enabled, handleOrder, handleConfirm, handleFail };
}

function createTossClientFromEnv(env = process.env) {
  const secretKey = (env.TOSS_SECRET_KEY || '').trim();   // Secret Manager 값에 딸려 온 줄바꿈 제거
  return secretKey ? createTossClient({ secretKey }) : null;
}
const tossClientKeyFromEnv = (env = process.env) => (env.TOSS_CLIENT_KEY || '').trim();

module.exports = { PRODUCT, createTossClient, createPaymentHandlers, createTossClientFromEnv, tossClientKeyFromEnv };
