// 장면 그림 설명 (POST /api/scene-art): 대본을 Claude에게 보내 장면마다 그림 서비스에 줄 영어 배경(공간) 설명을 받음. 인물은 빼고 공간만.
// 그림 서비스는 한국어 장면 제목(예: '상범집')을 알아듣지 못해 내용과 상관없는 그림이 나왔음 → 지문·대사에서 장소·시간·인물을 읽어 영어로.
// 'AI 장면 이미지 생성'을 켰을 때 대본마다 한 번만 불림 (앱이 결과를 저장해 둠)
'use strict';
const { MAX_SCRIPT_CHARS } = require('./analyze.js');

const MODEL = 'claude-haiku-5-5';   // 짧은 그림 설명이라 작은 모델로 충분 (비용 절약)
const MAX_SCENES = 200;
const MAX_SCENE_TITLE = 120;
const MAX_PROMPT = 400;

const SCHEMA = {
  type: 'object',
  properties: {
    scenes: {
      type: 'array',
      items: {
        type: 'object',
        properties: { scene: { type: 'string' }, prompt: { type: 'string' } },
        required: ['scene', 'prompt'],
        additionalProperties: false,
      },
    },
  },
  required: ['scenes'],
  additionalProperties: false,
};

function buildSceneArtPrompt(script, scenes) {
  const system = [
    '당신은 영화 미술감독입니다. 대본의 장면마다 이미지 생성 AI에 줄 배경 그림 설명을 씁니다.',
    '각 장면의 제목·지문·대사에서 그 장면이 벌어지는 공간을 찾아 그리세요: 장소, 시간대, 날씨, 빛, 분위기, 가구와 눈에 띄는 소품.',
    '인물은 그리지 마세요. 사람이 없는 빈 공간(세트)으로, 인물이 막 머물렀거나 곧 들어올 것 같은 흔적(놓인 술잔, 켜진 전등 등)은 괜찮습니다.',
    '설명은 반드시 English로, 60단어 이내의 한 문단으로 쓰세요. 이미지 AI는 한국어와 고유명사를 모르므로 인물 이름·지명 대신 모습으로 묘사하세요.',
    '대본이 한국 배경이면 한국의 집·거리·소품으로 그리세요. 대본에 없는 장소나 사물은 지어내지 마세요.',
    '글자·간판 문구·로고는 넣지 마세요. scene에는 주어진 장면 제목을 글자 하나 바꾸지 말고 그대로 쓰세요.',
  ].join('\n');
  const user = `장면 제목:\n${scenes.map((s) => `- ${s}`).join('\n')}\n\n<script>\n${script}\n</script>`;
  return { system, user };
}

// 모르는 장면·중복은 버리고, 긴 설명은 자름 → { 장면 제목: 영어 설명 }
function normalizeSceneArt(raw, scenes) {
  const known = new Set(scenes);
  const out = {};
  (raw && Array.isArray(raw.scenes) ? raw.scenes : []).forEach((s) => {
    if (!s || !known.has(s.scene) || out[s.scene] || typeof s.prompt !== 'string') return;
    const prompt = s.prompt.trim().slice(0, MAX_PROMPT);
    if (prompt) out[s.scene] = prompt;
  });
  return out;
}

async function sceneArtWithClaude({ script, scenes }, client) {
  const { system, user } = buildSceneArtPrompt(script, scenes);
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    output_config: { format: { type: 'json_schema', schema: SCHEMA } },
    system,
    messages: [{ role: 'user', content: user }],
  });
  if (response.stop_reason === 'refusal') throw new Error('claude refusal');
  if (response.stop_reason === 'max_tokens') throw new Error('claude max_tokens');
  const block = response.content.find((b) => b.type === 'text');
  if (!block) throw new Error('claude returned no text');
  return normalizeSceneArt(JSON.parse(block.text), scenes);
}

function parseSceneArtRequest(raw) {
  let body;
  try { body = JSON.parse(raw.toString('utf8')); } catch { return { status: 400, error: '요청 형식이 잘못되었습니다.' }; }
  const script = body && typeof body.script === 'string' ? body.script.trim() : '';
  if (!script) return { status: 400, error: '대본이 없습니다.' };
  if (script.length > MAX_SCRIPT_CHARS) return { status: 413, error: `대본이 너무 깁니다(${MAX_SCRIPT_CHARS.toLocaleString()}자까지).` };
  const scenes = Array.isArray(body.scenes)
    ? [...new Set(body.scenes.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim().slice(0, MAX_SCENE_TITLE).trim()))]
    : [];
  if (!scenes.length) return { status: 400, error: '장면이 없습니다.' };
  if (scenes.length > MAX_SCENES) return { status: 400, error: `장면이 너무 많습니다(${MAX_SCENES}개까지).` };
  return { script, scenes, lang: body.lang === 'en' ? 'en' : 'ko' };
}

module.exports = { sceneArtWithClaude, buildSceneArtPrompt, normalizeSceneArt, parseSceneArtRequest, MODEL };
