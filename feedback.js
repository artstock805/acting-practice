// 사용자 피드백 (POST /api/feedback): AI 분석 결과에 대한 반응을 그 분석의 Langfuse 트레이스에 점수(score)로 붙임
// - user-feedback: 배역 분석·초목표 분석 아래 👍(1) / 👎(0). 결과 하나에 한 번 (같은 id로 보내 다시 눌러도 덮어씀)
// - voice-changed: AI가 추천한 목소리를 사용자가 바꾼 경우(1). 배역 이름·바꾼 목소리는 comment로
// Langfuse 키가 없으면 204로 조용히 무시하고, Langfuse 오류도 사용자에게는 204 (화면을 막지 않음)
// 서버 로그에는 comment(배역 이름)를 남기지 않음
'use strict';
const { flushQuietly } = require('./langfuse.js');

const FEEDBACK_NAMES = { 'user-feedback': [0, 1], 'voice-changed': [1] };   // 이름별로 받을 수 있는 값 (모두 BOOLEAN)
const TRACE_ID = /^[0-9a-f]{32}$/;   // OpenTelemetry trace id (16바이트 hex)
const OBSERVATION_ID = /^[0-9a-f]{16}$/;   // OpenTelemetry span id (8바이트 hex) = Claude 호출 generation의 id
const MAX_COMMENT = 300;
const MAX_BODY_BYTES = 2 * 1024;
const FEEDBACK_RATE_LIMIT = { max: 30, windowMs: 10 * 60_000 };         // IP당 10분에 30번
const FEEDBACK_GLOBAL_LIMIT = { max: 600, windowMs: 60 * 60_000 };      // 인스턴스 전체 시간당

const bad = (error) => ({ status: 400, error });

function parseFeedback(raw) {
  let body;
  try { body = JSON.parse(raw.toString('utf8')); } catch { return bad('요청 형식이 잘못되었습니다.'); }
  if (!body || typeof body !== 'object') return bad('요청 형식이 잘못되었습니다.');
  const { traceId, observationId, name, comment } = body;
  if (typeof traceId !== 'string' || !TRACE_ID.test(traceId)) return bad('어느 분석에 대한 의견인지 알 수 없습니다.');
  if (observationId !== undefined && (typeof observationId !== 'string' || !OBSERVATION_ID.test(observationId))) return bad('어느 분석에 대한 의견인지 알 수 없습니다.');
  if (!Object.hasOwn(FEEDBACK_NAMES, name)) return bad('받을 수 없는 의견 종류입니다.');
  const value = typeof body.value === 'boolean' ? Number(body.value) : body.value;
  if (!FEEDBACK_NAMES[name].includes(value)) return bad('받을 수 없는 값입니다.');
  if (comment !== undefined && typeof comment !== 'string') return bad('요청 형식이 잘못되었습니다.');
  const note = (comment || '').trim().slice(0, MAX_COMMENT);
  return {
    score: {
      // 좋아요/별로예요는 결과 하나에 하나: 같은 id면 Langfuse가 새로 만들지 않고 덮어씀
      ...(name === 'user-feedback' ? { id: `${traceId}-user-feedback` } : {}),
      // 관측 id까지 붙여야 Langfuse v4 화면(Tracing 표·관측 상세)에 점수가 보임 (트레이스만 붙이면 저장은 되지만 안 보임)
      traceId, ...(observationId ? { observationId } : {}), name, value, dataType: 'BOOLEAN',
      ...(note ? { comment: note } : {}),
    },
  };
}

function createFeedbackHandler({ scorer, readBody, sendJson, send, clientIp, createRateLimiter }) {
  const allow = createRateLimiter(FEEDBACK_RATE_LIMIT);
  const allowGlobal = createRateLimiter(FEEDBACK_GLOBAL_LIMIT);
  return async function handleFeedback(req, res) {
    if (!scorer) { req.resume(); return send(res, 204, ''); }
    if (!allow(clientIp(req)) || !allowGlobal('all')) { req.resume(); return sendJson(res, 429, { error: '잠시 뒤 다시 해 주세요.' }); }
    let raw;
    try { raw = await readBody(req, MAX_BODY_BYTES); } catch (err) {
      return sendJson(res, err.status === 413 ? 413 : 400, { error: '요청을 받지 못했습니다.' });
    }
    const parsed = parseFeedback(raw);
    if (parsed.error) return sendJson(res, parsed.status, { error: parsed.error });
    try {
      scorer.score(parsed.score);
      await flushQuietly(scorer);   // Cloud Run은 응답 뒤 CPU를 줄이므로 보내고 답함 (오래 걸리면 기다리지 않음)
    } catch (err) {
      console.error('[feedback]', err && err.message ? err.message : err);
    }
    return send(res, 204, '');
  };
}

module.exports = { parseFeedback, createFeedbackHandler, FEEDBACK_NAMES, MAX_BODY_BYTES };
