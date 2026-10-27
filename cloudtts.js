// Google 목소리 재생: 서버(/api/tts)에서 받은 MP3를 오디오 요소 하나로 재생함.
// 같은 대사는 창을 닫기 전까지 다시 받지 않고, 다음 대사는 미리 받아 두어 끊김을 줄임.
// 휴대폰은 첫 소리를 사용자 터치 안에서 내야 이후 재생이 허용되므로 unlock()을 터치 때 불러 둠
(function (root) {
  'use strict';

  const CACHE_MAX = 200;
  const FETCH_TIMEOUT_MS = 15_000;     // 휴대폰 연결이 멈춰도 연습이 멈춰 있지 않게
  const MAX_PLAY_MS = 60_000;          // 끝 신호가 안 와도 다음으로 넘어가게 하는 안전장치
  const RETRY_AFTER_FAIL_MS = 30_000;  // 실패한 대사는 잠시 미리 받기를 쉼 (서버 제한에 계속 부딪히지 않게)
  const failedAt = new Map();
  const cache = new Map();   // 키 → Promise<blob URL> (가득 차면 오래된 것부터 버림)
  let player = null;
  let playToken = 0;
  let finishCurrent = null;

  const available = typeof root.fetch === 'function' && /^https?:$/.test(root.location ? root.location.protocol : '');

  function getPlayer() {
    if (!player) { player = new Audio(); player.preload = 'auto'; }
    return player;
  }

  // 아주 짧은 무음 WAV (재생 허용을 얻는 데만 씀)
  function silentUrl() {
    const bytes = new Uint8Array(46);
    const view = new DataView(bytes.buffer);
    const ascii = (at, s) => [...s].forEach((ch, i) => { bytes[at + i] = ch.charCodeAt(0); });
    ascii(0, 'RIFF'); view.setUint32(4, 38, true); ascii(8, 'WAVE'); ascii(12, 'fmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, 8000, true); view.setUint32(28, 16000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    ascii(36, 'data'); view.setUint32(40, 2, true);
    return URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
  }

  // 재생 중에는 손대지 않음 (무음으로 바꾸면 읽던 대사가 끊김). 브라우저가 거절했을 때만 다음 터치에 다시 시도
  let unlocked = false;
  function unlock() {
    if (!available || unlocked || finishCurrent) return;
    unlocked = true;
    const p = getPlayer();
    p.src = silentUrl();
    p.play().catch((err) => { if (err && err.name === 'NotAllowedError') unlocked = false; });
  }

  const keyOf = (text, voice, rate) => `${voice}|${rate}|${text}`;

  function fetchAudio(text, voice, rate) {
    const key = keyOf(text, voice, rate);
    if (cache.has(key)) {
      const hit = cache.get(key);
      cache.delete(key);
      cache.set(key, hit);
      return hit;
    }
    const pending = fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice, rate }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    }).then(async (res) => {
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw Object.assign(new Error(body.error || `음성 합성 실패 (${res.status})`), { status: res.status });
      }
      return URL.createObjectURL(await res.blob());
    });
    cache.set(key, pending);
    pending.catch(() => { cache.delete(key); failedAt.set(key, Date.now()); });  // 실패한 요청은 나중에 다시 시도
    if (cache.size > CACHE_MAX) {
      const [oldKey, oldUrl] = cache.entries().next().value;
      cache.delete(oldKey);
      oldUrl.then((url) => URL.revokeObjectURL(url), () => {});
    }
    return pending;
  }

  // 다음에 읽을 대사를 미리 받아 둠 (실패해도 조용히 넘어감)
  function prefetch(text, { voice, rate }) {
    if (!available || !text) return;
    const failed = failedAt.get(keyOf(text, voice, rate));
    if (failed && Date.now() - failed < RETRY_AFTER_FAIL_MS) return;
    fetchAudio(text, voice, rate).catch(() => {});
  }

  // 끝까지 재생하면 resolve, 받거나 재생하지 못하면 reject (부르는 쪽이 기본 음성으로 대신 읽음)
  async function speak(text, { voice, rate }) {
    stop();
    const token = ++playToken;
    let url;
    try { url = await fetchAudio(text, voice, rate); } catch (err) {
      if (token !== playToken) return;  // 받는 사이 멈췄으면 기본 음성으로 대신 읽지도 않음
      throw err;
    }
    if (token !== playToken) return;
    envelopeOf(url).then((env) => { if (token === playToken) currentEnvelope = env; });
    const p = getPlayer();
    let watchdog = null;
    try {
      await new Promise((resolve, reject) => {
        finishCurrent = resolve;
        watchdog = setTimeout(resolve, MAX_PLAY_MS);
        p.onended = () => resolve();
        p.onerror = () => reject(new Error('재생 실패'));
        p.src = url;
        p.play().catch(reject);
      });
    } finally {
      clearTimeout(watchdog);
      if (token === playToken) finishCurrent = null;
    }
  }

  function stop() {
    playToken++;
    currentEnvelope = null;
    if (player) { player.onended = null; player.onerror = null; player.pause(); }
    if (finishCurrent) { finishCurrent(); finishCurrent = null; }
  }

  // ---------- 목소리 크기 (아바타 입 모양·움직임용) ----------
  // 재생 소리를 건드리지 않게(휴대폰에서 소리가 끊기지 않게) 같은 파일을 따로 풀어 50ms마다 크기를 미리 계산해 둠
  const LEVEL_STEP_S = 0.05;
  const ENVELOPE_MAX = 40;
  const envelopes = new Map();   // blob URL → Promise<Float32Array | null>
  let currentEnvelope = null;

  function envelopeOf(url) {
    if (!envelopes.has(url)) {
      const Offline = root.OfflineAudioContext || root.webkitOfflineAudioContext;
      const pending = !Offline ? Promise.resolve(null) : fetch(url).then((r) => r.arrayBuffer())
        .then((buf) => new Offline(1, 1, 44100).decodeAudioData(buf))
        .then((audio) => {
          const data = audio.getChannelData(0);
          const step = Math.max(1, Math.round(audio.sampleRate * LEVEL_STEP_S));
          const levels = new Float32Array(Math.ceil(data.length / step));
          levels.forEach((_, i) => {
            let sum = 0;
            const end = Math.min(data.length, (i + 1) * step);
            for (let j = i * step; j < end; j++) sum += data[j] * data[j];
            levels[i] = Math.sqrt(sum / Math.max(1, end - i * step));
          });
          const loudest = Math.max(1e-6, ...levels);
          return levels.map((v) => Math.sqrt(v / loudest));   // 0~1, 작은 소리도 보이게 살짝 키움
        })
        .catch(() => null);
      envelopes.set(url, pending);
      if (envelopes.size > ENVELOPE_MAX) envelopes.delete(envelopes.keys().next().value);
    }
    return envelopes.get(url);
  }

  // 지금 재생 중인 목소리 크기 0~1. 재생 중이 아니거나 아직 모르면 null
  function level() {
    if (!player || player.paused || !currentEnvelope) return null;
    const v = currentEnvelope[Math.floor(player.currentTime / LEVEL_STEP_S)];
    return v === undefined ? 0 : v;
  }

  root.CloudTTS = { available, speak, prefetch, stop, unlock, level };
})(this);
