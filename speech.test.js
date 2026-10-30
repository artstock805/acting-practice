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

test('once speech has started, the no-speech timeout no longer cuts the line off', async () => {
  const { Speech, made } = loadSpeech();
  let done = false;
  const listener = Speech.listen({ silenceMs: 500, noSpeechMs: 150, maxMs: 5000 });
  listener.promise.then(() => { done = true; });
  const rec = made[0];
  await wait(50);
  rec.say('말을 시작했고', false);
  for (let t = 0; t < 4; t++) { await wait(60); rec.say('말을 시작했고 계속 말하는 중', false); }   // 150ms를 훌쩍 넘겨 말함
  assert.strictEqual(done, false, '말하는 중인데 무음 대기 한도로 끝나면 안 됨');
  listener.stop();
  await listener.promise;
});

test('a no-speech error in a mid-line pause does not end listening', async () => {
  const { Speech, made } = loadSpeech();
  let done = false;
  const listener = Speech.listen({ silenceMs: 50, shouldKeepListening: (heard, idleMs) => idleMs < 1000, maxMs: 3000 });
  listener.promise.then(() => { done = true; });
  const rec = made[0];
  rec.say('앞부분', true);
  await wait(20);
  rec.onerror({ error: 'no-speech' });   // 갤럭시 크롬이 쉬는 동안 보냄
  rec.onend();
  await wait(20);
  assert.strictEqual(done, false);
  assert.strictEqual(rec.started, 2, '다시 들어야 함');
  listener.stop();
  await listener.promise;
  assert.strictEqual(listener.endReason, 'stopped');
});

test('the reason listening ended is reported', async () => {
  const { Speech, made } = loadSpeech();
  const a = Speech.listen({ silenceMs: 30, maxMs: 2000 });
  made[0].say('짧은 대사', true);
  await a.promise;
  assert.strictEqual(a.endReason, 'pause');
  const b = Speech.listen({ silenceMs: 50, shouldKeepListening: () => true, maxMs: 120 });
  made[1].say('긴 대사', false);
  await b.promise;
  assert.strictEqual(b.endReason, 'max');
});

test('text the phone sends again is not counted twice', async () => {
  const { Speech, made } = loadSpeech();
  const listener = Speech.listen({ silenceMs: 30, maxMs: 2000 });
  const rec = made[0];
  rec.say('오늘은 날씨가', true);
  rec.say('오늘은 날씨가 참 좋네요', true);   // 갤럭시 크롬: 확정 결과에 앞 말을 다시 붙여 보냄
  assert.strictEqual(await listener.promise, '오늘은 날씨가 참 좋네요');
});

test('after restarting, words already heard are not repeated', async () => {
  const { Speech, made } = loadSpeech();
  const listener = Speech.listen({ silenceMs: 50, shouldKeepListening: (heard, idleMs) => idleMs < 300, maxMs: 3000 });
  const rec = made[0];
  rec.say('첫 번째 문장입니다', true);
  rec.onend();                                // 다시 시작한 세션이
  rec.say('첫 번째 문장입니다 두 번째 문장', true);   // 직전 말을 처음부터 다시 보냄
  listener.stop();
  assert.strictEqual(await listener.promise, '첫 번째 문장입니다 두 번째 문장');
});

test('when the app says the line is done, listening ends without the full pause', async () => {
  const { Speech, made } = loadSpeech();
  const started = Date.now();
  const listener = Speech.listen({ silenceMs: 3000, shouldKeepListening: (heard, idleMs) => !heard.includes('끝') && idleMs < 3000, maxMs: 5000 });
  made[0].say('대사 끝', true);
  await listener.promise;
  assert.ok(Date.now() - started < 1500, '대사를 다 했으면 긴 쉼(3초)을 기다리지 않음');
});
