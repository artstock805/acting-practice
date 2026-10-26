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

test('a pasted Gutenberg or 위키문헌 address becomes a library id', () => {
  const { parseSourceAddress } = require('./libraryview.js').LibraryView;
  assert.strictEqual(parseSourceAddress('https://www.gutenberg.org/ebooks/1524'), 'gb-1524');
  assert.strictEqual(parseSourceAddress(' gutenberg.org/cache/epub/4093/pg4093.txt '), 'gb-4093');
  assert.strictEqual(parseSourceAddress('https://www.gutenberg.org/files/2542/2542-h/2542-h.htm'), 'gb-2542');
  assert.strictEqual(parseSourceAddress('1524'), 'gb-1524');
  assert.strictEqual(parseSourceAddress('https://ko.wikisource.org/wiki/%EA%B7%9C%ED%95%9C'), 'ws-규한');
  assert.strictEqual(parseSourceAddress('https://ko.m.wikisource.org/wiki/박용철_산문집/인형의_집#1'), 'ws-박용철 산문집/인형의 집');
  assert.strictEqual(parseSourceAddress('https://example.com/ebooks/1524'), null);
  assert.strictEqual(parseSourceAddress(''), null);
});

test('GET /api/library/gb-:n and ws-:title import a work the user picked', async () => {
  const urls = [];
  const fetchSource = async (url) => {
    urls.push(url);
    if (url.includes('gutenberg')) return 'Title: Hamlet, Prince of Denmark\nAuthor: William Shakespeare\n' + GUTENBERG.replace('*** END', 'FRANCISCO.\nGo.\n\nFRANCISCO.\nNo.\n\nBARNARDO.\nYes.\n\n*** END');
    return ';최씨\n:거기는 배 타는 데는 없대요.\n;순옥\n:에그, 형님!\n;최씨\n:그래요?\n;순옥\n:네.\n;최씨\n:가요.\n;순옥\n:그래요.';
  };
  await withServer({ fetchSource }, async (base) => {
    const gb = await (await fetch(`${base}/api/library/gb-1524`)).json();
    assert.strictEqual(gb.title, 'Hamlet, Prince of Denmark');
    assert.strictEqual(gb.author, 'William Shakespeare');
    assert.strictEqual(gb.lang, 'en');
    assert.strictEqual(gb.custom, true);
    assert.deepStrictEqual(gb.sections.map((s) => s.title), ['ACT I', 'ACT II']);
    const ws = await (await fetch(`${base}/api/library/${encodeURIComponent('ws-박용철 산문집/인형의 집')}`)).json();
    assert.strictEqual(ws.title, '박용철 산문집/인형의 집');
    assert.strictEqual(ws.lang, 'ko');
  });
  assert.strictEqual(urls[0], 'https://www.gutenberg.org/cache/epub/1524/pg1524.txt');
  assert.strictEqual(urls[1], 'https://ko.wikisource.org/w/index.php?title=' + encodeURIComponent('박용철 산문집/인형의 집') + '&action=raw');
});

test('imports reject bad ids, missing pages and texts that are not plays', async () => {
  const fetchSource = async (url) => {
    if (url.includes('999')) { const err = new Error('source 404'); err.status = 404; throw err; }
    return 'Title: A Novel\n*** START OF THE PROJECT GUTENBERG EBOOK X ***\nIt was a dark and stormy night.\n\nThe end.';
  };
  await withServer({ fetchSource }, async (base) => {
    for (const id of ['gb-abc', 'gb-1234567', 'ws-a|b', 'ws-', 'ws-<x>']) {
      assert.strictEqual((await fetch(`${base}/api/library/${encodeURIComponent(id)}`)).status, 404, id);
    }
    assert.strictEqual((await fetch(`${base}/api/library/gb-999`)).status, 404);
    const novel = await fetch(`${base}/api/library/gb-11`);
    assert.strictEqual(novel.status, 422);
    assert.match((await novel.json()).error, /대사/);
  });
});

test('Gutenberg plays with "NAME. speech" on one line (Shaw, Chekhov) are converted too', () => {
  const raw = [
    '*** START OF THE PROJECT GUTENBERG EBOOK PYGMALION ***',
    'PREFACE TO PYGMALION.', '', 'A long preface about phonetics.', '',
    'ACT I', '', 'Covent Garden at 11.15 p.m.', '',
    'THE FLOWER GIRL. Nah then, Freddy: look wh’ y’ gowin, deah.', '',
    'FREDDY. Sorry.', '',
    'THE FLOWER GIRL [picking up her scattered flowers and replacing them in',
    'the basket] Theres menners f’ yer!', '',
    'FREDDY. Not at all.', '',
    'THE FLOWER GIRL. Ow, eez ye-ooa san, is e?', '',
    '*** END OF THE PROJECT GUTENBERG EBOOK PYGMALION ***',
  ].join('\n');
  const text = convertGutenberg(raw);
  assert.doesNotMatch(text, /phonetics/);
  const lines = K.parseScript(text).filter((i) => i.type === 'line').map((i) => [i.character, i.text, i.note]);
  assert.deepStrictEqual(lines, [
    ['THE FLOWER GIRL', 'Nah then, Freddy: look wh’ y’ gowin, deah.', ''],
    ['FREDDY', 'Sorry.', ''],
    ['THE FLOWER GIRL', 'Theres menners f’ yer!', 'picking up her scattered flowers and replacing them in the basket'],
    ['FREDDY', 'Not at all.', ''],
    ['THE FLOWER GIRL', 'Ow, eez ye-ooa san, is e?', ''],
  ]);
});

test('the 공유마당 play list is complete and has no search shortcut', () => {
  const { GONGU_PLAYS, gonguWorkUrl, MORE_SITES } = require('./libraryview.js').LibraryView;
  assert.ok(!MORE_SITES.some((s) => /gongu/.test(s.url)));
  const works = GONGU_PLAYS.flatMap(([author, list]) => list.map(([id, title, quick]) => ({ author, id, title, quick })));
  assert.strictEqual(works.length, 84);
  assert.strictEqual(new Set(works.map((w) => w.id)).size, 84);
  works.forEach((w) => assert.ok(w.author && w.title && /^\d{7}$/.test(String(w.id)), JSON.stringify(w)));
  assert.strictEqual(gonguWorkUrl(9021301), 'https://gongu.copyright.or.kr/gongu/wrt/wrt/view.do?wrtSn=9021301&menuNo=200019');
  // 바로 불러오기 id는 서재 목록이나 위키문헌 가져오기 형식이어야 함
  works.filter((w) => w.quick).forEach((w) => assert.ok(CATALOG.some((c) => c.id === w.quick) || /^ws-/.test(w.quick), w.quick));
});
