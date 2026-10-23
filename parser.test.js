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

test('very short lines need the exact sound (no partial credit for 1~2 syllables)', () => {
  assert.strictEqual(K.similarity('응.', '음'), 0);
  assert.strictEqual(K.similarity('네.', '내'), 0);
  assert.strictEqual(K.similarity('응.', '응'), 1);
  assert.ok(K.similarity('안녕.', '아니') < 0.5);
});

test('absurdly long digit runs do not hang or crash', () => {
  const huge = '1'.repeat(400);
  assert.strictEqual(K.similarity(huge, huge), 1);
  assert.ok(K.similarity('9'.repeat(12) + '원', '구천억 원') >= 0);
});

// ---------- '이름 대사' (쌍점 없이 띄어쓰기로 구분하는 희곡 형식) ----------
test('play format "이름 대사" (no colon) is recognized from names that repeat at line starts', () => {
  const script = [
    '#1. 하숙집 / 아침',
    '수철이 방에서 나온다.',
    '수철 오늘도 늦었네.',
    '미영 (웃으며) 매일 늦잖아.',
    '수철 그래도 오늘은 진짜 중요한 날이야.',
    '미영 무슨 날인데?',
    '음악이 흐른다.',
    '수철 말 못 해.',
    '미영이 고개를 젓는다.',
    '미영 또 그 소리.',
  ].join('\n');
  const items = K.parseScript(script);
  const lines = items.filter((i) => i.type === 'line');
  assert.deepStrictEqual(lines.map((l) => l.character), ['수철', '미영', '수철', '미영', '수철', '미영']);
  assert.strictEqual(lines[1].note, '웃으며');
  assert.strictEqual(lines[1].text, '매일 늦잖아.');
  // '수철이 …', '미영이 …', '음악이 …' 는 지문
  assert.deepStrictEqual(items.filter((i) => i.type === 'direction').map((d) => d.text), ['수철이 방에서 나온다.', '음악이 흐른다.', '미영이 고개를 젓는다.']);
});

test('the play format does not hijack normal colon scripts', () => {
  const items = K.parseScript('민수: 늦었네.\n민수가 들어온다.\n지연: 왜?\n민수: 그냥.\n민수는 웃는다.');
  assert.deepStrictEqual(items.map((i) => i.type), ['line', 'direction', 'line', 'line', 'direction']);
});

test('findSpokenNames is shared so file import can keep speaker lines apart', () => {
  const names = K.findSpokenNames(['상범 안녕.', '상범 네.', '상범 그래.', '상범이 나간다.', '용자 응.']);
  assert.deepStrictEqual([...names], ['상범']);
});

test('word fragments and stage words left at line starts by PDF wrapping are not names', () => {
  const lines = ['상범 안녕.', '상범 네.', '상범 그래.', '용자 응.', '용자 왜?', '용자 몰라.',
    '는 동안 둘이 걷는다.', '는 동안 불이 꺼진다.', '는 동안 음악.', '이 휴지로 말입니다.', '이 돈을 봐.', '이 사람아.',
    '과거 무대에 불이 들어온다.', '과거 무대, 불 꺼진다.', '과거 무대 불 꺼지고.'];
  assert.deepStrictEqual([...K.findSpokenNames(lines)].sort(), ['상범', '용자']);
});

test('in a "이름 대사" play the cast list is not read as screenplay dialogue', () => {
  const script = ['등장인물', '김상범 전세환', '김상학 김주옥', '', '상범 안녕.', '용자 응.', '상범 네.', '용자 왜?', '상범 그래.', '용자 몰라.'].join('\n');
  const chars = K.listCharacters(K.parseScript(script)).map((c) => c.name);
  assert.deepStrictEqual(chars.sort(), ['상범', '용자']);
});

// ---------- 리뷰: 희곡식 인식이 다른 형식을 망치지 않아야 함 ----------
test('screenplay with repeated sentence openers keeps its standalone names', () => {
  const block = '민수\n아니 그게 무슨 소리야\n영희\n우리 이제 그만하자\n';
  const items = K.parseScript(block.repeat(4));
  assert.deepStrictEqual(K.listCharacters(items).map((c) => c.name).sort(), ['민수', '영희']);
  assert.strictEqual(items.filter((i) => i.type === 'line').length, 8);
});

test('colon scripts with repeated openers do not gain fake speakers', () => {
  const script = ['민수: 가자.', '우리 가자 말했잖아', '지연: 싫어.', '그래 알았어 하고 나간다', '민수: 왜?', '우리 이제 끝이야 생각한다',
    '지연: 몰라.', '그래 그럼 그렇게 해', '민수: 그래.', '우리 둘 다 웃는다', '지연: 응.', '그래 하고 퇴장'].join('\n');
  assert.deepStrictEqual(K.listCharacters(K.parseScript(script)).map((c) => c.name).sort(), ['민수', '지연']);
});

test('"[이름] 대사" format is dialogue; [BGM]-style stage tags are not names', () => {
  const items = K.parseScript('[BGM] 서울의 찬가\n[상범] 오늘도 늦었네.\n[용자] (웃으며) 안녕하세요?\n[Effect] 새소리\n[상범]\n');
  const lines = items.filter((i) => i.type === 'line');
  assert.deepStrictEqual(lines.map((l) => [l.character, l.text, l.note]), [['상범', '오늘도 늦었네.', ''], ['용자', '안녕하세요?', '웃으며']]);
  // 대사 없는 '[상범]'은 기존처럼 괄호를 벗긴 지문
  assert.deepStrictEqual(items.filter((i) => i.type === 'direction').map((d) => d.text), ['[BGM] 서울의 찬가', '[Effect] 새소리', '상범']);
});

test('in a "[이름] 대사" script the title and headings are not screenplay names', () => {
  const script = ['국물 있사옵니다', '이근삼', '등장인물', '김상범', '', '무대', '어떤 아파트의 방.', '',
    '[상범] 오늘도 늦었네.', '[용자] 안녕하세요?', '[상범] 네.', '[용자] 가요.'].join('\n');
  assert.deepStrictEqual(K.listCharacters(K.parseScript(script)).map((c) => c.name).sort(), ['상범', '용자']);
});
