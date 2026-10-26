// 작품 분석 (POST /api/insight): 대본을 Claude에게 보내 작품 전체 초목표·주제·관통행동,
// 배역별 초목표·관통행동·장애물·근거 대사, 인물 관계(관계도용)를 받음. 사용자가 버튼을 눌렀을 때만 불림
'use strict';
const { MODEL, ENGLISH_NOTE } = require('./analyze.js');

const KINDS = ['love', 'family', 'friend', 'rival', 'hostile', 'work', 'other'];
const DIRECTIONS = ['mutual', 'a_to_b', 'b_to_a'];
const MAX_TEXT = 400;
const MAX_EVIDENCE = 3;
const MAX_RELATIONSHIPS = 60;

const str = { type: 'string' };
const SCHEMA = {
  type: 'object',
  properties: {
    play: {
      type: 'object',
      properties: { super_objective: str, theme: str, through_action: str, summary: str },
      required: ['super_objective', 'theme', 'through_action', 'summary'],
      additionalProperties: false,
    },
    characters: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: str, super_objective: str, through_action: str, obstacle: str, evidence: { type: 'array', items: str } },
        required: ['name', 'super_objective', 'through_action', 'obstacle', 'evidence'],
        additionalProperties: false,
      },
    },
    relationships: {
      type: 'array',
      items: {
        type: 'object',
        properties: { a: str, b: str, kind: { type: 'string', enum: KINDS }, label: str, direction: { type: 'string', enum: DIRECTIONS }, note: str },
        required: ['a', 'b', 'kind', 'label', 'direction', 'note'],
        additionalProperties: false,
      },
    },
  },
  required: ['play', 'characters', 'relationships'],
  additionalProperties: false,
};

function buildInsightPrompt(script, characters, lang = 'ko') {
  const system = [
    '당신은 스타니슬랍스키 방법을 쓰는 연기 코치이자 드라마투르그입니다. 배우가 대본을 분석하도록 돕습니다.',
    '대본을 읽고 다음을 한국어로 정리하세요.',
    ...(lang === 'en' ? [ENGLISH_NOTE + ' 근거 대사는 영어 원문 그대로 옮기세요.'] : []),
    '- 작품 전체: 초목표(작품이 끝내 말하려는 것, 한 문장), 주제(짧은 말), 관통행동(극 전체를 꿰뚫는 큰 행동), 줄거리 요약(두세 문장).',
    '- 배역마다: 초목표(그 인물이 극 전체에서 끝내 원하는 것), 관통행동, 가장 큰 장애물, 근거가 되는 짧은 대사 1~3개(대본에 있는 그대로, 60자 이내).',
    '- 인물 관계: 의미 있는 관계만 골라 두 인물(a, b), 종류(kind), 짧은 이름(label, 예: 헤어진 연인, 형제, 상사와 부하), 방향(일방적이면 a_to_b), 한 줄 설명(note).',
    '초목표와 관통행동은 배우가 바로 연기에 쓸 수 있게 "~하고 싶다", "~하려 한다"처럼 능동적인 동사로 쓰세요.',
    '대본에 근거가 약한 해석은 "해석:"으로 시작해 추측임을 밝히세요. 이름은 주어진 배역 이름을 그대로 쓰세요.',
  ].join('\n');
  const user = `배역: ${characters.join(', ')}\n\n<script>\n${script}\n</script>`;
  return { system, user };
}

const text = (v, max = MAX_TEXT) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// Claude 답을 화면이 믿고 그릴 수 있는 모양으로 정리 (모르는 이름·자기 자신·중복 관계는 버림)
function normalizeInsight(raw, characters) {
  const names = new Set(characters);
  const body = raw && typeof raw === 'object' ? raw : {};
  const play = body.play && typeof body.play === 'object' ? body.play : {};
  const seen = new Set();
  const relationships = (Array.isArray(body.relationships) ? body.relationships : [])
    .filter((r) => r && names.has(r.a) && names.has(r.b) && r.a !== r.b && KINDS.includes(r.kind))
    .filter((r) => {
      const key = [r.a, r.b].sort().join('|');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_RELATIONSHIPS)
    .map((r) => ({ a: r.a, b: r.b, kind: r.kind, label: text(r.label, 40), direction: DIRECTIONS.includes(r.direction) ? r.direction : 'mutual', note: text(r.note, 200) }));
  return {
    play: { super_objective: text(play.super_objective), theme: text(play.theme, 100), through_action: text(play.through_action), summary: text(play.summary, 600) },
    characters: (Array.isArray(body.characters) ? body.characters : [])
      .filter((c) => c && names.has(c.name))
      .map((c) => ({
        name: c.name,
        super_objective: text(c.super_objective),
        through_action: text(c.through_action),
        obstacle: text(c.obstacle),
        evidence: (Array.isArray(c.evidence) ? c.evidence : []).map((e) => text(e, 120)).filter(Boolean).slice(0, MAX_EVIDENCE),
      })),
    relationships,
  };
}

async function insightWithClaude({ script, characters, lang = 'ko' }, client) {
  const { system, user } = buildInsightPrompt(script, characters, lang);
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
    system,
    messages: [{ role: 'user', content: user }],
  });
  if (response.stop_reason === 'refusal') throw new Error('claude refusal');
  if (response.stop_reason === 'max_tokens') throw new Error('claude max_tokens');
  const block = response.content.find((b) => b.type === 'text');
  if (!block) throw new Error('claude returned no text');
  return normalizeInsight(JSON.parse(block.text), characters);
}

module.exports = { insightWithClaude, buildInsightPrompt, normalizeInsight, KINDS };
