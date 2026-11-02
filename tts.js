// 상대역 대사 읽어 주기: Google Text-to-Speech(Chirp 3 HD)로 합성한 MP3를 돌려줌 (POST /api/tts)
// 비용 보호: 목록에 있는 한국어 목소리만, 대사 하나 400자까지, IP·전체 요청 수 제한, 인스턴스별 하루 글자 수 한도.
// 같은 대사·목소리·속도는 메모리에 저장해 두고 다시 합성하지 않음 (반복 연습에서 비용이 거의 안 듦)
'use strict';
const crypto = require('node:crypto');
const { isCloudVoice, clampRate, languageOf } = require('./voicecatalog.js');

const TTS_URL = 'https://texttospeech.googleapis.com/v1/text:synthesize';
const MAX_TTS_CHARS = 400;
const MAX_BODY_BYTES = 4 * 1024;
const DAILY_CHARS = 80_000;              // 인스턴스 하나가 하루에 새로 합성하는 글자 수 상한 (최대 3개 인스턴스)
// 한 사람(IP)이 하루에 새로 합성하는 글자 수 상한: 장편에서 작은 배역을 맡아도 한 번은 끝까지 가는 양
// (예: '국물 있사옵니다'에서 아미 역 → 상대 대사·괄호 지문 약 3만 2천 자)
const DAILY_CHARS_PER_CLIENT = 40_000;
const CACHE_MAX_BYTES = 20 * 1024 * 1024;
const TTS_RATE_LIMIT = { max: 120, windowMs: 60_000 };
const TTS_GLOBAL_LIMIT = { max: 600, windowMs: 60_000 };
const DAY_MS = 24 * 60 * 60 * 1000;
const USED_UP = '오늘 쓸 수 있는 음성 합성 양을 다 썼습니다. 휴대폰 기본 목소리로 바꿔 주세요.';

// 의미읽기: 상대역이 문장 끝에서만 쉬어 기계처럼 들렸음 → 뜻이 끊기는 자리에 Chirp 3 쉼 표시를 넣음 (markup 칸에서만 동작)
// · 줄 중간의 '...'·'…' 뒤는 길게, 문장과 문장 사이·'—' 뒤는 보통으로
// · 쉼표 없는 긴 한국어 문장은 이어 주는 말끝(-서·-고·-는데·-지만·-면 …) 뒤에서 짧게 숨을 쉼
//   (앞에서 7음절 넘게 말했고 뒤에 5음절 넘게 남았을 때만: 짧은 문장을 잘게 끊지 않게. 쉼 표시를 남발하면 오히려 어색해짐)
// 실측(Chirp 3 HD): '3년 만에 갑자기 나타나서 커피 한 잔 시켜 놓고 두 시간째야.'를 그냥 보내면 한 번, 이렇게 보내면 뜻 단위로 세 번 쉼
const CONNECTIVE_END = /(?:서|고|는데|은데|던데|지만|면|니까|으니|아도|어도|여도|다가|려고|도록|면서)[.?!]?$/;
const BREATH_AFTER_SYLLABLES = 7;
const BREATH_BEFORE_SYLLABLES = 5;
const syllables = (s) => (s.match(/[가-힣A-Za-z0-9]/g) || []).length;

function breathe(sentence) {
  if (sentence.includes(',')) return sentence;   // 쉼표가 이미 끊어 줌
  const words = sentence.split(' ');
  let total = syllables(sentence);
  let since = 0;
  return words.map((word) => {
    const n = syllables(word);
    since += n;
    total -= n;
    if (since < BREATH_AFTER_SYLLABLES || total < BREATH_BEFORE_SYLLABLES || !CONNECTIVE_END.test(word)) return word;
    since = 0;
    return `${word} [pause short]`;
  }).join(' ');
}

function readingMarkup(text, voice) {
  const korean = languageOf(voice) === 'ko-KR';
  const sentences = text.split(/(?<=[.?!…—])\s+/);
  return sentences.map((s, i) => {
    const read = korean ? breathe(s) : s;
    if (i === sentences.length - 1) return read;
    return `${read} ${/(\.\.\.|…)$/.test(s) ? '[pause long]' : '[pause]'}`;
  }).join(' ');
}

function createGoogleSynthesizer({ getAuth, timeoutMs }) {
  return async function synthesize({ text, voice, rate }) {
    const { token, project } = await getAuth();
    const markup = readingMarkup(text, voice);
    const res = await fetch(TTS_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(project ? { 'x-goog-user-project': project } : {}) },
      body: JSON.stringify({ input: markup === text ? { text } : { markup }, voice: { languageCode: languageOf(voice), name: voice }, audioConfig: { audioEncoding: 'MP3', speakingRate: rate } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`tts ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = await res.json();
    return Buffer.from(body.audioContent, 'base64');
  };
}

// 하루 단위로 다시 채워지는 한도. key별로 따로 셈 (key를 안 주면 전체 한 묶음).
// spend(양, key) → 쓸 수 있으면 true, spend.refund(양, key) → 실패한 요청 몫을 돌려줌
function createDailyBudget(limit, now = Date.now) {
  let day = Math.floor(now() / DAY_MS);
  let used = new Map();
  const roll = () => {
    const today = Math.floor(now() / DAY_MS);
    if (today !== day) { day = today; used = new Map(); }
  };
  function spend(amount, key = '') {
    roll();
    const current = used.get(key) || 0;
    if (current + amount > limit) return false;
    used.set(key, current + amount);
    return true;
  }
  spend.refund = (amount, key = '') => { roll(); used.set(key, Math.max(0, (used.get(key) || 0) - amount)); };
  return spend;
}

function parseRequest(raw) {
  let body;
  try { body = JSON.parse(raw.toString('utf8')); } catch { return { error: '요청 형식이 잘못되었습니다.' }; }
  if (!body || typeof body !== 'object') return { error: '요청 형식이 잘못되었습니다.' };
  const text = typeof body.text === 'string' ? body.text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim() : '';
  if (!text) return { error: '읽을 대사가 없습니다.' };
  if (text.length > MAX_TTS_CHARS) return { error: `대사가 너무 깁니다(${MAX_TTS_CHARS}자까지).` };
  if (!isCloudVoice(body.voice)) return { error: '지원하지 않는 목소리입니다.' };
  return { text, voice: body.voice, rate: Math.round(clampRate(body.rate) * 100) / 100 };
}

function createTtsHandler({ synthesize, readBody, sendJson, send, clientIp, createRateLimiter, dailyChars = DAILY_CHARS, dailyCharsPerClient = DAILY_CHARS_PER_CLIENT }) {
  const allow = createRateLimiter(TTS_RATE_LIMIT);
  const allowGlobal = createRateLimiter(TTS_GLOBAL_LIMIT);
  const spendAll = createDailyBudget(dailyChars);
  const spendClient = createDailyBudget(dailyCharsPerClient);
  const cache = new Map();  // 넣은 순서 = 오래된 순서 (용량이 넘치면 가장 오래 안 쓴 것부터 버림)
  let cacheBytes = 0;

  const remember = (key, audio) => {
    if (cache.has(key)) { cacheBytes -= cache.get(key).length; cache.delete(key); }
    cache.set(key, audio);
    cacheBytes += audio.length;
    while (cacheBytes > CACHE_MAX_BYTES && cache.size > 1) {
      const [oldKey, old] = cache.entries().next().value;
      cache.delete(oldKey);
      cacheBytes -= old.length;
    }
  };

  return async function handleTts(req, res) {
    if (!allow(clientIp(req)) || !allowGlobal('all')) { req.resume(); return sendJson(res, 429, { error: '요청이 너무 많습니다. 잠시 뒤 다시 해 주세요.' }); }
    let raw;
    try { raw = await readBody(req, MAX_BODY_BYTES); } catch (err) { return sendJson(res, err.status || 400, { error: '요청을 받지 못했습니다.' }); }
    const parsed = parseRequest(raw);
    if (parsed.error) return sendJson(res, 400, { error: parsed.error });
    const key = crypto.createHash('sha1').update(`${parsed.voice}|${parsed.rate}|${parsed.text}`).digest('hex');
    let audio = cache.get(key);
    if (!audio) {
      const who = clientIp(req);
      const chars = parsed.text.length;
      if (!spendClient(chars, who)) return sendJson(res, 429, { error: USED_UP });
      if (!spendAll(chars)) { spendClient.refund(chars, who); return sendJson(res, 429, { error: USED_UP }); }
      try { audio = await synthesize(parsed); } catch (err) {
        spendAll.refund(chars);
        spendClient.refund(chars, who);
        console.error('[tts]', err.message);  // 자세한 원인은 서버 로그에만
        return sendJson(res, 502, { error: '음성 합성 서버에서 오류가 났습니다.' });
      }
    }
    remember(key, audio);
    return send(res, 200, audio, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' });
  };
}

module.exports = { createTtsHandler, createGoogleSynthesizer, createDailyBudget, parseRequest, readingMarkup, MAX_TTS_CHARS };
