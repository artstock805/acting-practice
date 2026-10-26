// 실행: node --test
const test = require('node:test');
const assert = require('node:assert');
const K = require('./parser.js');
const { CATALOG, convertGutenberg, convertWikisource, splitSections } = require('./library.js');
const { createServer } = require('./server.js');

async function withServer(opts, fn) {
  const server = createServer(opts);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { server.close(); }
}

const GUTENBERG = [
  'The Project Gutenberg eBook of Hamlet',
  'license text that must not appear',
  '*** START OF THE PROJECT GUTENBERG EBOOK HAMLET ***',
  'Contents',
  'ACT I',
  'Scene I. Elsinore.',
  '',
  'ACT I',
  '',
  'SCENE I. Elsinore. A platform before the Castle.',
  '',
  'Enter Francisco and Barnardo, two sentinels.',
  '',
  'BARNARDO.',
  'Who’s there?',
  '',
  'FRANCISCO.',
  'Nay, answer me. Stand and unfold',
  'yourself.',
  '',
  'FIRST CLOWN.',
  '_[sings]_ In youth when I did love.',
  '',
  '[_Exeunt._]',
  '',
  'ACT II',
  '',
  'SCENE I. A room in Polonius’s house.',
  '',
  'BARNARDO.',
  'Long live the King!',
  '',
  '*** END OF THE PROJECT GUTENBERG EBOOK HAMLET ***',
  'more license text',
].join('\n');

test('Gutenberg plays drop the licence wrapper and become screenplay-style cues', () => {
  const text = convertGutenberg(GUTENBERG);
  assert.doesNotMatch(text, /license|Project Gutenberg|Contents/);
  const items = K.parseScript(text);
  const lines = items.filter((i) => i.type === 'line').map((i) => [i.character, i.text, i.note]);
  assert.deepStrictEqual(lines, [
    ['BARNARDO', 'Who’s there?', ''],
    ['FRANCISCO', 'Nay, answer me. Stand and unfold yourself.', ''],
    ['FIRST CLOWN', 'In youth when I did love.', 'sings'],
    ['BARNARDO', 'Long live the King!', ''],
  ]);
  assert.ok(items.some((i) => i.type === 'direction' && i.text === 'Exeunt.'));
  assert.ok(items.some((i) => i.type === 'scene' && /SCENE I\. Elsinore/.test(i.text)));
});

test('Gutenberg plays are split into acts', () => {
  const sections = splitSections(convertGutenberg(GUTENBERG), 'en');
  assert.deepStrictEqual(sections.map((s) => s.title), ['ACT I', 'ACT II']);
  assert.match(sections[1].text, /Long live the King/);
});

test('Wikisource ;name / :line plays become "이름: 대사"', () => {
  const raw = '{{머리말\n|제목 = 시험\n}}\n== 등장인물 ==\n* 순옥 / 16세\n== 1장 ==\n;최씨\n:거기는 배 타는 데는 없대요.<ref>주석</ref>\n;순옥\n:에그, [[형님]]! 지리도 못 배우셨나봐!\n:둥그렇지 넓적한가요.\n== 라이선스 ==\n{{PD-old-50}}\n[[분류:희곡]]';
  const text = convertWikisource(raw);
  assert.doesNotMatch(text, /PD-old|분류|ref|라이선스|\[\[/);
  const lines = K.parseScript(text).filter((i) => i.type === 'line').map((i) => [i.character, i.text]);
  assert.deepStrictEqual(lines, [['최씨', '거기는 배 타는 데는 없대요.'], ['순옥', '에그, 형님! 지리도 못 배우셨나봐!'], ['순옥', '둥그렇지 넓적한가요.']]);
});

test("Wikisource '''name''' lines become dialogue only for names that speak more than once", () => {
  const raw = "'''인물'''\n\n'''김정수(金正秀)''' 순후고풍, 60여 세.\n\n'''정수''' (웃으며) 아따 가만 두어.\n\n'''가애''' 나 눈깔사탕 사.\n\n'''정수''' 아따 사탕도 좋지.\n\n'''가애''' 응.";
  const lines = K.parseScript(convertWikisource(raw)).filter((i) => i.type === 'line').map((i) => [i.character, i.text, i.note]);
  assert.deepStrictEqual(lines, [['정수', '아따 가만 두어.', '웃으며'], ['가애', '나 눈깔사탕 사.', ''], ['정수', '아따 사탕도 좋지.', ''], ['가애', '응.', '']]);
});

test('the catalog only lists public-domain works with a source the server knows', () => {
  assert.ok(CATALOG.length >= 8);
  CATALOG.forEach((w) => {
    assert.ok(['gutenberg', 'wikisource'].includes(w.source), w.id);
    assert.ok(w.rights && w.title && w.author && w.lang, w.id);
  });
  assert.strictEqual(new Set(CATALOG.map((w) => w.id)).size, CATALOG.length);
});

test('GET /api/library lists works and GET /api/library/:id converts and caches one', async () => {
  let fetches = 0;
  const fetchSource = async (url) => { fetches++; assert.match(url, /^https:\/\/www\.gutenberg\.org\/cache\/epub\/1524\//); return GUTENBERG; };
  await withServer({ fetchSource }, async (base) => {
    const list = await (await fetch(`${base}/api/library`)).json();
    assert.ok(list.works.find((w) => w.id === 'hamlet'));
    assert.strictEqual(list.works[0].url, undefined);  // 원본 주소는 서버만 앎
    const first = await fetch(`${base}/api/library/hamlet`);
    assert.strictEqual(first.status, 200);
    const body = await first.json();
    assert.strictEqual(body.title, 'Hamlet');
    assert.deepStrictEqual(body.sections.map((s) => s.title), ['ACT I', 'ACT II']);
    await fetch(`${base}/api/library/hamlet`);
    assert.strictEqual((await fetch(`${base}/api/library/nope`)).status, 404);
    assert.strictEqual((await fetch(`${base}/api/library/..%2F..%2Fetc`)).status, 404);
  });
  assert.strictEqual(fetches, 1);
});

test('a failing source gives a friendly 502', async () => {
  const fetchSource = async () => { throw new Error('upstream secret'); };
  await withServer({ fetchSource }, async (base) => {
    const res = await fetch(`${base}/api/library/hamlet`);
    assert.strictEqual(res.status, 502);
    assert.doesNotMatch(await res.text(), /secret/);
  });
});
