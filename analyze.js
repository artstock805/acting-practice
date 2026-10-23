// AI 배역 분석 (POST /api/analyze): 대본을 Claude에게 보내 배역마다 성별·나이대·성격·말투를 읽고
// voicecatalog.js의 목소리 중 어울리는 것을 추천받음. '/api/analyze'는 사용자가 버튼을 눌렀을 때만 불림.
// API 키는 Secret Manager → 환경 변수 ANTHROPIC_API_KEY로만 받음 (키가 없으면 503으로 '설정 안 됨' 안내)
'use strict';
const { CASTABLE, voiceLabel, isCloudVoice, clampRate } = require('./voicecatalog.js');

const MODEL = 'claude-opus-5-5';
const MAX_SCRIPT_CHARS = 150_000;       // 장편 대본도 들어가는 크기. 넘으면 잘라 보내지 않고 거절함
const MAX_CHARACTERS = 40;
const MAX_BODY_BYTES = 700 * 1024;      // 한글 15만 자(약 450KB) + 여유
const ANALYZE_RATE_LIMIT = { max: 5, windowMs: 10 * 60_000 };
const ANALYZE_GLOBAL_LIMIT = { max: 10, windowMs: 60 * 60_000 };  // 인스턴스 전체 시간당 횟수 (IP를 바꿔 가며 보내는 남용 대비)
const DAILY_ANALYSES = 20;              // 인스턴스 하나가 하루에 하는 분석 횟수 상한 (비용 보호, 최대 3개 인스턴스)
const DAILY_ANALYSES_PER_CLIENT = 10;   // 한 사람(IP)이 하루에 하는 분석 횟수 상한
const MAX_IN_FLIGHT = 2;                // 동시에 진행하는 분석 수 (큰 대본 여러 개가 메모리를 다 쓰지 않게)
const USED_UP = '오늘 할 수 있는 AI 분석 횟수를 다 썼습니다. 내일 다시 해 주세요.';
const CLAUDE_TIMEOUT_MS = 120_000;
const AGES = ['어린이', '10대', '20대', '30대', '40대', '50대', '60대 이상', '알 수 없음'];

const SCHEMA = {
  type: 'object',
  properties: {
    characters: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          gender: { type: 'string', enum: ['male', 'female', 'unknown'] },
          age: { type: 'string', enum: AGES },
          personality: { type: 'string' },
          speech: { type: 'string' },
          voice: { type: 'string', enum: CASTABLE.map((v) => v.id) },
          rate: { type: 'number' },
          reason: { type: 'string' },
        },
        required: ['name', 'gender', 'age', 'personality', 'speech', 'voice', 'rate', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['characters'],
  additionalProperties: false,
};

function buildPrompt(script, characters) {
  const catalog = CASTABLE.map((v) => `- ${v.id}: ${voiceLabel(v)} (평균 음높이 ${v.pitch}Hz)`).join('\n');
  const system = [
    '당신은 한국어 라디오 드라마의 캐스팅 디렉터입니다. 배우가 혼자 대사를 연습할 때 상대역을 읽어 줄 합성 음성을 고릅니다.',
    '대본을 읽고 배역마다 성별, 나이대, 성격, 말투를 대사·지문·호칭(예: 엄마, 여사, 사장님, 형)·반말과 존댓말에서 추론하세요.',
    '그리고 아래 목록에서 그 인물에 가장 어울리는 목소리를 하나 고르세요. 목록에 아이 목소리는 없으니 어린이는 가장 높고 앳된 목소리로 하세요.',
    '대사가 많은 인물끼리는 서로 다른 목소리를 주어 듣는 사람이 구별할 수 있게 하고, 목소리가 모자라면 대사가 적은 인물끼리 겹치게 하세요.',
    '말 속도(rate)는 0.8(느림)~1.2(빠름) 사이로, 성격과 나이에 맞게 정하세요. 보통은 1.0입니다.',
    'personality, speech, reason은 배우가 읽을 짧은 한국어 한두 문장으로 쓰세요. 대본에 근거가 없으면 추측이라고 밝히세요.',
    '',
    '고를 수 있는 목소리:',
    catalog,
  ].join('\n');
  const user = `분석할 배역: ${characters.join(', ')}\n\n<script>\n${script}\n</script>`;
  return { system, user };
}

// Claude 답에서 요청한 배역·목록에 있는 목소리만 남기고 속도는 허용 범위로 맞춤
function normalizeCasting(list, characters) {
  const wanted = new Set(characters);
  const text = (v) => (typeof v === 'string' ? v.slice(0, 300) : '');
  return (Array.isArray(list) ? list : [])
    .filter((c) => c && wanted.has(c.name))
    .map((c) => ({
      name: c.name,
      gender: ['male', 'female'].includes(c.gender) ? c.gender : 'unknown',
      age: AGES.includes(c.age) ? c.age : '알 수 없음',
      personality: text(c.personality),
      speech: text(c.speech),
      voice: isCloudVoice(c.voice) ? c.voice : null,
      rate: Math.round(clampRate(c.rate) * 100) / 100,
      reason: text(c.reason),
    }));
}

async function analyzeWithClaude({ script, characters }, client) {
  const { system, user } = buildPrompt(script, characters);
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',   // 안전 분류기가 거절하면 서버가 다른 모델로 다시 시도
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
    system,
    messages: [{ role: 'user', content: user }],
  });
  if (response.stop_reason === 'refusal') throw new Error('claude refusal');
  if (response.stop_reason === 'max_tokens') throw new Error('claude max_tokens');
  const block = response.content.find((b) => b.type === 'text');
  if (!block) throw new Error('claude returned no text');
  return normalizeCasting(JSON.parse(block.text).characters, characters);
}

// 키가 있을 때만 SDK를 불러 Claude 호출 함수를 만듦 (테스트·키 없는 환경에서는 SDK가 필요 없음)
function createClaudeAnalyzer(rawKey = process.env.ANTHROPIC_API_KEY) {
  const apiKey = (rawKey || '').trim();  // 키를 넣을 때 딸려 온 줄바꿈 제거
  if (!apiKey) return null;
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey, timeout: CLAUDE_TIMEOUT_MS, maxRetries: 1 });
  return (args) => analyzeWithClaude(args, client);
}

function parseRequest(raw) {
  let body;
  try { body = JSON.parse(raw.toString('utf8')); } catch { return { status: 400, error: '요청 형식이 잘못되었습니다.' }; }
  const script = body && typeof body.script === 'string' ? body.script.trim() : '';
  if (!script) return { status: 400, error: '분석할 대본이 없습니다.' };
  if (script.length > MAX_SCRIPT_CHARS) return { status: 413, error: `대본이 너무 깁니다(${MAX_SCRIPT_CHARS.toLocaleString()}자까지).` };
  const names = Array.isArray(body.characters) ? [...new Set(body.characters.filter((n) => typeof n === 'string' && n.trim()).map((n) => n.trim().slice(0, 40)))] : [];
  if (!names.length) return { status: 400, error: '분석할 배역이 없습니다.' };
  if (names.length > MAX_CHARACTERS) return { status: 400, error: `배역이 너무 많습니다(${MAX_CHARACTERS}명까지).` };
  return { script, characters: names };
}

function createAnalyzeHandler({ analyze, readBody, sendJson, clientIp, createRateLimiter, createDailyBudget, daily = DAILY_ANALYSES, maxInFlight = MAX_IN_FLIGHT }) {
  const allow = createRateLimiter(ANALYZE_RATE_LIMIT);
  const allowGlobal = createRateLimiter(ANALYZE_GLOBAL_LIMIT);
  const spendAll = createDailyBudget(daily);
  const spendClient = createDailyBudget(DAILY_ANALYSES_PER_CLIENT);
  let inFlight = 0;
  return async function handleAnalyze(req, res) {
    if (!analyze) { req.resume(); return sendJson(res, 503, { error: 'AI 배역 분석이 아직 설정되지 않았습니다.' }); }
    const who = clientIp(req);
    if (inFlight >= maxInFlight) { req.resume(); return sendJson(res, 503, { error: '지금 다른 분석이 진행 중이에요. 잠시 뒤 다시 해 주세요.' }); }
    if (!allow(who)) { req.resume(); return sendJson(res, 429, { error: 'AI 분석은 10분에 5번까지 할 수 있어요. 잠시 뒤 다시 해 주세요.' }); }
    let raw;
    try { raw = await readBody(req, MAX_BODY_BYTES); } catch (err) {
      return sendJson(res, err.status || 400, { error: err.status === 413 ? '대본이 너무 깁니다.' : '요청을 받지 못했습니다.' });
    }
    const parsed = parseRequest(raw);
    if (parsed.error) return sendJson(res, parsed.status, { error: parsed.error });
    if (!allowGlobal('all') || !spendClient(1, who)) return sendJson(res, 429, { error: USED_UP });
    if (!spendAll(1)) { spendClient.refund(1, who); return sendJson(res, 429, { error: USED_UP }); }
    inFlight++;
    try {
      return sendJson(res, 200, { characters: await analyze(parsed) });
    } catch (err) {
      spendAll.refund(1);
      spendClient.refund(1, who);
      console.error('[analyze]', err.message);  // 자세한 원인은 서버 로그에만
      return sendJson(res, 502, { error: 'AI 분석 중 오류가 났습니다. 잠시 뒤 다시 해 주세요.' });
    } finally {
      inFlight--;
    }
  };
}

module.exports = { createAnalyzeHandler, createClaudeAnalyzer, analyzeWithClaude, buildPrompt, normalizeCasting, MAX_SCRIPT_CHARS };
