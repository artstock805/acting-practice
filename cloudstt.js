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
  const PAUSED_GIVE_UP_MS = 1500;   // 녹음 중 멈춘 오디오가 이만큼 안 켜지면 정해진 시간 녹음으로 바꿈
  const NO_SIGNAL_RETRY_MS = 1000;  // 실시간 소리 크기가 이만큼 내내 0이면 녹음 조각을 풀어 잼
  const DECODE_EVERY_MS = 300;      // 녹음 조각을 푸는 간격 (마지막 이만큼의 소리 크기를 봄)
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
  // minMs: 이보다 일찍 조용해지면 숨 고르기로 보고 끝내지 않음 (긴 대사가 중간에 끊기지 않게)
  // quickAfterMs: 보통 속도로 다 말했을 시간. 이 뒤로는 짧게만 조용해도 바로 채점
  // blindMs: 소리 크기를 끝내 못 잴 때 녹음을 끝낼 시간 (대사 길이로 정함)
  function listen({ onPhase, hint = '', silenceMs, maxMs, minMs, quickAfterMs, quickSilenceMs, blindMs, lang = 'ko-KR' } = {}) {
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
    // recorded: 녹음이 끝나면 바로 녹음 파일로 풀림 (말이 없었거나 멈췄으면 null). 서버 채점(promise)은 그 뒤 따로
    // → 대화하듯 이어 하기: 채점을 기다리지 않고 다음 대사로 넘어감
    let recordedFn;
    const recorded = new Promise((res) => { recordedFn = res; });

    const cleanup = () => { clearInterval(timer); clearTimeout(timer); if (source) source.disconnect(); source = null; };

    (async () => {
      await R.start();
      const startedAt = Date.now();
      if (stopped) { R.discard(); return; }
      const running = await ensureRunning(ctx);
      if (stopped) { R.discard(); return; }
      let outcome = running ? await detectSpeechEnd() : await timedTake();
      // 녹음 중에 휴대폰이 오디오를 멈춰 다시 켜지지 않으면, 정해진 시간 녹음(✔ 다 말했어요)으로 이어 감
      if (outcome === 'paused' && !stopped) { clearInterval(timer); outcome = await timedTake(); }
      diag.takeMs = Date.now() - startedAt;   // 녹음 길이 (말을 마친 뒤 기다린 시간 포함) — 서버 로그로 어디서 느린지 봄
      cleanup();
      if (stopped) return;
      // 소리 크기를 못 재는 경우(no-signal)는 말이 없었다고 단정하지 않고 서버에 맡김
      if (outcome === 'no-speech') { R.discard(); recordedFn(null); return resolveFn(EMPTY); }
      const blob = await R.stop();
      if (!blob || stopped) { recordedFn(null); return resolveFn(EMPTY); }
      recordedFn(blob);
      if (onPhase) onPhase('upload');
      resolveFn({ ...(await transcribe(blob, upload.signal, diag, hint, lang)), blob });
    })().catch((err) => {
      recordedFn(null);
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
      // 일부 안드로이드 크롬은 스피커까지 이어지지 않은 오디오는 처리하지 않아 소리 크기가 0으로 읽힘 → 소리 0으로 이어 둠
      const mute = ctx.createGain();
      mute.gain.value = 0;
      analyser.connect(mute);
      mute.connect(ctx.destination);
      const frame = new Float32Array(analyser.fftSize);
      const detector = A.createSilenceDetector({ ...(silenceMs ? { silenceMs } : {}), ...(maxMs ? { maxMs } : {}), ...(minMs ? { minMs } : {}),
        ...(quickAfterMs ? { quickAfterMs } : {}), ...(quickSilenceMs ? { quickSilenceMs } : {}), ...(blindMs ? { blindMs } : {}) });
      const startedAt = Date.now();
      let pausedSince = null;
      let fromRecording = false;   // 실시간 소리 크기가 0이라 녹음 조각을 풀어 재는 중
      let decoding = false;
      let lastDecodeAt = 0;
      const outcome = await new Promise((done) => {
        finishLoop = done;
        timer = setInterval(() => {
          if (fromRecording) return measureFromRecording(detector, done);
          // 휴대폰이 녹음 중에 오디오를 멈추면(suspended) 소리 크기가 0으로 읽혀 '말이 끝남'으로 잘못 판단했음
          // → 멈춘 동안은 재지 않고 다시 켜 봄. PAUSED_GIVE_UP_MS 동안 안 켜지면 'paused'
          if (ctx.state !== 'running') {
            if (pausedSince === null) { pausedSince = Date.now(); ctx.resume().catch(() => {}); }
            if (Date.now() - pausedSince >= PAUSED_GIVE_UP_MS) done('paused');
            return;
          }
          pausedSince = null;
          // 실측: 일부 안드로이드는 오디오를 새로 만들어도 실시간 소리 크기가 내내 0 (말해도 8초 꽉 채워 녹음)
          // → 1초 동안 0이면 녹음된 조각을 풀어 소리 크기를 잼. 그동안 '✔ 다 말했어요'도 보여 줘 바로 넘어갈 수 있게
          if (Date.now() - startedAt >= NO_SIGNAL_RETRY_MS && detector.peak < A.NO_SIGNAL_PEAK && R.snapshot) {
            fromRecording = true;
            diag.fromRecording = true;
            if (onPhase) onPhase('blind');
            return;
          }
          analyser.getFloatTimeDomainData(frame);
          const result = detector.update(A.rms(frame), Date.now());
          if (result) done(result);
        }, POLL_MS);
      });
      Object.assign(diag, { ctx: ctx.state, rate: ctx.sampleRate, peak: detector.peak, threshold: detector.threshold, outcome });
      return outcome;

      // 지금까지의 녹음을 풀어 마지막 조각의 소리 크기로 무음 감지를 이어 감 (풀기에 실패하면 blindMs에서 끝남)
      function measureFromRecording(det, done) {
        const now = Date.now();
        const blob = decoding || now - lastDecodeAt < DECODE_EVERY_MS ? null : R.snapshot();
        if (!blob) {
          const timeOnly = det.update(0, now);   // 풀 조각이 없을 때도 시간은 흘려 blindMs·maxMs를 지킴 (0은 '조용함'으로만 셈)
          if (timeOnly) done(timeOnly);
          return;
        }
        decoding = true;
        lastDecodeAt = now;
        blob.arrayBuffer().then((buf) => ctx.decodeAudioData(buf)).then((audio) => {
          const samples = audio.getChannelData(0);
          const tail = samples.subarray(Math.max(0, samples.length - Math.round(audio.sampleRate * DECODE_EVERY_MS / 1000)));
          const result = det.update(A.rms(tail), Date.now());
          if (result) done(result);
        }).catch(() => { /* 조각을 못 풀면 blindMs에서 끝남 */ }).finally(() => { decoding = false; });
      }
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
      recorded,
      diag,
      finish() { if (finishLoop) finishLoop('finished'); },
      stop() {
        stopped = true;
        if (finishLoop) finishLoop('stopped');
        upload.abort();
        cleanup();
        R.discard();
        recordedFn(null);
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
    const prepStart = Date.now();
    const samples = await toMono16k(blob);
    if (samples.length < TARGET_RATE / 10) return { text: '', segments: [] };  // 0.1초도 안 되면 말이 없던 것
    const wav = A.encodeWav(samples, TARGET_RATE);
    diag.uploadKB = Math.round(wav.byteLength / 1024);
    const headers = { 'Content-Type': 'audio/wav', 'X-Speech-Lang': lang };
    // 단계별 시간(녹음 길이·끝 판단 방식·파일 변환 시간)을 서버 로그에 남김: 휴대폰에서 어디서 느린지 확인용
    if (diag.outcome) {
      const track = R.getStream() && R.getStream().getAudioTracks()[0];
      const mic = track ? (track.muted ? 'muted' : track.readyState) : 'none';
      headers['X-Take-Info'] = `outcome=${diag.outcome};ctx=${diag.ctx};take=${diag.takeMs};prep=${Date.now() - prepStart};fromrec=${diag.fromRecording ? 1 : 0};mic=${mic};rate=${diag.rate || ''};peak=${(diag.peak || 0).toFixed(4)}`;
    }
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

  // 이미 있는 녹음(PC 녹음 등)을 서버에서 글자로 바꿈 → { text, segments }
  function transcribeRecording(blob, { hint = '', lang = 'ko-KR' } = {}) {
    unlock();   // 풀 때 쓰는 오디오를 하나만 만들어 계속 씀 (매번 새로 만들면 브라우저 한도에 걸림)
    return transcribe(blob, undefined, {}, hint, lang);
  }

  root.CloudSTT = { checkAvailable, unlock, listen, transcribeRecording };
})(window);
