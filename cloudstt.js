// 휴대폰용 서버 음성 인식: 녹음 → 말이 끝나면 자동 정지 → 16kHz WAV로 바꿔 서버(/api/stt)에 보내 글자로 받음.
// 휴대폰 브라우저는 녹음과 음성 인식이 마이크를 같이 못 써서, 녹음 파일 하나로 채점과 다시 듣기를 모두 함
(function (root) {
  'use strict';

  const A = root.AudioKit;
  const R = root.Recorder;
  const TARGET_RATE = 16000;
  const POLL_MS = 50;
  const RESUME_WAIT_MS = 500;
  const TIMED_TAKE_MS = 7000;   // 소리 크기를 못 잴 때 녹음할 시간 (그 뒤 서버가 말이 있었는지 판단)
  const MAX_HINT_CHARS = 300;   // 서버가 받는 힌트 길이 한도와 같게
  const Ctx = root.AudioContext || root.webkitAudioContext;

  // 서버가 있는 배포(Cloud Run)에서만 true. 로컬 실행기(serve.ps1)나 정적 호스팅은 404라 false
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

  // 휴대폰은 사용자가 누른 순간에만 오디오를 켜게 해 줌 → ▶ 시작 클릭 안에서 불러 하나를 켜 두고 계속 씀
  let sharedCtx = null;
  function unlock() {
    if (!Ctx) return;
    if (!sharedCtx || sharedCtx.state === 'closed') sharedCtx = new Ctx();
    sharedCtx.resume().catch(() => {});
  }

  // onPhase('upload') 업로드 시작 알림
  // hint: 말할 대사 (서버가 Google 인식에 힌트로 넘김) · silenceMs: 말이 끝났다고 볼 침묵 길이
  // promise → { text, segments, blob }   (말이 없었으면 text '', blob null). segments = 구간별 인식 후보들
  // diag: 실패 원인 표시용 { ctx, peak, threshold, outcome, uploadKB }
  // lang: 'ko-KR' | 'en-US' (대본 언어) · maxMs: 이 대사를 녹음할 최대 시간 (긴 대사가 중간에 끊기지 않게)
  // finish(): 소리 크기를 못 재 정해진 시간만큼 녹음할 때, 다 말했으면 기다리지 않고 바로 채점
  function listen({ onPhase, hint = '', silenceMs, maxMs, lang = 'ko-KR' } = {}) {
    let stopped = false;
    let timer = null;
    let source = null;
    let finishLoop = null;     // 무음 감지 루프를 끝내는 함수 (stop()에서도 부름)
    const upload = new AbortController();
    const EMPTY = { text: '', segments: [], blob: null };
    const diag = { ctx: '', peak: 0, threshold: 0, outcome: '', uploadKB: null };
    unlock();
    const ctx = sharedCtx;
    let resolveFn;
    let rejectFn;
    const promise = new Promise((res, rej) => { resolveFn = res; rejectFn = rej; });

    const cleanup = () => { clearInterval(timer); clearTimeout(timer); if (source) source.disconnect(); source = null; };

    (async () => {
      await R.start();
      if (stopped) { R.discard(); return; }
      const running = await ensureRunning(ctx);
      if (stopped) { R.discard(); return; }
      const outcome = running ? await detectSpeechEnd() : await timedTake();
      cleanup();
      if (stopped) return;
      // 소리 크기를 못 재는 경우(no-signal)는 말이 없었다고 단정하지 않고 서버에 맡김
      if (outcome === 'no-speech') { R.discard(); return resolveFn(EMPTY); }
      const blob = await R.stop();
      if (!blob || stopped) return resolveFn(EMPTY);
      if (onPhase) onPhase('upload');
      resolveFn({ ...(await transcribe(blob, upload.signal, diag, hint, lang)), blob });
    })().catch((err) => {
      cleanup();
      R.release();  // 실패하면 마이크를 놓아야 휴대폰 내장 인식 등 다음 시도가 소리를 받음
      if (stopped) return;
      rejectFn(err);
    });

    // 소리 크기를 재며 말이 끝날 때까지 기다림
    async function detectSpeechEnd() {
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      source = ctx.createMediaStreamSource(R.getStream());
      source.connect(analyser);
      const frame = new Float32Array(analyser.fftSize);
      const detector = A.createSilenceDetector({ ...(silenceMs ? { silenceMs } : {}), ...(maxMs ? { maxMs } : {}) });
      const outcome = await new Promise((done) => {
        finishLoop = done;
        timer = setInterval(() => {
          analyser.getFloatTimeDomainData(frame);
          const result = detector.update(A.rms(frame), Date.now());
          if (result) done(result);
        }, POLL_MS);
      });
      Object.assign(diag, { ctx: ctx.state, peak: detector.peak, threshold: detector.threshold, outcome });
      return outcome;
    }

    // 오디오가 끝내 켜지지 않으면(휴대폰 자동 재생 제한) 정해진 시간만 녹음
    async function timedTake() {
      const takeMs = Math.max(TIMED_TAKE_MS, maxMs || 0);
      if (onPhase) onPhase('timed', takeMs);
      const outcome = await new Promise((done) => {
        finishLoop = done;
        timer = setTimeout(() => done('timed'), takeMs);
      });
      Object.assign(diag, { ctx: ctx.state, outcome });
      return outcome;
    }

    return {
      promise,
      diag,
      finish() { if (finishLoop) finishLoop('finished'); },
      stop() {
        stopped = true;
        if (finishLoop) finishLoop('stopped');
        upload.abort();
        cleanup();
        R.discard();
        resolveFn(EMPTY);
      },
    };
  }

  // 멈춘 오디오를 다시 켜 보고, 잠깐 기다려도 안 켜지면 false
  async function ensureRunning(ctx) {
    if (ctx.state === 'running') return true;
    await Promise.race([ctx.resume().catch(() => {}), new Promise((r) => setTimeout(r, RESUME_WAIT_MS))]);
    return ctx.state === 'running';
  }

  async function transcribe(blob, signal, diag, hint, lang) {
    const samples = await toMono16k(blob);
    if (samples.length < TARGET_RATE / 10) return { text: '', segments: [] };  // 0.1초도 안 되면 말이 없던 것
    const wav = A.encodeWav(samples, TARGET_RATE);
    diag.uploadKB = Math.round(wav.byteLength / 1024);
    const headers = { 'Content-Type': 'audio/wav', 'X-Speech-Lang': lang };
    // 글자 단위로 자름: 문자열 slice는 이모지(서로게이트 쌍)를 반으로 잘라 encodeURIComponent가 실패할 수 있음
    if (hint) headers['X-Line-Hint'] = encodeURIComponent(Array.from(hint).slice(0, MAX_HINT_CHARS).join(''));
    const res = await fetch('api/stt', { method: 'POST', headers, body: wav, signal });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(body.error || 'server ' + res.status), { server: true, status: res.status });
    return { text: body.text || '', segments: Array.isArray(body.segments) ? body.segments : [] };
  }

  // 녹음 파일(webm·mp4 등 브라우저마다 다름)을 풀어 16kHz 모노 파형으로 바꿈
  async function toMono16k(blob) {
    const decoded = await (sharedCtx || new Ctx()).decodeAudioData(await blob.arrayBuffer());
    if (!decoded.duration) return new Float32Array(0);
    const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * TARGET_RATE), TARGET_RATE);
    const src = offline.createBufferSource();
    src.buffer = decoded;
    src.connect(offline.destination);
    src.start();
    return (await offline.startRendering()).getChannelData(0);
  }

  root.CloudSTT = { checkAvailable, unlock, listen };
})(window);
