// 실행: node --test
const test = require('node:test');
const assert = require('node:assert');
const V = require('./voices.js');

test('distributeVoices rotates voices, then varies pitch when voices run out', () => {
  const r = V.distributeVoices(['A', 'B', 'C'], ['v1', 'v2']);
  assert.deepStrictEqual([r.A.voiceURI, r.B.voiceURI, r.C.voiceURI], ['v1', 'v2', 'v1']);
  assert.strictEqual(r.A.pitch, r.B.pitch);
  assert.notStrictEqual(r.A.pitch, r.C.pitch);
});

test('with a single voice every character gets a distinct pitch', () => {
  const r = V.distributeVoices(['A', 'B', 'C', 'D'], []);
  const pitches = Object.values(r).map((c) => c.pitch);
  assert.strictEqual(new Set(pitches).size, 4);
  assert.strictEqual(V.findVoiceClashes(r).size, 0);
});

test('findVoiceClashes flags near-identical partner voices but ignores my roles', () => {
  const cast = {
    A: { voiceURI: 'v', pitch: 1, rateScale: 1 },
    B: { voiceURI: 'v', pitch: 1.05, rateScale: 1 },
    C: { voiceURI: 'v', pitch: 1.5, rateScale: 1 },
    Me: { voiceURI: 'v', pitch: 1, rateScale: 1, mine: true },
  };
  assert.deepStrictEqual([...V.findVoiceClashes(cast)].sort(), ['A', 'B']);
});

test('resolveVoice supports the old persona/slot format', () => {
  assert.strictEqual(V.resolveVoice({ persona: 'male' }).pitch, 0.8);
  assert.strictEqual(V.resolveVoice({ persona: 'auto', slot: 1 }).pitch, V.PITCH_STEPS[1]);
  assert.strictEqual(V.matchPreset({ pitch: 0.8, rateScale: 0.98 }), 'male');
  assert.strictEqual(V.matchPreset({ pitch: 0.83, rateScale: 1 }), 'custom');
});

test('shortVoiceName trims vendor noise', () => {
  assert.strictEqual(V.shortVoiceName('Microsoft SunHi Online (Natural) - Korean (Korean)'), 'SunHi (자연스러운 음성)');
  assert.strictEqual(V.shortVoiceName('Microsoft Heami - Korean (Korean)'), 'Heami');
});
