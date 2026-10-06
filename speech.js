// 음성 합성(TTS)과 음성 인식(STT) 래퍼 — 브라우저 내장 Web Speech API 사용
(function (root) {
  'use strict';

  const LANG = 'ko-KR';
  const SILENCE_MS = 1400;      // 말이 끝났다고 보는 침묵 길이
  const NO_SPEECH_MS = 15000;   // 아무 말도 없을 때 대기 한도

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
  function listen({ onInterim, shouldStopEarly } = {}) {
    if (!Recognition) return { promise: Promise.reject(new Error('unsupported')), stop() {} };
    const rec = new Recognition();
    rec.lang = LANG;
    rec.continuous = true;
    rec.interimResults = true;
    let finalText = '';
    let interim = '';
    let silenceTimer = null;
    let settled = false;
    let resolveFn;
    let rejectFn;

    const finish = () => { if (!settled) { settled = true; clearTimeout(silenceTimer); clearTimeout(noSpeechTimer); try { rec.stop(); } catch (_) { /* 이미 종료됨 */ } resolveFn((finalText + ' ' + interim).trim()); } };
    const noSpeechTimer = setTimeout(finish, NO_SPEECH_MS);

    const promise = new Promise((res, rej) => { resolveFn = res; rejectFn = rej; });
    rec.onresult = (ev) => {
      interim = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i];
        if (r.isFinal) finalText += ' ' + r[0].transcript; else interim += r[0].transcript;
      }
      const current = (finalText + ' ' + interim).trim();
      if (onInterim) onInterim(current);
      clearTimeout(silenceTimer);
      if (shouldStopEarly && shouldStopEarly(current)) { finish(); return; }
      silenceTimer = setTimeout(finish, SILENCE_MS);
    };
    rec.onerror = (ev) => {
      if (settled) return;
      if (ev.error === 'no-speech' || ev.error === 'aborted') { finish(); return; }
      settled = true;
      clearTimeout(silenceTimer); clearTimeout(noSpeechTimer);
      rejectFn(new Error(ev.error));
    };
    rec.onend = () => finish();
    try { rec.start(); } catch (err) { settled = true; clearTimeout(noSpeechTimer); rejectFn(err); }
    return { promise, stop: () => { try { rec.abort(); } catch (_) { /* 이미 종료됨 */ } finish(); } };
  }

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  root.Speech = { onVoicesReady, getKoreanVoices, speak, stopSpeaking, unlock, listen, canListen: !!Recognition, canSpeak: !!synth };
})(window);
