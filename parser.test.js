// 실행: node --test
const test = require('node:test');
const assert = require('node:assert');
const K = require('./parser.js');

test('parses inline "이름: 대사" format with notes and scene headings', () => {
  const items = K.parseScript('S#1. 카페 / 밤\n(문이 열린다)\n민수: 늦었네.\n지연(화가 나서): 미안하다고 했잖아!\n민수: (한숨) 됐어.');
  assert.deepStrictEqual(items.map((i) => i.type), ['scene', 'direction', 'line', 'line', 'line']);
  assert.strictEqual(items[3].character, '지연');
  assert.strictEqual(items[3].note, '화가 나서');
  assert.strictEqual(items[4].text, '됐어.');
  assert.strictEqual(items[4].note, '한숨');
  assert.strictEqual(items[4].scene, 'S#1. 카페 / 밤');
});

test('parses screenplay format (name on its own line)', () => {
  const items = K.parseScript('민수\n(작게)\n거기 누구 있어요?\n\n지연\n저예요.');
  const lines = items.filter((i) => i.type === 'line');
  assert.strictEqual(lines.length, 2);
  assert.deepStrictEqual([lines[0].character, lines[0].note, lines[0].text], ['민수', '작게', '거기 누구 있어요?']);
  assert.strictEqual(lines[1].character, '지연');
});

test('long prose with a colon is not treated as a character', () => {
  const items = K.parseScript('그는 창밖을 오래 바라보다가 결국 이렇게 말한다: 끝났어.');
  assert.strictEqual(items[0].type, 'direction');
});

test('listCharacters counts and sorts; renameCharacter is immutable', () => {
  const items = K.parseScript('A: 1\nB: 2\nA: 3');
  assert.deepStrictEqual(K.listCharacters(items), [{ name: 'A', lines: 2 }, { name: 'B', lines: 1 }]);
  const merged = K.renameCharacter(items, 'B', 'A');
  assert.strictEqual(K.listCharacters(merged).length, 1);
  assert.strictEqual(items[1].character, 'B');
});

test('similarity ignores spacing/punctuation and scores partial matches', () => {
  assert.strictEqual(K.similarity('미안하다고 했잖아!', '미안하다고했잖아'), 1);
  assert.ok(K.similarity('미안하다고 했잖아', '미안하다 했잖아') > 0.8);
  assert.ok(K.similarity('미안하다고 했잖아', '오늘 날씨 좋다') < 0.3);
});

test('wordDiff and firstLetterHint', () => {
  assert.deepStrictEqual(K.wordDiff('나는 간다', '나는 안 가').map((w) => w.ok), [true, false]);
  assert.strictEqual(K.firstLetterHint('미안하다고 했잖아!'), '미… 했…');
});

test('mood and emotion detection avoid common false positives', () => {
  assert.strictEqual(K.detectMood('S#3. 병원 복도').key, 'hospital');
  assert.strictEqual(K.detectMood('비밀이야'), null);
  assert.strictEqual(K.detectEmotion('화가 나서').key, 'anger');
  assert.strictEqual(K.detectEmotion('대화를 나누며'), null);
});

// ---------- 인식률 개선: 발음 단위 비교·숫자 표기·후보 선택·말 끊김 기준 ----------
test('similarity gives partial credit for near-sounding syllables (compares 자모)', () => {
  assert.ok(K.similarity('...눈치는 빨라.', '눈치는 발라') >= 0.9);           // ㅃ↔ㅂ 한 자모 차이
  assert.ok(K.similarity('그 습관 때문에 떠나기 싫어지잖아.', '그 습관 때문에 떠나기 시러지잖아') >= 0.9);
  assert.strictEqual(K.similarity('우산이 없어서.', '우산이 없어서'), 1);
});

test('similarity still keeps unrelated sentences low', () => {
  assert.ok(K.similarity('우산이 없어서.', '오늘 날씨 좋네') < 0.45);
  assert.ok(K.similarity('됐어. 나 내일 떠나. 그 말 하려고 왔어.', '어디로 가는 건데 말해 봐') < 0.45);
  assert.ok(K.similarity('미안하다고 했잖아', '오늘 날씨 좋다') < 0.45);
});

test('similarity treats digits and their spoken Korean forms as the same', () => {
  assert.strictEqual(K.similarity('3년 만에 왔어.', '삼 년 만에 왔어'), 1);    // 한자어 수
  assert.strictEqual(K.similarity('3시에 보자.', '세 시에 보자'), 1);          // 고유어 수
  assert.strictEqual(K.similarity('세 시에 보자.', '3시에 보자'), 1);          // 반대 방향
  assert.strictEqual(K.similarity('2026년이야.', '이천이십육 년이야'), 1);
  assert.strictEqual(K.similarity('스무 살이야.', '20살이야'), 1);
});

test('wordDiff marks near-sounding and number-form words as correct', () => {
  assert.deepStrictEqual(K.wordDiff('눈치는 빨라.', '눈치는 발라').map((w) => w.ok), [true, true]);
  assert.deepStrictEqual(K.wordDiff('3시에 보자.', '세 시에 보자').map((w) => w.ok), [true, true]);
  assert.deepStrictEqual(K.wordDiff('나는 간다', '나는 안 가').map((w) => w.ok), [true, false]);
});

test('bestAlternative picks the recognizer candidate closest to the line', () => {
  const line = '우산, 내가 씌워 줄게. 역까지만.';
  assert.strictEqual(K.bestAlternative(line, '', ['우산 내가 쉬어 줄게', '우산 내가 씌워 줄게', '우산 네가 씌워 줘']), '우산 내가 씌워 줄게');
  assert.strictEqual(K.bestAlternative(line, '우산 내가 씌워 줄게', ['역까지 만', '여기까지만']), '역까지 만');
  assert.strictEqual(K.bestAlternative(line, '', []), '');
});

test('silenceForLine waits longer for long lines and lines with pauses', () => {
  const short = K.silenceForLine('응.');
  const long = K.silenceForLine('3년 만에 갑자기 나타나서 커피 한 잔 시켜 놓고 두 시간째야. 할 말 있으면 해.');
  const pause = K.silenceForLine('그건... 미안해.');
  assert.strictEqual(short, 1400);
  assert.ok(long > short && long <= 3200);
  assert.ok(pause > K.silenceForLine('그건 미안해.'));
});
