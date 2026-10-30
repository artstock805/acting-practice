// 음성 합성(TTS)과 음성 인식(STT) 래퍼 — 브라우저 내장 Web Speech API 사용
(function (root) {
  'use strict';

  let lang = 'ko-KR';           // 대본 언어 (setLanguage로 바꿈)
  const SILENCE_MS = 1400;      // 말이 끝났다고 보는 침묵 길이
  const NO_SPEECH_MS = 15000;   // 아무 말도 없을 때 대기 한도
  const ALTERNATIVES = 5;       // 인식 후보 수 (대사와 가장 가까운 것을 고름)
  const MAX_RESTARTS = 12;      // 말 중간에 인식이 끊겼을 때 이어 듣는 최대 횟수 (갤럭시 크롬은 긴 대사에서 자주 스스로 끝냄)
  const RECHECK_MS = 400;       // 계속 들을지 다시 물어보는 간격
  const MIN_OVERLAP = 4;        // 이미 들은 말 끝과 이만큼(띄어쓰기 뺀 글자) 이상 겹치면 다시 보낸 말로 봄

  // 지문 감정 → 낭독 보정
  const EMOTION_TUNE = { anger: { pitch: 1.1, rate: 1.15, volume: 1 }, sad: { pitch: 0.9, rate: 0.85, volume: 0.9 },
    joy: { pitch: 1.15, rate: 1.05, volume: 1 }, whisper: { pitch: 1, rate: 0.85, volume: 0.45 }, fear: { pitch: 1.1, rate: 1.1, volume: 0.8 } };

  const synth = root.speechSynthesis;
  const CLOUD_MIN_RATE = 0.7;   // voicecatalog.js의 허용 범위와 같게
  const CLOUD_MAX_RATE = 1.4;
  const Recognition = root.SpeechRecognition || root.webkitSpeechRecognition;

  // 이 기기의 음성 중 대본 언어에 맞는 것 (없으면 전부)
  function getKoreanVoices() {
    if (!synth) return [];
    const all = synth.getVoices();
    const prefix = lang.slice(0, 2).toLowerCase();
    const matching = all.filter((v) => v.lang && v.lang.toLowerCase().startsWith(prefix));
    return matching.length ? matching : all;
  }

  function setLanguage(next) { lang = next === 'en-US' ? 'en-US' : 'ko-KR'; }

  // Edge의 온라인 음성처럼 늦게 추가되는 음성도 반영되도록 바뀔 때마다 호출
  function onVoicesReady(cb) {
    if (!synth) return cb([]);
    const voices = getKoreanVoices();
    if (voices.length) cb(voices);
    synth.addEventListener('voiceschanged', () => cb(getKoreanVoices()));
  }

  // cfg: { cloudVoice(Google 목소리), voiceURI, pitch, rateScale(인물 속도), rate(전체 속도), emotionKey }
  // Google 목소리가 정해져 있으면 서버 합성으로 읽고, 실패하면 이 기기의 기본 음성으로 대신 읽음
  let onCloudError = () => {};
  const usesCloud = (cfg, text) => !!(cfg.cloudVoice && root.CloudTTS && root.CloudTTS.available && text);
  function cloudOptions(cfg) {
    const e = EMOTION_TUNE[cfg.emotionKey] || { rate: 1 };
    const rate = Math.round(clamp((cfg.rateScale || 1) * e.rate * (cfg.rate || 1), CLOUD_MIN_RATE, CLOUD_MAX_RATE) * 100) / 100;
    return { voice: cfg.cloudVoice, rate };
  }

  // 곧 읽을 대사를 미리 받아 둠 (Google 목소리일 때만 의미 있음)
  function prefetch(text, cfg) {
    if (usesCloud(cfg, text)) root.CloudTTS.prefetch(text, cloudOptions(cfg));
  }

  function speak(text, cfg) {
    if (usesCloud(cfg, text)) {
      if (synth) synth.cancel();
      return root.CloudTTS.speak(text, cloudOptions(cfg)).catch((err) => {
        onCloudError(err);
        return deviceSpeak(text, cfg);
      });
    }
    return deviceSpeak(text, cfg);
  }

  function deviceSpeak(text, cfg) {
    return new Promise((resolve) => {
      if (!synth || !text) return resolve();
      synth.cancel();
      const e = EMOTION_TUNE[cfg.emotionKey] || { pitch: 1, rate: 1, volume: 1 };
      const u = new SpeechSynthesisUtterance(text);
      u.lang = lang;
      const voice = getKoreanVoices().find((v) => v.voiceURI === cfg.voiceURI);
      if (voice) u.voice = voice;
      u.pitch = clamp((cfg.pitch || 1) * e.pitch, 0, 2);
      u.rate = clamp((cfg.rateScale || 1) * e.rate * (cfg.rate || 1), 0.1, 3);
      u.volume = e.volume;
      u.onend = () => resolve();
      u.onerror = () => resolve();
      synth.speak(u);
    });
  }

  let unlocked = false;
  function unlock() {
    if (root.CloudTTS) root.CloudTTS.unlock();
    if (!synth || unlocked) return;
    unlocked = true;
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    synth.speak(u);
  }

  function stopSpeaking() {
    if (root.CloudTTS) root.CloudTTS.stop();
    if (synth) synth.cancel();
  }

  // onInterim(text) 실시간 표시용, shouldStopEarly(text) 충분히 맞으면 바로 종료
  // silenceMs: 말이 끝났다고 볼 침묵 길이 (대사가 길거나 '...'이 있으면 더 길게 넘겨 받음)
  // pickAlternative(지금까지 말한 내용, 후보들) → 인식 후보 중 대사와 가장 가까운 것을 고름
  // lang: 이 대사를 알아들을 언어 ('ko-KR' | 'en-US', 없으면 대본 언어)
  // shouldKeepListening(지금까지 말한 내용, 조용했던 ms, 시작 뒤 ms) → true면 쉬어도 끝내지 않음 (대사를 아직 다 안 했을 때)
  // maxMs: 이 대사를 들을 최대 시간 · noSpeechMs: 아무 말도 안 들릴 때 기다릴 한도 (말이 들리기 시작하면 더는 안 씀)
  // 돌려주는 endReason: 왜 듣기를 끝냈는지 ('pause' 쉼 · 'matched' 대사와 맞음 · 'max' 최대 시간 · 'phone-ended' 휴대폰이 인식을 끝냄
  //   · 'no-speech' 말소리 없음 · 'aborted' · 'stopped' 사용자가 멈춤)
  function listen({ onInterim, shouldStopEarly, silenceMs = SILENCE_MS, pickAlternative, lang: lineLang, shouldKeepListening, maxMs, noSpeechMs = NO_SPEECH_MS } = {}) {
    if (!Recognition) return { promise: Promise.reject(new Error('unsupported')), stop() {} };
    const rec = new Recognition();
    rec.lang = lineLang === 'en-US' || lineLang === 'ko-KR' ? lineLang : lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = ALTERNATIVES;
    let finalText = '';
    let interim = '';
    let silenceTimer = null;
    let settled = false;
    let lastHeardAt = 0;
    let restarts = 0;
    let resolveFn;
    let rejectFn;
    // 진단용: 인식 이벤트가 몇 초에 왔는지 기록 (휴대폰에서 '소리가 안 들림' 원인 찾기)
    const t0 = Date.now();
    const trace = [];
    const mark = (name) => trace.push(name + ' ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
    ['start', 'audiostart', 'soundstart', 'speechstart', 'speechend', 'soundend', 'audioend'].forEach((name) => {
      rec.addEventListener(name, () => mark(name));
    });

    // 갤럭시 크롬은 확정 결과에도 앞서 확정한 말을 다시 붙여 보냄 → 안 빼면 같은 말이 두 번 들어가 점수가 크게 깎였음
    const dropRepeated = (text) => newPart(finalText, text);

    let endReason = '';
    const finish = (reason) => {
      if (settled) return;
      settled = true;
      endReason = reason;
      mark('finish:' + reason);
      clearTimeout(silenceTimer); clearTimeout(noSpeechTimer); clearTimeout(maxTimer);
      try { rec.stop(); } catch (_) { /* 이미 종료됨 */ }
      resolveFn((finalText + ' ' + interim).trim());
    };
    // 아무 말도 없을 때만 쓰는 한도: 말이 들리기 시작하면 지움 (예전엔 안 지워서 15초 넘는 대사가 말하는 중에 끊겼음)
    const noSpeechTimer = setTimeout(() => finish('no-speech'), noSpeechMs);
    const maxTimer = maxMs ? setTimeout(() => finish('max'), maxMs) : null;
    const heardSoFar = () => (finalText + ' ' + interim).trim();
    // 조용해졌을 때: 대사를 아직 다 안 했으면(앱이 판단) 더 기다리고, 다 했거나 너무 오래 조용하면 끝
    const keepGoing = () => !!shouldKeepListening && shouldKeepListening(heardSoFar(), Date.now() - lastHeardAt, Date.now() - t0);
    const onQuiet = () => { if (keepGoing()) silenceTimer = setTimeout(onQuiet, RECHECK_MS); else finish('pause'); };

    const promise = new Promise((res, rej) => { resolveFn = res; rejectFn = rej; });
    rec.onresult = (ev) => {
      if (!trace.some((t) => t.startsWith('result'))) mark('result');
      interim = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i];
        if (!r.isFinal) { interim += r[0].transcript; continue; }
        const alternatives = Array.from(r, (a) => dropRepeated(a.transcript));
        finalText += ' ' + ((pickAlternative && pickAlternative(finalText.trim(), alternatives)) || alternatives[0]);
      }
      interim = dropRepeated(interim);
      lastHeardAt = Date.now();
      clearTimeout(noSpeechTimer);
      const current = (finalText + ' ' + interim).trim();
      if (onInterim) onInterim(current);
      clearTimeout(silenceTimer);
      if (shouldStopEarly && shouldStopEarly(current)) { finish('matched'); return; }
      // 앱이 판단할 수 있으면 짧게 쉬어도 물어봄 (대사를 다 했으면 긴 쉼을 다 기다리지 않고 바로 채점)
      silenceTimer = setTimeout(onQuiet, shouldKeepListening ? Math.min(silenceMs, RECHECK_MS) : silenceMs);
    };
    rec.onerror = (ev) => {
      mark('error:' + ev.error);
      if (settled) return;
      // 대사 중간에 쉬는 동안 갤럭시 크롬이 'no-speech'를 보내도, 아직 대사 중이면 끝내지 않음 (곧 오는 onend에서 다시 듣기)
      if (ev.error === 'no-speech' && heardSoFar() && keepGoing()) return;
      if (ev.error === 'no-speech' || ev.error === 'aborted') { finish(ev.error); return; }
      settled = true;
      clearTimeout(silenceTimer); clearTimeout(noSpeechTimer);
      rejectFn(new Error(ev.error));
    };
    // 휴대폰 크롬은 말을 잠깐 쉬면 인식을 스스로 끝내 버림 → 아직 기다릴 시간이면 이어서 다시 듣기
    rec.onend = () => {
      mark('end');
      const heard = (finalText + interim).trim();
      const stillTalking = Date.now() - lastHeardAt < silenceMs || keepGoing();
      if (!settled && heard && stillTalking && restarts < MAX_RESTARTS) {
        restarts++;
        if (interim) { finalText += ' ' + interim; interim = ''; }
        try { rec.start(); mark('restart'); return; } catch (_) { /* 다시 시작 못 하면 지금까지로 채점 */ }
      }
      finish(heard ? 'phone-ended' : 'no-speech');
    };
    try { rec.start(); } catch (err) { mark('start-fail:' + err.name); settled = true; clearTimeout(noSpeechTimer); clearTimeout(maxTimer); rejectFn(err); }
    return {
      promise,
      trace,
      get endReason() { return endReason; },
      stop: () => { try { rec.abort(); } catch (_) { /* 이미 종료됨 */ } finish('stopped'); },
    };
  }

  // 일부 안드로이드 크롬은 다시 시작한 세션에서도 직전 말을 처음부터 다시 보냄
  // → next에서 before 끝과 겹치는 앞부분을 뺀 새 말만 (띄어쓰기 무시, MIN_OVERLAP글자 이상 겹칠 때만)
  function newPart(before, next) {
    const t = String(next || '').trim();
    const squash = (x) => x.replace(/\s+/g, '');
    const a = squash(before);
    const b = squash(t);
    for (let k = Math.min(a.length, b.length); k >= MIN_OVERLAP; k--) {
      if (!a.endsWith(b.slice(0, k))) continue;
      let i = 0;
      for (let matched = 0; i < t.length && matched < k; i++) if (!/\s/.test(t[i])) matched++;
      return t.slice(i).trim();
    }
    return t;
  }

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  root.Speech = { onVoicesReady, getKoreanVoices, setLanguage, getLanguage: () => lang, speak, prefetch, stopSpeaking, unlock, listen, setCloudErrorHandler: (fn) => { onCloudError = fn; }, canListen: !!Recognition, canSpeak: !!synth };
})(window);
