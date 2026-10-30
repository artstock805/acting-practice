// 실행: node --test
// speech.js는 브라우저용이라 가짜 window·가짜 음성 인식기를 넣어 '말 중간에 끝나지 않는지'만 확인
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function loadSpeech() {
  const made = [];
  class FakeRecognition {
    constructor() { this.started = 0; made.push(this); }
    start() { this.started++; }
    stop() {}
    abort() {}
    addEventListener() {}
    // 인식기가 결과를 보냄 (isFinal이면 확정)
    say(text, isFinal = false) {
      const result = Object.assign([{ transcript: text }], { isFinal });
      this.onresult({ resultIndex: 0, results: [result] });
    }
  }
  const win = { SpeechRecognition: FakeRecognition };
  new Function('window', fs.readFileSync(path.join(__dirname, 'speech.js'), 'utf8'))(win);
  return { Speech: win.Speech, made };
}

test('a pause in the middle of a long line does not end listening', async () => {
  const { Speech, made } = loadSpeech();
  let done = false;
  // 앱 판단 흉내: '끝'이라는 말이 나오기 전에는 아직 대사 중 → 1초 쉼까지 기다림
  const listener = Speech.listen({
    silenceMs: 80,
    shouldKeepListening: (heard, idleMs) => !heard.includes('끝') && idleMs < 1000,
    maxMs: 5000,
  });
  listener.promise.then(() => { done = true; });
  const rec = made[0];
  rec.say('앞부분 대사', true);
  await wait(250);                       // 보통 쉼(80ms)보다 훨씬 길게 쉼
  assert.strictEqual(done, false, '대사 중간에 쉬었다고 끝나면 안 됨');
  rec.say('뒷부분 끝', true);
  const heard = await listener.promise;
  assert.match(heard, /앞부분 대사/);
  assert.match(heard, /뒷부분 끝/);
});

test('when the phone ends recognition by itself mid-line, it starts listening again', async () => {
  const { Speech, made } = loadSpeech();
  const listener = Speech.listen({ silenceMs: 50, shouldKeepListening: (heard, idleMs) => idleMs < 1000, maxMs: 3000 });
  const rec = made[0];
  rec.say('첫 마디', true);
  await wait(20);
  rec.onend();                           // 갤럭시 크롬이 스스로 끝냄
  assert.strictEqual(rec.started, 2, '다시 듣기 시작해야 함');
  listener.stop();
  assert.match(await listener.promise, /첫 마디/);
});

test('listening always stops at the line\'s maximum time', async () => {
  const { Speech, made } = loadSpeech();
  const started = Date.now();
  const listener = Speech.listen({ silenceMs: 50, shouldKeepListening: () => true, maxMs: 300 });
  made[0].say('계속 말하는 중', false);
  const heard = await listener.promise;
  assert.ok(Date.now() - started < 1500);
  assert.match(heard, /계속 말하는 중/);
});
