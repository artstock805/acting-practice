// Cloud Run용 서버: 정적 파일 서빙 + 휴대폰 녹음 음성 인식(/api/stt → Google Speech-to-Text).
// 의존성 없이 Node 내장 모듈만 사용. 로컬 실행: node server.js (PORT 기본 8080)
'use strict';
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { createTtsHandler, createGoogleSynthesizer, createDailyBudget } = require('./tts.js');
const { createAnalyzeHandler, createClaudeClient, analyzeWithClaude } = require('./analyze.js');
const { sceneArtWithClaude, parseSceneArtRequest } = require('./sceneart.js');
const { insightWithClaude } = require('./insight.js');
const { traceClaude, createLangfuseTracing, createLangfuseScorer, captureTraceId } = require('./langfuse.js');
const { createFeedbackHandler } = require('./feedback.js');
const { createLibraryHandler } = require('./library.js');

const ROOT = path.resolve(process.env.STATIC_ROOT || __dirname);
const MAX_AUDIO_BYTES = 2 * 1024 * 1024;   // 16kHz 모노 16bit 기준 약 65초
const MAX_AUDIO_SECONDS = 55;   // 긴 대사도 끝까지 (Google 한 번 인식 한도 60초보다 조금 짧게)
const RATE_LIMIT = { max: 30, windowMs: 60_000 };  // IP당 분당 요청 수
const GLOBAL_LIMIT = { max: 300, windowMs: 60_000 };  // 인스턴스 전체 분당 요청 수 (IP를 바꿔 가며 보내는 남용 대비)
const MAX_IN_FLIGHT = 10;          // 동시에 Google로 보내는 요청 수
const UPSTREAM_TIMEOUT_MS = 10_000;
// Speech-to-Text v2 (Chirp 3). v1 latest_long은 '네'·'응' 같은 한 글자 대사를 거의 못 알아들었음
// Chirp 3은 us·eu에만 있음. 서버(서울 Cloud Run)에서 실측: us 중앙값 약 1.7초, eu 약 2.1초 → us
const STT_LOCATION = 'us';
const sttUrl = (project) => `https://${STT_LOCATION}-speech.googleapis.com/v2/projects/${project}/locations/${STT_LOCATION}/recognizers/_:recognize`;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8', '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml',
  '.mjs': 'application/javascript; charset=utf-8', '.bcmap': 'application/octet-stream',   // PDF 읽기(pdf.js) 모듈·한글 글자표
  '.json': 'application/json', '.apk': 'application/vnd.android.package-archive',   // 안드로이드 앱 인증 파일(/.well-known/)·앱 설치 파일
};
const NO_CACHE = new Set(['.html', '.js', '.css', '.webmanifest']);  // 코드 파일은 매번 새로 확인 (수정 사항 바로 반영)
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.webmanifest', '.mjs', '.svg']);  // 글자 파일만 압축 (png·bcmap은 이미 압축됨)
const ASSET_MAX_AGE = 'public, max-age=3600';  // 그림·pdf.js 같은 큰 파일은 한 시간 동안 다시 묻지 않음
const SECURITY_HEADERS = {
  'Permissions-Policy': 'microphone=(self), camera=(), geolocation=()',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

// ---------- 입력 검사 ----------
// 브라우저가 보내는 WAV(PCM 16bit)인지 확인하고 형식 정보를 돌려줌. 아니면 null
function parseWavHeader(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let offset = 12;
  let fmt = null;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ' && size >= 16 && body + 16 <= buf.length) {
      fmt = { format: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2), sampleRate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    } else if (id === 'data' && fmt) {
      const dataBytes = Math.min(size, buf.length - body);
      const seconds = dataBytes / (fmt.sampleRate * fmt.channels * (fmt.bits / 8));
      return { ...fmt, dataOffset: body, dataBytes, seconds };
    }
    offset = body + size + (size % 2);
  }
  return null;
}

function validateWav(info) {
  if (!info) return 'WAV 형식이 아닙니다.';
  if (info.format !== 1 || info.bits !== 16 || info.channels !== 1) return '16bit 모노 PCM만 받습니다.';
  if (info.sampleRate < 8000 || info.sampleRate > 48000) return '지원하지 않는 샘플레이트입니다.';
  if (info.seconds > MAX_AUDIO_SECONDS) return `녹음이 너무 깁니다(${MAX_AUDIO_SECONDS}초까지).`;
  return null;
}

// 메모리 기반 고정 창 제한. 인스턴스가 여러 개면 인스턴스별로 따로 셈 (max-instances로 상한 관리)
function createRateLimiter({ max, windowMs }, now = Date.now) {
  const hits = new Map();
  return function allow(key) {
    const t = now();
    const entry = hits.get(key);
    if (!entry || t - entry.start >= windowMs) {
      // 오래 켜진 인스턴스에서 메모리가 무한히 늘지 않게, 창이 지난 기록만 지움 (전부 지우면 남의 제한까지 풀림)
      if (hits.size > 10_000) hits.forEach((e, k) => { if (t - e.start >= windowMs) hits.delete(k); });
      hits.set(key, { start: t, count: 1 });
      return true;
    }
    if (entry.count >= max) return false;
    hits.set(key, { start: entry.start, count: entry.count + 1 });
    return true;
  };
}

// ---------- Google 인증 ----------
// Cloud Run에서는 메타데이터 서버가 서비스 계정 토큰을 줌 (API 키 불필요).
// 로컬 개발: GCP_ACCESS_TOKEN=$(gcloud auth print-access-token) GCP_PROJECT=acting-practice node server.js
let cachedToken = null;
let tokenRequest = null;  // 토큰이 만료될 때 동시에 들어온 요청들이 한 번만 새로 받게 함
async function getAuth() {
  if (process.env.GCP_ACCESS_TOKEN) {
    return { token: process.env.GCP_ACCESS_TOKEN, project: process.env.GCP_PROJECT };
  }
  if (cachedToken && cachedToken.expires > Date.now() + 60_000) return { token: cachedToken.token };
  if (!tokenRequest) {
    tokenRequest = fetchMetadataToken().finally(() => { tokenRequest = null; });
  }
  return { token: await tokenRequest };
}

// v2 주소에는 프로젝트 ID가 들어감: 로컬은 환경 변수, Cloud Run은 메타데이터 서버에서 한 번 받아 둠
let projectRequest = null;
function getProjectId() {
  const fromEnv = process.env.GCP_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
  if (fromEnv) return Promise.resolve(fromEnv);
  if (!projectRequest) {
    projectRequest = fetch('http://metadata.google.internal/computeMetadata/v1/project/project-id', {
      headers: { 'Metadata-Flavor': 'Google' },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    }).then((res) => { if (!res.ok) throw new Error(`metadata project ${res.status}`); return res.text(); })
      .catch((err) => { projectRequest = null; throw err; });   // 실패하면 다음 요청에서 다시 받음
  }
  return projectRequest;
}

async function fetchMetadataToken() {
  const res = await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', {
    headers: { 'Metadata-Flavor': 'Google' },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`metadata token ${res.status}`);
  const body = await res.json();
  cachedToken = { token: body.access_token, expires: Date.now() + body.expires_in * 1000 };
  return cachedToken.token;
}

// ---------- 인식 힌트 ----------
// 앱은 사용자가 말할 대사를 알고 있음 → Google에 '이 문장이 나올 가능성이 높다'고 알려 주면 인식률이 크게 오름
const MAX_HINT_CHARS = 300;
const MAX_PHRASE_CHARS = 100;   // Speech-to-Text v1 phrase 한 개의 길이 한도
const HINT_BOOST = 20;          // 0~20. 높을수록 힌트 쪽으로 강하게 끌어당김 (한 글자 대사는 최대여야 잘 잡힘)
// 합성 음성(4가지 목소리)으로 비교: 한 글자 대사 '네·응·예·왜·뭐·아' 24개를 latest_long은 거의 0, Chirp 3 + 힌트 + 무음 자르기는 24/24
// 긴 대사도 그대로 정확함
const STT_MODEL = 'chirp_3';
const EMPTY_RETRIES = 2;   // 말소리가 있는데 빈 결과면 다시 묻는 횟수 (합성 음성 한 글자 대사: 1번 97% → 2번에서 남은 것까지)
const RETRY_WINDOW_MS = 6000;   // 이만큼 지났으면 더 묻지 않음 (채점 대기가 길어지지 않게)

// 대본 언어에 맞춰 인식 (X-Speech-Lang). 허용 목록 밖이면 한국어
const SPEECH_LANGS = new Set(['ko-KR', 'en-US']);
function speechLanguage(req) {
  const lang = String(req.headers['x-speech-lang'] || '');
  return SPEECH_LANGS.has(lang) ? lang : 'ko-KR';
}

// 휴대폰이 보낸 단계별 시간(X-Take-Info): 로그에 남길 글자만 남기고 짧게 자름
function takeInfo(req) {
  return String(req.headers['x-take-info'] || '').replace(/[^\w=;.-]/g, '').slice(0, 120);
}

function lineHint(req) {
  const raw = req.headers['x-line-hint'];
  if (!raw) return '';
  let text;
  try { text = decodeURIComponent(String(raw)); } catch { return ''; }
  return text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_HINT_CHARS);
}

// 문장부호에서 나누고, 그래도 긴 조각은 100자 단위로 자름
function hintPhrases(hint) {
  return String(hint || '').split(/[.!?…,~]+/).map((s) => s.trim()).filter(Boolean)
    .flatMap((s) => s.match(new RegExp(`[\\s\\S]{1,${MAX_PHRASE_CHARS}}`, 'g')).map((p) => p.trim()))
    .filter(Boolean);
}

// Speech v2 요청 본문 (pcm: 16bit 모노)
function sttRequest(pcm, sampleRate, hint, languageCode) {
  const phrases = hintPhrases(hint);
  return {
    config: {
      explicitDecodingConfig: { encoding: 'LINEAR16', sampleRateHertz: sampleRate, audioChannelCount: 1 },
      languageCodes: [languageCode],
      model: STT_MODEL,
      ...(phrases.length ? { adaptation: { phraseSets: [{ inlinePhraseSet: { phrases: phrases.map((value) => ({ value, boost: HINT_BOOST })) } }] } } : {}),
    },
    content: pcm.toString('base64'),
  };
}

// 앞뒤 무음 자르기: 휴대폰 녹음은 말 앞뒤로 몇 초씩 조용한데, 한 글자 대사는 긴 무음 속에 있으면 인식기가 흘려 버림
// 60ms 이상 이어진 소리 중 가장 큰 것의 10%를 넘는 구간만 남기고 앞뒤로 0.25초 여유를 둠
// (화면을 누르는 '딸깍' 같은 짧은 소리는 말로 보지 않음). 뚜렷한 말소리가 없으면 null
const TRIM_FRAME_SECONDS = 0.02;
const TRIM_SUSTAIN_FRAMES = 3;
const TRIM_MARGIN_SECONDS = 0.25;
const TRIM_PEAK_RATIO = 0.1;
const TRIM_MIN_RMS = 0.001;   // 이보다 작으면 말소리로 보지 않음 (약 -60dB. 작게 말해도 자르도록 낮게)
function speechBounds(pcm, sampleRate) {
  const samples = pcm.length >> 1;
  const frame = Math.max(1, Math.round(sampleRate * TRIM_FRAME_SECONDS));
  const levels = [];
  for (let start = 0; start + frame <= samples; start += frame) {
    let sum = 0;
    for (let i = start; i < start + frame; i++) { const v = pcm.readInt16LE(i * 2) / 32768; sum += v * v; }
    levels.push(Math.sqrt(sum / frame));
  }
  // 프레임마다 '여기서부터 TRIM_SUSTAIN_FRAMES개 동안 가장 작은 소리' → 짧게 튄 소리는 작게 나옴
  const sustained = levels.slice(0, Math.max(0, levels.length - TRIM_SUSTAIN_FRAMES + 1))
    .map((_, i) => Math.min(...levels.slice(i, i + TRIM_SUSTAIN_FRAMES)));
  const peak = sustained.reduce((m, v) => Math.max(m, v), 0);
  if (peak < TRIM_MIN_RMS) return null;
  const threshold = Math.max(TRIM_MIN_RMS, peak * TRIM_PEAK_RATIO);
  const first = sustained.findIndex((v) => v >= threshold);
  const last = sustained.findLastIndex((v) => v >= threshold) + TRIM_SUSTAIN_FRAMES - 1;
  const margin = Math.round(sampleRate * TRIM_MARGIN_SECONDS);
  return { from: Math.max(0, first * frame - margin), to: Math.min(samples, (last + 1) * frame + margin) };
}

function trimSilence(pcm, sampleRate) {
  const bounds = speechBounds(pcm, sampleRate);
  if (!bounds || (bounds.from === 0 && bounds.to === pcm.length >> 1)) return pcm;
  return pcm.subarray(bounds.from * 2, bounds.to * 2);
}

// Chirp 3은 녹음이 길수록 오래 걸림 (35~40초짜리 긴 대사가 10초 제한에 걸려 실패했음) → 녹음 1초당 0.5초씩 더 기다림
const STT_TIMEOUT_PER_SECOND_MS = 500;
const sttTimeoutMs = (seconds) => Math.round(UPSTREAM_TIMEOUT_MS + seconds * STT_TIMEOUT_PER_SECOND_MS);

// fetchImpl은 테스트에서 Google 대신 넣음
async function recognize(wav, info, hint = '', languageCode = 'ko-KR', { fetchImpl = fetch } = {}) {
  const { token, project } = await getAuth();
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  if (project) headers['x-goog-user-project'] = project;
  const raw = wav.subarray(info.dataOffset, info.dataOffset + info.dataBytes);
  const hasSpeech = !!speechBounds(raw, info.sampleRate);
  const body = JSON.stringify(sttRequest(trimSilence(raw, info.sampleRate), info.sampleRate, hint, languageCode));
  const url = sttUrl(project || await getProjectId());
  const once = async () => {
    const res = await fetchImpl(url, { method: 'POST', headers, signal: AbortSignal.timeout(sttTimeoutMs(info.seconds)), body });
    if (!res.ok) throw new Error(`speech ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const reply = await res.json();
    // 구간(segment)마다 후보 → 앱이 대사와 가장 가까운 후보를 고름. text는 1순위끼리 이은 것
    const segments = (reply.results || [])
      .map((r) => (r.alternatives || []).map((a) => (a.transcript || '').trim()).filter(Boolean))
      .filter((alts) => alts.length);
    return { text: segments.map((alts) => alts[0]).join(' ').trim(), segments };
  };
  // Chirp 3은 같은 녹음에도 가끔 빈 결과를 줌 (한 글자 대사에서 잦음) → 말소리가 있었으면 다시 물어봄
  // 다시 물을 때 실패하면 첫 빈 결과로 돌려줌 (오류로 바꾸지 않음). 너무 오래 걸렸으면 더 묻지 않음
  const started = Date.now();
  let result = await once();
  for (let retry = 0; !result.text && hasSpeech && retry < EMPTY_RETRIES && Date.now() - started < RETRY_WINDOW_MS; retry++) {
    try { result = await once(); } catch (err) { console.error('[stt] retry', err.message); break; }
  }
  return result;
}

// ---------- HTTP ----------
function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}
function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    if (Number(req.headers['content-length']) > limit) { req.resume(); return reject(Object.assign(new Error('too large'), { status: 413 })); }
    req.on('data', (c) => {
      size += c.length;
      if (size <= limit) { chunks.push(c); return; }
      // 끊지 않고 나머지를 흘려보내야 413 응답이 클라이언트에 도착함
      req.removeAllListeners('data');
      req.resume();
      reject(Object.assign(new Error('too large'), { status: 413 }));
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Cloud Run 앞단은 실제 접속 IP를 X-Forwarded-For 맨 뒤에 붙임. 앞쪽 값은 클라이언트가 마음대로 넣을 수 있음
function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  const parts = fwd ? String(fwd).split(',').map((s) => s.trim()).filter(Boolean) : [];
  const ip = parts.length ? parts[parts.length - 1] : req.socket.remoteAddress || '';
  // IPv6는 한 집·한 기기에 /64 전체가 주어지므로 앞 4칸으로 묶어 셈 (주소를 바꿔 가며 제한을 피하지 못하게)
  return ip.includes(':') && !ip.startsWith('::ffff:') ? ip.split(':').slice(0, 4).join(':') + '::/64' : ip;
}

const TOO_MANY = { error: '요청이 너무 많습니다. 잠시 뒤 다시 해 주세요.' };

function createSttHandler({ allow = createRateLimiter(RATE_LIMIT), allowGlobal = createRateLimiter(GLOBAL_LIMIT), transcribe = recognize } = {}) {
  let inFlight = 0;
  return async function handleStt(req, res) {
    if (!allow(clientIp(req)) || !allowGlobal('all')) { req.resume(); return sendJson(res, 429, TOO_MANY); }
    if (!String(req.headers['content-type'] || '').startsWith('audio/wav')) { req.resume(); return sendJson(res, 415, { error: 'audio/wav만 받습니다.' }); }
    let wav;
    try { wav = await readBody(req, MAX_AUDIO_BYTES); } catch (err) {
      return sendJson(res, err.status || 400, { error: err.status === 413 ? '녹음이 너무 큽니다.' : '녹음을 받지 못했습니다.' });
    }
    let info;
    try { info = parseWavHeader(wav); } catch { info = null; }  // 망가진 파일이 서버를 멈추지 않게
    const invalid = validateWav(info);
    if (invalid) return sendJson(res, 400, { error: invalid });
    if (inFlight >= MAX_IN_FLIGHT) return sendJson(res, 503, TOO_MANY);
    inFlight++;
    try {
      const startedAt = Date.now();
      const result = await transcribe(wav, info, lineHint(req), speechLanguage(req));
      // 휴대폰에서 채점이 느릴 때 어디서 걸리는지: 녹음 길이·서버 인식 시간·휴대폰 쪽 시간(녹음·변환)
      console.log(`[stt] audio=${info.seconds.toFixed(1)}s server=${Date.now() - startedAt}ms ${takeInfo(req)}`);
      return sendJson(res, 200, typeof result === 'string' ? { text: result } : result);
    } catch (err) {
      console.error('[stt]', err.message);  // 자세한 원인은 서버 로그에만 남김
      return sendJson(res, 502, { error: '음성 인식 서버에서 오류가 났습니다.' });
    } finally {
      inFlight--;
    }
  };
}

async function serveStatic(req, res) {
  let rel;
  try { rel = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { return send(res, 400, ''); }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.resolve(ROOT, '.' + rel);
  const ext = path.extname(file).toLowerCase();
  // 앱 폴더 밖, 허용하지 않은 파일 형식, 서버·테스트 코드는 보여 주지 않음
  // JSON은 안드로이드 앱 인증 파일(/.well-known/)만 (package.json 등은 숨김)
  if (!file.startsWith(ROOT + path.sep) || !MIME[ext] || /(^|[\\/])(server|.*\.test)\.js$/.test(file)) return send(res, 404, 'Not found');
  if (ext === '.json' && !rel.startsWith('/.well-known/')) return send(res, 404, 'Not found');
  let entry;
  try { entry = await loadStatic(file); } catch { return send(res, 404, 'Not found'); }
  const headers = { 'Content-Type': MIME[ext], 'Cache-Control': NO_CACHE.has(ext) ? 'no-cache' : ASSET_MAX_AGE, ETag: entry.etag };
  if (ext === '.apk') headers['Content-Disposition'] = `attachment; filename="${path.basename(file)}"`;
  if (COMPRESSIBLE.has(ext)) headers.Vary = 'Accept-Encoding';
  if (etagMatches(req.headers['if-none-match'], entry.etag)) return send(res, 304, undefined, headers);
  const encoding = COMPRESSIBLE.has(ext) ? pickEncoding(req.headers['accept-encoding']) : null;
  const body = encoding ? compressed(entry, encoding) : entry.body;
  if (encoding) headers['Content-Encoding'] = encoding;
  send(res, 200, req.method === 'HEAD' ? undefined : body, headers);
}

// 컨테이너 안의 파일은 바뀌지 않으니 한 번 읽고 압축한 결과를 메모리에 둠 (앱 전체가 수 MB라 부담 없음)
const staticCache = new Map();
async function loadStatic(file) {
  if (!staticCache.has(file)) {
    const body = await fs.readFile(file);
    const etag = '"' + crypto.createHash('sha1').update(body).digest('base64url') + '"';
    staticCache.set(file, { body, etag, br: null, gzip: null });
  }
  return staticCache.get(file);
}

// 프록시가 약한 ETag(W/"...")로 바꾸거나 여러 개를 보내도 알아봄
function etagMatches(header, etag) {
  return String(header || '').split(',').some((tag) => tag.trim().replace(/^W\//, '') === etag);
}

function pickEncoding(accept) {
  const list = String(accept || '').toLowerCase().split(',').map((s) => s.trim().split(';')[0]);
  if (list.includes('br')) return 'br';
  if (list.includes('gzip')) return 'gzip';
  return null;
}

function compressed(entry, encoding) {
  if (!entry[encoding]) {
    entry[encoding] = encoding === 'br'
      ? zlib.brotliCompressSync(entry.body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } })
      : zlib.gzipSync(entry.body, { level: 9 });
  }
  return entry[encoding];
}

function route({ handleStt, handleTts, handleAnalyze, handleInsight, handleSceneArt, handleLibrary, handleFeedback }, req, res) {
  let pathname;
  try { pathname = new URL(req.url, 'http://x').pathname; } catch { return send(res, 400, ''); }  // 예: 'GET //'
  if (pathname === '/api/stt' && req.method === 'POST') return handleStt(req, res);
  if (pathname === '/api/stt/health' && req.method === 'GET') return sendJson(res, 200, { ok: true });
  if (pathname === '/api/tts' && req.method === 'POST') return handleTts(req, res);
  if (pathname === '/api/analyze' && req.method === 'POST') return handleAnalyze(req, res);
  if (pathname === '/api/insight' && req.method === 'POST') return handleInsight(req, res);
  if (pathname === '/api/scene-art' && req.method === 'POST') return handleSceneArt(req, res);
  if (pathname === '/api/feedback' && req.method === 'POST') return handleFeedback(req, res);
  const library = /^\/api\/library(?:\/([^/]*))?$/.exec(pathname);
  if (library && req.method === 'GET') {
    let id = '';
    try { id = decodeURIComponent(library[1] || ''); } catch { id = '?'; }
    return handleLibrary(req, res, id);
  }
  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res);
  return send(res, 405, '');
}

function createServer(opts) {
  const handleStt = createSttHandler(opts);
  const handleTts = createTtsHandler({
    synthesize: (opts && opts.synthesize) || createGoogleSynthesizer({ getAuth, timeoutMs: UPSTREAM_TIMEOUT_MS }),
    dailyChars: opts && opts.ttsDailyChars,
    dailyCharsPerClient: opts && opts.ttsDailyCharsPerClient,
    readBody, sendJson, send, clientIp, createRateLimiter,
  });
  const claude = opts && 'claude' in opts ? opts.claude : createClaudeClient();
  // Langfuse 키가 있으면 Claude 호출을 용도별 이름(claude-analyze 등)으로 기록 (없으면 claude 그대로)
  const langfuse = opts && 'langfuse' in opts ? opts.langfuse : createLangfuseTracing();
  const traced = (name) => traceClaude(claude, name, langfuse);
  // 배역 분석·초목표 분석은 응답에 그 호출의 Langfuse traceId·observationId를 실어 보냄 (피드백 점수를 붙이는 데 씀, 꺼져 있으면 null)
  const withTrace = (fn) => fn && captureTraceId(fn);
  const handleAnalyze = createAnalyzeHandler({
    analyze: withTrace(opts && 'analyze' in opts ? opts.analyze : claude && ((args) => analyzeWithClaude(args, traced('analyze')))),
    toBody: ({ value, traceId, observationId }) => ({ characters: value, traceId, observationId }),
    daily: opts && opts.analyzeDaily,
    maxInFlight: opts && opts.analyzeMaxInFlight,
    readBody, sendJson, clientIp, createRateLimiter, createDailyBudget,
  });
  // 초목표·관계도 분석: 배역 분석과 같은 한도 규칙을 따로 적용 (서로의 한도를 깎지 않음)
  const handleLibrary = createLibraryHandler({ fetchSource: opts && opts.fetchSource, sendJson, clientIp, createRateLimiter });
  const handleInsight = createAnalyzeHandler({
    analyze: withTrace(opts && 'insight' in opts ? opts.insight : claude && ((args) => insightWithClaude(args, traced('insight')))),
    toBody: ({ value, traceId, observationId }) => ({ ...value, traceId, observationId }),
    readBody, sendJson, clientIp, createRateLimiter, createDailyBudget,
  });
  // 장면 그림 설명: 'AI 장면 이미지'를 켰을 때 대본마다 한 번 (한도는 따로)
  const handleSceneArt = createAnalyzeHandler({
    analyze: opts && 'sceneArt' in opts ? opts.sceneArt : claude && ((args) => sceneArtWithClaude(args, traced('scene-art'))),
    toBody: (scenes) => ({ scenes }),
    parse: parseSceneArtRequest,
    readBody, sendJson, clientIp, createRateLimiter, createDailyBudget,
  });
  // 사용자 피드백 → Langfuse 점수 (키가 없으면 204로 무시)
  const handleFeedback = createFeedbackHandler({
    scorer: opts && 'scorer' in opts ? opts.scorer : createLangfuseScorer(),
    readBody, sendJson, send, clientIp, createRateLimiter,
  });
  const server = http.createServer((req, res) => {
    // 요청 하나의 예상 못 한 오류가 프로세스 전체를 멈추지 않게 여기서 받음
    Promise.resolve()
      .then(() => route({ handleStt, handleTts, handleAnalyze, handleInsight, handleSceneArt, handleLibrary, handleFeedback }, req, res))
      .catch((err) => {
        console.error('[server]', err && err.stack ? err.stack : err);
        if (!res.headersSent) send(res, 500, '');
        else res.destroy();
      });
  });
  server.on('clientError', (_err, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); });
  return server;
}

if (require.main === module) {
  process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));
  const port = Number(process.env.PORT) || 8080;
  createServer().listen(port, () => console.log(`acting-practice on :${port} (static: ${ROOT})`));
}

module.exports = { parseWavHeader, validateWav, createRateLimiter, createServer, clientIp, lineHint, speechLanguage, sttRequest, trimSilence, recognize, sttTimeoutMs, takeInfo, MAX_AUDIO_SECONDS };
