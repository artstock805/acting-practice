// 서버 음성 인식용 오디오 도우미: 말이 끝났는지 판단(무음 감지) + 16bit 모노 WAV 만들기
(function (root) {
  'use strict';

  const DEFAULTS = {
    threshold: 0.006,    // 말소리로 보는 최소 RMS (0~1). 휴대폰은 잡음 제거 때문에 목소리가 작게 잡힘
    noiseFactor: 3,      // 처음에 잰 주변 소음의 몇 배를 넘어야 말소리로 볼지
    maxThreshold: 0.03,  // 처음부터 바로 말해도 기준이 목소리보다 높아지지 않게 하는 상한
    calibrateMs: 300,    // 시작 직후 주변 소음을 재는 시간
    silenceMs: 1400,     // 말한 뒤 이만큼 조용하면 끝 (speech.js의 SILENCE_MS와 같은 감각)
    noSpeechMs: 8000,    // 아무 말도 없으면 이만큼 기다리다 포기
    maxMs: 18000,        // 대사 길이를 모를 때 기본값 (긴 대사는 부르는 쪽이 takeMsForLine으로 늘림, 서버 한도 55초)
  };

  // 실제 마이크는 조용한 방에서도 이보다 큰 잡음이 잡힘. 내내 이보다 작으면 측정이 안 되는 상태(오디오 멈춤 등)
  const NO_SIGNAL_PEAK = 0.0001;

  // 일정 간격으로 update(소리 크기, 시각)를 부르면 'speech-end' | 'no-speech' | 'max' | 'no-signal' | null 을 돌려줌.
  // 'no-signal' = 소리 크기가 내내 거의 0 → 측정이 안 되는 것(오디오가 멈춤 등)이라 말이 없었다고 단정할 수 없음
  function createSilenceDetector(options) {
    const o = { ...DEFAULTS, ...options };
    let startedAt = null;
    let heardAt = null;   // 마지막으로 말소리가 들린 시각
    let spoke = false;
    let noiseSum = 0;
    let noiseCount = 0;
    let threshold = o.threshold;
    let peak = 0;
    return {
      update(level, now) {
        if (startedAt === null) startedAt = now;
        peak = Math.max(peak, level);
        const elapsed = now - startedAt;
        if (elapsed < o.calibrateMs) {
          noiseSum += level;
          noiseCount++;
          const cap = Math.max(o.threshold, o.maxThreshold);
          threshold = Math.min(cap, Math.max(o.threshold, (noiseSum / noiseCount) * o.noiseFactor));
        }
        if (level >= threshold) { spoke = true; heardAt = now; }
        const silentResult = peak < NO_SIGNAL_PEAK ? 'no-signal' : 'no-speech';
        if (elapsed >= o.maxMs) return spoke ? 'max' : silentResult;
        if (!spoke) return elapsed >= o.noSpeechMs ? silentResult : null;
        return now - heardAt >= o.silenceMs ? 'speech-end' : null;
      },
      get spoke() { return spoke; },
      get peak() { return peak; },
      get threshold() { return threshold; },
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
