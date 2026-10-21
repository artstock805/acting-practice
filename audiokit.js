// 서버 음성 인식용 오디오 도우미: 말이 끝났는지 판단(무음 감지) + 16bit 모노 WAV 만들기
(function (root) {
  'use strict';

  const DEFAULTS = {
    threshold: 0.02,     // 이 RMS보다 크면 말소리로 봄 (0~1)
    silenceMs: 1400,     // 말한 뒤 이만큼 조용하면 끝 (speech.js의 SILENCE_MS와 같은 감각)
    noSpeechMs: 8000,    // 아무 말도 없으면 이만큼 기다리다 포기
    maxMs: 18000,        // 서버 한도(20초)보다 조금 짧게 끊음
  };

  // 일정 간격으로 update(소리 크기, 시각)를 부르면 'speech-end' | 'no-speech' | 'max' | null 을 돌려줌
  function createSilenceDetector(options) {
    const o = { ...DEFAULTS, ...options };
    let startedAt = null;
    let heardAt = null;   // 마지막으로 말소리가 들린 시각
    let spoke = false;
    return {
      update(level, now) {
        if (startedAt === null) startedAt = now;
        if (level >= o.threshold) { spoke = true; heardAt = now; }
        if (now - startedAt >= o.maxMs) return spoke ? 'max' : 'no-speech';
        if (!spoke) return now - startedAt >= o.noSpeechMs ? 'no-speech' : null;
        return now - heardAt >= o.silenceMs ? 'speech-end' : null;
      },
      get spoke() { return spoke; },
    };
  }

  // 파형(-1~1) 묶음의 소리 크기
  function rms(samples) {
    if (!samples.length) return 0;
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    return Math.sqrt(sum / samples.length);
  }

  // Float32 모노 파형 → PCM 16bit WAV (ArrayBuffer)
  function encodeWav(samples, sampleRate) {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);
    const ascii = (offset, text) => { for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i)); };
    ascii(0, 'RIFF');
    view.setUint32(4, 36 + samples.length * 2, true);
    ascii(8, 'WAVE');
    ascii(12, 'fmt ');
    view.setUint32(16, 16, true);            // fmt 크기
    view.setUint16(20, 1, true);             // PCM
    view.setUint16(22, 1, true);             // 모노
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true); // 초당 바이트
    view.setUint16(32, 2, true);             // 블록 크기
    view.setUint16(34, 16, true);            // 16bit
    ascii(36, 'data');
    view.setUint32(40, samples.length * 2, true);
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return buffer;
  }

  const api = { DEFAULTS, createSilenceDetector, rms, encodeWav };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AudioKit = api;
})(this);
