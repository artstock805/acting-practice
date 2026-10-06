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
