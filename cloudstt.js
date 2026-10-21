// 휴대폰용 서버 음성 인식: 녹음 → 말이 끝나면 자동 정지 → 16kHz WAV로 바꿔 서버(/api/stt)에 보내 글자로 받음.
// 휴대폰 브라우저는 녹음과 음성 인식이 마이크를 같이 못 써서, 녹음 파일 하나로 채점과 다시 듣기를 모두 함
(function (root) {
  'use strict';

  const A = root.AudioKit;
  const R = root.Recorder;
  const TARGET_RATE = 16000;
  const POLL_MS = 50;

  // 서버가 있는 배포(Cloud Run)에서만 true. GitHub Pages 같은 정적 호스팅은 404라 false
  let availability = null;
  function checkAvailable() {
    if (!availability) {
      availability = fetch('api/stt/health', { cache: 'no-store' })
        .then((res) => res.ok && res.json())
        .then((body) => !!(body && body.ok))
        .catch(() => false);
    }
    return availability;
  }

  // onPhase('upload') 업로드 시작 알림
  // promise → { text, blob }   (말이 없었으면 text '', blob null)
  function listen({ onPhase } = {}) {
    let stopped = false;
    let timer = null;
    let ctx = null;
    let resolveFn;
    let rejectFn;
    const promise = new Promise((res, rej) => { resolveFn = res; rejectFn = rej; });

    const cleanup = () => { clearInterval(timer); if (ctx) ctx.close().catch(() => {}); ctx = null; };

    (async () => {
      await R.start();
      if (stopped) { R.discard(); return; }
      ctx = new (root.AudioContext || root.webkitAudioContext)();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      ctx.createMediaStreamSource(R.getStream()).connect(analyser);
      const frame = new Float32Array(analyser.fftSize);
      const detector = A.createSilenceDetector();
      const outcome = await new Promise((done) => {
        timer = setInterval(() => {
          if (stopped) return done('stopped');
          analyser.getFloatTimeDomainData(frame);
          const result = detector.update(A.rms(frame), Date.now());
          if (result) done(result);
        }, POLL_MS);
      });
      cleanup();
      if (outcome === 'stopped') return;
      if (outcome === 'no-speech') { R.discard(); return resolveFn({ text: '', blob: null }); }
      const blob = await R.stop();
      if (!blob || stopped) return resolveFn({ text: '', blob: null });
      if (onPhase) onPhase('upload');
      resolveFn({ text: await transcribe(blob), blob });
    })().catch((err) => { cleanup(); R.discard(); rejectFn(err); });

    return {
      promise,
      stop() { stopped = true; cleanup(); R.discard(); resolveFn({ text: '', blob: null }); },
    };
  }

  async function transcribe(blob) {
    const wav = A.encodeWav(await toMono16k(blob), TARGET_RATE);
    const res = await fetch('api/stt', { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wav });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(body.error || 'server ' + res.status), { server: true, status: res.status });
    return body.text || '';
  }

  // 녹음 파일(webm·mp4 등 브라우저마다 다름)을 풀어 16kHz 모노 파형으로 바꿈
  async function toMono16k(blob) {
    const Ctx = root.AudioContext || root.webkitAudioContext;
    const decodeCtx = new Ctx();
    try {
      const decoded = await decodeCtx.decodeAudioData(await blob.arrayBuffer());
      const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * TARGET_RATE), TARGET_RATE);
      const src = offline.createBufferSource();
      src.buffer = decoded;
      src.connect(offline.destination);
      src.start();
      return (await offline.startRendering()).getChannelData(0);
    } finally {
      decodeCtx.close().catch(() => {});
    }
  }

  root.CloudSTT = { checkAvailable, listen };
})(window);
