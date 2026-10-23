// 음성 합성(TTS)과 음성 인식(STT) 래퍼 — 브라우저 내장 Web Speech API 사용
(function (root) {
  'use strict';

  const LANG = 'ko-KR';
  const SILENCE_MS = 1400;      // 말이 끝났다고 보는 침묵 길이
  const NO_SPEECH_MS = 15000;   // 아무 말도 없을 때 대기 한도
  const ALTERNATIVES = 5;       // 인식 후보 수 (대사와 가장 가까운 것을 고름)
  const MAX_RESTARTS = 3;       // 말 중간에 인식이 끊겼을 때 이어 듣는 최대 횟수

  // 지문 감정 → 낭독 보정
  const EMOTION_TUNE = { anger: { pitch: 1.1, rate: 1.15, volume: 1 }, sad: { pitch: 0.9, rate: 0.85, volume: 0.9 },
    joy: { pitch: 1.15, rate: 1.05, volume: 1 }, whisper: { pitch: 1, rate: 0.85, volume: 0.45 }, fear: { pitch: 1.1, rate: 1.1, volume: 0.8 } };

  const synth = root.speechSynthesis;
  const Recognition = root.SpeechRecognition || root.webkitSpeechRecognition;

  function getKoreanVoices() {
    if (!synth) return [];
    const all = synth.getVoices();
    const ko = all.filter((v) => v.lang && v.lang.toLowerCase().startsWith('ko'));
    return ko.length ? ko : all;
  }

  // Edge의 온라인 음성처럼 늦게 추가되는 음성도 반영되도록 바뀔 때마다 호출
  function onVoicesReady(cb) {
    if (!synth) return cb([]);
    const voices = getKoreanVoices();
    if (voices.length) cb(voices);
    synth.addEventListener('voiceschanged', () => cb(getKoreanVoices()));
  }

  // cfg: { voiceURI, pitch, rateScale(인물 속도), rate(전체 속도), emotionKey }
  function speak(text, cfg) {
    return new Promise((resolve) => {
      if (!synth || !text) return resolve();
      synth.cancel();
      const e = EMOTION_TUNE[cfg.emotionKey] || { pitch: 1, rate: 1, volume: 1 };
      const u = new SpeechSynthesisUtterance(text);
      u.lang = LANG;
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
    if (!synth || unlocked) return;
    unlocked = true;
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    synth.speak(u);
  }

  function stopSpeaking() { if (synth) synth.cancel(); }

  // onInterim(text) 실시간 표시용, shouldStopEarly(text) 충분히 맞으면 바로 종료
  // silenceMs: 말이 끝났다고 볼 침묵 길이 (대사가 길거나 '...'이 있으면 더 길게 넘겨 받음)
  // pickAlternative(지금까지 말한 내용, 후보들) → 인식 후보 중 대사와 가장 가까운 것을 고름
  function listen({ onInterim, shouldStopEarly, silenceMs = SILENCE_MS, pickAlternative } = {}) {
    if (!Recognition) return { promise: Promise.reject(new Error('unsupported')), stop() {} };
    const rec = new Recognition();
    rec.lang = LANG;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = ALTERNATIVES;
    let finalText = '';
    let interim = '';
    let silenceTimer = null;
    let settled = false;
    let lastHeardAt = 0;
    let restarts = 0;
    let carried = '';   // 다시 시작하기 직전에 확정으로 옮긴 말 (새 세션이 같은 말을 다시 보내면 겹치지 않게 뺌)
    let resolveFn;
    let rejectFn;
    // 진단용: 인식 이벤트가 몇 초에 왔는지 기록 (휴대폰에서 '소리가 안 들림' 원인 찾기)
    const t0 = Date.now();
    const trace = [];
    const mark = (name) => trace.push(name + ' ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
    ['start', 'audiostart', 'soundstart', 'speechstart', 'speechend', 'soundend', 'audioend'].forEach((name) => {
      rec.addEventListener(name, () => mark(name));
    });

    // 일부 안드로이드 크롬은 다시 시작한 세션에서 직전 말을 처음부터 다시 보냄 → 그 앞부분을 빼고 새 말만 붙임
    const dropCarried = (text) => {
      const t = String(text || '').trim();
      if (!carried) return t;
      const squash = (s) => s.replace(/\s+/g, '');
      if (!squash(t).startsWith(squash(carried))) return t;
      let i = 0;
      let matched = 0;
      const target = squash(carried).length;
      while (i < t.length && matched < target) { if (!/\s/.test(t[i])) matched++; i++; }
      return t.slice(i).trim();
    };

    const finish = () => { if (!settled) { settled = true; clearTimeout(silenceTimer); clearTimeout(noSpeechTimer); try { rec.stop(); } catch (_) { /* 이미 종료됨 */ } resolveFn((finalText + ' ' + interim).trim()); } };
    const noSpeechTimer = setTimeout(finish, NO_SPEECH_MS);

    const promise = new Promise((res, rej) => { resolveFn = res; rejectFn = rej; });
    rec.onresult = (ev) => {
      if (!trace.some((t) => t.startsWith('result'))) mark('result');
      interim = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i];
        if (!r.isFinal) { interim += r[0].transcript; continue; }
        const alternatives = Array.from(r, (a) => dropCarried(a.transcript));
        finalText += ' ' + ((pickAlternative && pickAlternative(finalText.trim(), alternatives)) || alternatives[0]);
        carried = '';
      }
      lastHeardAt = Date.now();
      const current = (finalText + ' ' + interim).trim();
      if (onInterim) onInterim(current);
      clearTimeout(silenceTimer);
      if (shouldStopEarly && shouldStopEarly(current)) { finish(); return; }
      silenceTimer = setTimeout(finish, silenceMs);
    };
    rec.onerror = (ev) => {
      mark('error:' + ev.error);
      if (settled) return;
      if (ev.error === 'no-speech' || ev.error === 'aborted') { finish(); return; }
      settled = true;
      clearTimeout(silenceTimer); clearTimeout(noSpeechTimer);
      rejectFn(new Error(ev.error));
    };
    // 휴대폰 크롬은 말을 잠깐 쉬면 인식을 스스로 끝내 버림 → 아직 기다릴 시간이면 이어서 다시 듣기
    rec.onend = () => {
      mark('end');
      const heard = (finalText + interim).trim();
      if (!settled && heard && Date.now() - lastHeardAt < silenceMs && restarts < MAX_RESTARTS) {
        restarts++;
        if (interim) { finalText += ' ' + interim; carried = interim.trim(); interim = ''; }
        try { rec.start(); mark('restart'); return; } catch (_) { /* 다시 시작 못 하면 지금까지로 채점 */ }
      }
      finish();
    };
    try { rec.start(); } catch (err) { mark('start-fail:' + err.name); settled = true; clearTimeout(noSpeechTimer); rejectFn(err); }
    return { promise, trace, stop:() => { try { rec.abort(); } catch (_) { /* 이미 종료됨 */ } finish(); } };
  }

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  root.Speech = { onVoicesReady, getKoreanVoices, speak, stopSpeaking, unlock, listen, canListen: !!Recognition, canSpeak: !!synth };
})(window);
