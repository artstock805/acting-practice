// AI 분석 크레딧 (시험 단계): Supabase 원장(supabase/credits.sql)에 차감·환불을 기록하고 잔액은 원장의 합으로 셈.
// SUPABASE_URL과 SUPABASE_SERVICE_KEY가 둘 다 있을 때만 켜짐 (운영 배포는 비밀값을 덮어써서 꺼진 채로 남음)
// 사람 구분은 브라우저가 만든 임시 ID(X-Client-Id). 로그인을 붙이면 사용자 ID로 바꿈
'use strict';
const crypto = require('node:crypto');

const ANALYSIS_COST = 100;              // AI 분석 1회 = 100크레딧 = 1,000원
const SUPABASE_TIMEOUT_MS = 8000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 같은 대본인지 가리는 값 (서버가 받은 대본으로 직접 계산. 브라우저가 보낸 해시는 믿지 않음)
const scriptHash = (script) => crypto.createHash('sha256').update(script, 'utf8').digest('hex');

function headerId(req, name) {
  const v = req.headers[name];
  return typeof v === 'string' && UUID_RE.test(v) ? v.toLowerCase() : '';
}
const clientIdOf = (req) => headerId(req, 'x-client-id');
// 다시 보낸 같은 요청을 알아보는 값. 없으면 새로 만듦 (그 요청은 재전송 보호를 받지 못할 뿐 차감은 정상)
const requestIdOf = (req) => headerId(req, 'x-request-id') || crypto.randomUUID();

function createSupabaseCreditStore({ url, serviceKey, fetchImpl = fetch, timeoutMs = SUPABASE_TIMEOUT_MS }) {
  const base = url.replace(/\/+$/, '');
  async function rpc(name, args) {
    const res = await fetchImpl(`${base}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(timeoutMs),
    });
    // 키나 내부 정보가 응답 본문에 섞여도 로그에 남지 않게 상태 코드만
    if (!res.ok) throw new Error(`supabase ${name} ${res.status}`);
    return res.status === 204 ? null : res.json();   // 돌려주는 값이 없는 함수(fail_payment_order)는 빈 응답
  }
  return {
    spend: ({ clientId, scriptHash: hash, requestId }) =>
      rpc('spend_analysis', { p_client_id: clientId, p_script_hash: hash, p_request_id: requestId, p_cost: ANALYSIS_COST }),
    refund: (ledgerId) => rpc('refund_analysis', { p_ledger_id: ledgerId }),
    balance: (clientId) => rpc('credit_balance', { p_client_id: clientId }),
    // 결제 주문 (payments.js가 씀)
    createOrder: ({ clientId, orderId, amount, credits, orderName }) =>
      rpc('create_payment_order', { p_client_id: clientId, p_order_id: orderId, p_amount: amount, p_credits: credits, p_order_name: orderName }),
    getOrder: (orderId) => rpc('get_payment_order', { p_order_id: orderId }),
    completeOrder: ({ orderId, paymentKey, amount }) =>
      rpc('complete_payment_order', { p_order_id: orderId, p_payment_key: paymentKey, p_amount: amount }),
    failOrder: ({ orderId, code }) => rpc('fail_payment_order', { p_order_id: orderId, p_code: code }),
  };
}

function createCreditStoreFromEnv(env = process.env) {
  const url = (env.SUPABASE_URL || '').trim();
  const serviceKey = (env.SUPABASE_SERVICE_KEY || '').trim();   // Secret Manager 값에 딸려 온 줄바꿈 제거
  return url && serviceKey ? createSupabaseCreditStore({ url, serviceKey }) : null;
}

module.exports = { ANALYSIS_COST, scriptHash, clientIdOf, requestIdOf, createSupabaseCreditStore, createCreditStoreFromEnv };
