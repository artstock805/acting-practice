// Cloud Run용 서버: 정적 파일 서빙 + 휴대폰 녹음 음성 인식(/api/stt → Google Speech-to-Text).
// 의존성 없이 Node 내장 모듈만 사용. 로컬 실행: node server.js (PORT 기본 8080)
'use strict';
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');

const ROOT = path.resolve(process.env.STATIC_ROOT || __dirname);
const MAX_AUDIO_BYTES = 1024 * 1024;   // 16kHz 모노 16bit 기준 약 32초
const MAX_AUDIO_SECONDS = 20;
const RATE_LIMIT = { max: 30, windowMs: 60_000 };  // IP당 분당 요청 수
const GLOBAL_LIMIT = { max: 300, windowMs: 60_000 };  // 인스턴스 전체 분당 요청 수 (IP를 바꿔 가며 보내는 남용 대비)
const MAX_IN_FLIGHT = 10;          // 동시에 Google로 보내는 요청 수
const UPSTREAM_TIMEOUT_MS = 10_000;
const STT_URL = 'https://speech.googleapis.com/v1/speech:recognize';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8', '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml',
};
const NO_CACHE = new Set(['.html', '.js', '.css', '.webmanifest']);  // 코드 파일은 매번 새로 확인 (수정 사항 바로 반영)
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

async function recognize(wav, info) {
  const { token, project } = await getAuth();
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  if (project) headers['x-goog-user-project'] = project;
  const res = await fetch(STT_URL, {
    method: 'POST',
    headers,
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    body: JSON.stringify({
      config: { encoding: 'LINEAR16', sampleRateHertz: info.sampleRate, languageCode: 'ko-KR', maxAlternatives: 1 },
      audio: { content: wav.subarray(info.dataOffset, info.dataOffset + info.dataBytes).toString('base64') },
    }),
  });
  if (!res.ok) throw new Error(`speech ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = await res.json();
  return (body.results || []).map((r) => (r.alternatives && r.alternatives[0] ? r.alternatives[0].transcript : '')).join(' ').trim();
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
  return parts.length ? parts[parts.length - 1] : req.socket.remoteAddress || '';
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
      return sendJson(res, 200, { text: await transcribe(wav, info) });
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
  if (!file.startsWith(ROOT + path.sep) || !MIME[ext] || /(^|[\\/])(server|.*\.test)\.js$/.test(file)) return send(res, 404, 'Not found');
  try {
    const body = await fs.readFile(file);
    send(res, 200, req.method === 'HEAD' ? undefined : body, { 'Content-Type': MIME[ext], ...(NO_CACHE.has(ext) ? { 'Cache-Control': 'no-cache' } : {}) });
  } catch {
    send(res, 404, 'Not found');
  }
}

function route(handleStt, req, res) {
  let pathname;
  try { pathname = new URL(req.url, 'http://x').pathname; } catch { return send(res, 400, ''); }  // 예: 'GET //'
  if (pathname === '/api/stt' && req.method === 'POST') return handleStt(req, res);
  if (pathname === '/api/stt/health' && req.method === 'GET') return sendJson(res, 200, { ok: true });
  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res);
  return send(res, 405, '');
}

function createServer(opts) {
  const handleStt = createSttHandler(opts);
  const server = http.createServer((req, res) => {
    // 요청 하나의 예상 못 한 오류가 프로세스 전체를 멈추지 않게 여기서 받음
    Promise.resolve()
      .then(() => route(handleStt, req, res))
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

module.exports = { parseWavHeader, validateWav, createRateLimiter, createServer, clientIp, MAX_AUDIO_SECONDS };
