// 영어 대본 지원 테스트. 실행: node --test
const test = require('node:test');
const assert = require('node:assert');
const K = require('./parser.js');

const lines = (items) => items.filter((i) => i.type === 'line').map((i) => [i.character, i.text, i.note]);

test('detectLanguage tells Korean and English scripts apart', () => {
  assert.strictEqual(K.detectLanguage('민수: 늦었네.\n지연: 미안해.'), 'ko');
  assert.strictEqual(K.detectLanguage('MAYA: You are still here.\nDANIEL: Closing time is at ten.'), 'en');
  assert.strictEqual(K.detectLanguage('민수: OK, 알았어. 내일 Seoul station에서 봐.'), 'ko');
  assert.strictEqual(K.detectLanguage(''), 'ko');
});

test('parses "NAME: line" English scripts with parenthetical notes', () => {
  const items = K.parseScript('SCENE 1. A diner, late night\n(Rain against the window.)\nMAYA: You\'re still here.\nDANIEL (not looking up): Closing time isn\'t for ten minutes.');
  assert.deepStrictEqual(items.map((i) => i.type), ['scene', 'direction', 'line', 'line']);
  assert.deepStrictEqual(lines(items), [['MAYA', 'You\'re still here.', ''], ['DANIEL', 'Closing time isn\'t for ten minutes.', 'not looking up']]);
});

test('parses screenplay format: uppercase cues, extensions, wrapped dialogue and parentheticals', () => {
  const script = [
    'INT. COFFEE SHOP - NIGHT',
    '',
    'Rain beats against the glass. MAYA (30s) sits alone.',
    '',
    '                    MAYA',
    '          You kept the place exactly the',
    '          same.',
    '',
    '                    DANIEL (O.S.)',
    '               (from the kitchen)',
    '          Nobody asked me to change it.',
    '                 (beat)',
    '          Why are you here?',
    '',
    '                    MRS. HENDERSON (CONT\'D)',
    '          Coffee, please.',
    '',
    'CUT TO:',
    '',
    'EXT. STREET - CONTINUOUS',
  ].join('\n');
  const items = K.parseScript(script);
  assert.deepStrictEqual(items.map((i) => i.type), ['scene', 'direction', 'line', 'line', 'line', 'direction', 'scene']);
  assert.deepStrictEqual(lines(items), [
    ['MAYA', 'You kept the place exactly the same.', ''],
    ['DANIEL', 'Nobody asked me to change it. (beat) Why are you here?', 'from the kitchen'],
    ['MRS. HENDERSON', 'Coffee, please.', ''],
  ]);
});

test('parses play format "NAME. line" when names repeat', () => {
  const script = 'NORA. Torvald, I have something to say.\nHELMER. Not now, Nora.\nNORA. Yes, now.\nHELMER. Fine.\nNORA. I am leaving.\nThe door slams.';
  assert.deepStrictEqual(lines(K.parseScript(script)).map(([c]) => c), ['NORA', 'HELMER', 'NORA', 'HELMER', 'NORA']);
});

test('English sentences that start with common words are not taken as names', () => {
  const script = 'She walks in.\nShe sits down.\nShe looks around.\nThe door opens.\nThe light fades.\nThe end.';
  assert.strictEqual(K.parseScript(script).filter((i) => i.type === 'line').length, 0);
});

test('English scoring ignores case, punctuation and contractions', () => {
  assert.strictEqual(K.similarity('I am not going back there.', "i'm not going back there"), 1);
  assert.strictEqual(K.similarity("Don't you dare!", 'do not you dare'), 1);
  assert.ok(K.similarity('You kept the place exactly the same.', 'you kept the place exactly the same') > 0.99);
  assert.ok(K.similarity('You kept the place exactly the same.', 'you changed everything') < 0.6);
});

test('English scoring reads digits as words', () => {
  assert.strictEqual(K.similarity('I waited 20 years.', 'I waited twenty years'), 1);
  assert.strictEqual(K.similarity('It is 3 o\'clock.', 'it is three oclock'), 1);
  assert.strictEqual(K.similarity('Room 101.', 'room one hundred one'), 1);
});

test('English word diff marks the words that were missed', () => {
  const diff = K.wordDiff('Why are you here?', 'why are you');
  assert.deepStrictEqual(diff.map((d) => d.ok), [true, true, true, false]);
});

test('silence wait grows more slowly for English letters than Korean syllables', () => {
  const en = K.silenceForLine('I have been waiting here for a very long time tonight.');
  const ko = K.silenceForLine('나는 오늘 밤 여기서 아주 오랫동안 기다리고 있었어.');
  assert.ok(en < ko, `${en} < ${ko}`);
  assert.ok(en >= 1400);
});

test('first-letter hints work word by word in English', () => {
  assert.strictEqual(K.firstLetterHint("I'm not going back."), 'I… n… g… b…');
});

test('English stage directions set mood and emotion', () => {
  assert.strictEqual(K.detectMood('EXT. STREET - NIGHT').key, 'night');
  assert.strictEqual(K.detectMood('INT. HOSPITAL ROOM - DAY').key, 'hospital');
  assert.strictEqual(K.detectEmotion('angrily').key, 'anger');
  assert.strictEqual(K.detectEmotion('Whispering').key, 'whisper');
  assert.strictEqual(K.detectEmotion('in tears').key, 'sad');
});
