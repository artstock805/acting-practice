// 실행: node --test
const test = require('node:test');
const assert = require('node:assert');
const A = require('./audiokit.js');
const { parseWavHeader } = require('./server.js');

test('silence detector ends after speech followed by silence', () => {
  const d = A.createSilenceDetector({ threshold: 0.1, silenceMs: 1000, noSpeechMs: 5000, maxMs: 10000 });
  assert.strictEqual(d.update(0, 0), null);
  assert.strictEqual(d.update(0.5, 200), null);    // 말 시작
  assert.strictEqual(d.update(0.01, 900), null);   // 잠깐 쉼
  assert.strictEqual(d.update(0.01, 1199), null);
  assert.strictEqual(d.update(0.01, 1200), 'speech-end');
});

test('silence detector gives up when nobody speaks', () => {
  const d = A.createSilenceDetector({ threshold: 0.1, noSpeechMs: 3000 });
  assert.strictEqual(d.update(0.05, 0), null);
  assert.strictEqual(d.update(0.05, 2999), null);
  assert.strictEqual(d.update(0.05, 3000), 'no-speech');
  assert.strictEqual(d.spoke, false);
});

test('silence detector cuts very long takes at maxMs', () => {
  const d = A.createSilenceDetector({ threshold: 0.1, silenceMs: 1000, maxMs: 4000 });
  for (let t = 0; t < 4000; t += 100) assert.strictEqual(d.update(0.5, t), null);
  assert.strictEqual(d.update(0.5, 4000), 'max');
});

test('rms measures loudness', () => {
  assert.strictEqual(A.rms(new Float32Array(0)), 0);
  assert.strictEqual(A.rms(Float32Array.from([0.5, -0.5, 0.5, -0.5])), 0.5);
});

test('encodeWav produces a 16bit mono PCM file the server accepts', () => {
  const samples = Float32Array.from({ length: 16000 }, (_, i) => Math.sin(i / 10));
  const info = parseWavHeader(Buffer.from(A.encodeWav(samples, 16000)));
  assert.deepStrictEqual([info.format, info.channels, info.bits, info.sampleRate], [1, 1, 16, 16000]);
  assert.strictEqual(info.dataBytes, 32000);
  assert.strictEqual(info.seconds, 1);
});

test('encodeWav clips out-of-range samples instead of wrapping', () => {
  const buf = Buffer.from(A.encodeWav(Float32Array.from([2, -2]), 8000));
  assert.strictEqual(buf.readInt16LE(44), 0x7fff);
  assert.strictEqual(buf.readInt16LE(46), -0x8000);
});
