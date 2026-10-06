// 인물별 목소리 배분 · 겹침 감지 (순수 함수, 브라우저/Node 공용)
(function (root) {
  'use strict';

  // 목소리 성격 프리셋 (높낮이 pitch, 속도 배율 rateScale)
  const PRESETS = {
    male: { label: '남성', pitch: 0.8, rateScale: 0.98 },
    female: { label: '여성', pitch: 1.25, rateScale: 1.02 },
    child: { label: '아이', pitch: 1.6, rateScale: 1.08 },
    elder: { label: '노인', pitch: 0.7, rateScale: 0.85 },
    deep: { label: '굵고 느리게', pitch: 0.6, rateScale: 0.9 },
    bright: { label: '밝고 빠르게', pitch: 1.4, rateScale: 1.15 },
  };
  // 음성 하나를 여러 인물이 나눠 쓸 때 쓰는 높낮이 단계 (서로 충분히 떨어지게 배열)
  const PITCH_STEPS = [1.0, 0.72, 1.32, 0.86, 1.16, 0.6, 1.5, 0.94, 1.24];
  const CLASH_PITCH = 0.1;
  const CLASH_RATE = 0.1;

  const round2 = (v) => Math.round(v * 100) / 100;

  // 예전 저장 형식(persona + slot)도 pitch/rateScale로 풀어 줌
  function resolveVoice(cfg) {
    const preset = PRESETS[cfg.persona];
    const pitch = typeof cfg.pitch === 'number' ? cfg.pitch : preset ? preset.pitch : PITCH_STEPS[(cfg.slot || 0) % PITCH_STEPS.length];
    const rateScale = typeof cfg.rateScale === 'number' ? cfg.rateScale : preset ? preset.rateScale : 1;
    return { voiceURI: cfg.voiceURI || '', pitch, rateScale };
  }

  // 상대 배역들에게 음성을 돌려 가며 주고, 같은 음성을 쓰게 되면 높낮이를 다르게 함
  // names: 대사 많은 순, voiceURIs: 쓸 수 있는 음성 목록(없으면 [''])
  function distributeVoices(names, voiceURIs) {
    const voices = voiceURIs && voiceURIs.length ? voiceURIs : [''];
    const result = {};
    names.forEach((name, i) => {
      const round = Math.floor(i / voices.length);
      result[name] = { voiceURI: voices[i % voices.length], pitch: PITCH_STEPS[round % PITCH_STEPS.length], rateScale: 1, persona: 'auto' };
    });
    return result;
  }

  // 상대 배역끼리 목소리가 거의 같은 인물 이름 목록
  function findVoiceClashes(cast) {
    const others = Object.keys(cast).filter((n) => !cast[n].mine).map((n) => ({ name: n, v: resolveVoice(cast[n]) }));
    const clashing = new Set();
    others.forEach((a, i) => others.slice(i + 1).forEach((b) => {
      if (a.v.voiceURI === b.v.voiceURI && Math.abs(a.v.pitch - b.v.pitch) < CLASH_PITCH && Math.abs(a.v.rateScale - b.v.rateScale) < CLASH_RATE) {
        clashing.add(a.name);
        clashing.add(b.name);
      }
    }));
    return clashing;
  }

  // 지금 설정과 맞는 프리셋 키 (없으면 'custom')
  function matchPreset(cfg) {
    const v = resolveVoice(cfg);
    const hit = Object.keys(PRESETS).find((k) => round2(PRESETS[k].pitch) === round2(v.pitch) && round2(PRESETS[k].rateScale) === round2(v.rateScale));
    return hit || 'custom';
  }

  // "Microsoft SunHi Online (Natural) - Korean (Korean)" → "SunHi (자연스러운 음성)"
  function shortVoiceName(name) {
    const natural = /natural|online|neural/i.test(name);
    const core = String(name).replace(/^(Microsoft|Google)\s+/i, '').replace(/\s*-\s*Korean.*$/i, '').replace(/\s*Online.*$/i, '').replace(/\(Natural\)/i, '').trim();
    return core + (natural ? ' (자연스러운 음성)' : '');
  }

  const api = { PRESETS, PITCH_STEPS, resolveVoice, distributeVoices, findVoiceClashes, matchPreset, shortVoiceName };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.VoiceKit = api;
})(this);
