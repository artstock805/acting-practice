// 무료 대본 서재 (GET /api/library, /api/library/:id): 저작권이 끝난 공개 저작물(퍼블릭 도메인) 희곡을
// 정해 둔 출처(Project Gutenberg, 한국어 위키문헌)에서 받아 앱이 알아보는 형식으로 바꿔 줌.
// 출처 주소는 서버의 목록에만 있음 (사용자가 다른 주소를 시킬 수 없음). 한 번 받은 작품은 메모리에 둠
'use strict';

const SOURCE_TIMEOUT_MS = 15_000;
const MAX_SOURCE_BYTES = 3 * 1024 * 1024;
const LIBRARY_RATE_LIMIT = { max: 30, windowMs: 10 * 60_000 };
const ID_RE = /^[a-z0-9-]{1,40}$/;

const gutenberg = (id) => `https://www.gutenberg.org/cache/epub/${id}/pg${id}.txt`;
const wikisource = (title) => `https://ko.wikisource.org/w/index.php?title=${encodeURIComponent(title)}&action=raw`;

// 작가(번역본은 번역가도) 사망 후 70년이 지나 한국·미국 등 대부분 나라에서 공개 저작물인 작품만 둠
const CATALOG = [
  { id: 'hamlet', title: 'Hamlet', titleKo: '햄릿', author: 'William Shakespeare', year: 1603, lang: 'en', source: 'gutenberg', url: gutenberg(1524), rights: '셰익스피어(1616년 사망)' },
  { id: 'romeo-juliet', title: 'Romeo and Juliet', titleKo: '로미오와 줄리엣', author: 'William Shakespeare', year: 1597, lang: 'en', source: 'gutenberg', url: gutenberg(1513), rights: '셰익스피어(1616년 사망)' },
  { id: 'macbeth', title: 'Macbeth', titleKo: '맥베스', author: 'William Shakespeare', year: 1623, lang: 'en', source: 'gutenberg', url: gutenberg(1533), rights: '셰익스피어(1616년 사망)' },
  { id: 'midsummer', title: "A Midsummer Night's Dream", titleKo: '한여름 밤의 꿈', author: 'William Shakespeare', year: 1600, lang: 'en', source: 'gutenberg', url: gutenberg(1514), rights: '셰익스피어(1616년 사망)' },
  { id: 'othello', title: 'Othello', titleKo: '오셀로', author: 'William Shakespeare', year: 1622, lang: 'en', source: 'gutenberg', url: gutenberg(1531), rights: '셰익스피어(1616년 사망)' },
  { id: 'earnest', title: 'The Importance of Being Earnest', titleKo: '진지함의 중요성', author: 'Oscar Wilde', year: 1895, lang: 'en', source: 'gutenberg', url: gutenberg(844), rights: '오스카 와일드(1900년 사망)' },
  { id: 'dolls-house', title: "A Doll's House", titleKo: '인형의 집', author: 'Henrik Ibsen (tr. R. Farquharson Sharp)', year: 1879, lang: 'en', source: 'gutenberg', url: gutenberg(2542), rights: '입센(1906년 사망), 번역 R. Farquharson Sharp(1945년 사망)' },
  { id: 'hedda-gabler', title: 'Hedda Gabler', titleKo: '헤다 가블러', author: 'Henrik Ibsen (tr. William Archer)', year: 1890, lang: 'en', source: 'gutenberg', url: gutenberg(4093), rights: '입센(1906년 사망), 번역 William Archer(1924년 사망)' },
  { id: 'gyuhan', title: '규한', titleKo: '규한', author: '이광수', year: 1917, lang: 'ko', source: 'wikisource', url: wikisource('규한'), rights: '이광수(1950년 사망)' },
  { id: 'byeongja-samin', title: '병자삼인', titleKo: '병자삼인', author: '조중환', year: 1912, lang: 'ko', source: 'wikisource', url: wikisource('병자삼인'), rights: '조중환(1947년 사망)' },
  { id: 'jeseok', title: '제석', titleKo: '제석', author: '홍사용', year: 1929, lang: 'ko', source: 'wikisource', url: wikisource('제석'), rights: '홍사용(1947년 사망)' },
];

const SOURCE_NAMES = { gutenberg: 'Project Gutenberg', wikisource: '위키문헌' };
const publicInfo = ({ url, ...work }) => ({ ...work, sourceName: SOURCE_NAMES[work.source] });

// ---------- Project Gutenberg ----------
// "HAMLET." 처럼 대문자 이름 + 마침표만 있는 줄 다음 문단이 대사. [지문]·_[지문]_은 (지문)으로
const GB_CUE = /^([A-Z][A-Z .'’,-]*[A-Z])\.\s*$/;
const GB_ACT = /^\s*(ACT\s+([IVXLC]+|\d+|FIRST|SECOND|THIRD|FOURTH|FIFTH)\b|(FIRST|SECOND|THIRD|FOURTH|FIFTH)\s+ACT\b)/i;
const GB_SCENE = /^\s*SCENE\s+([IVXLC]+|\d+)\b/i;

function cleanGutenberg(s) {
  return s.replace(/_/g, '').replace(/\[/g, '(').replace(/\]/g, ')').replace(/\s+/g, ' ').trim();
}

function convertGutenberg(raw) {
  const all = String(raw).replace(/\r/g, '');
  const start = all.search(/^\*\*\* ?START OF TH(E|IS) PROJECT GUTENBERG.*$/m);
  const end = all.search(/^\*\*\* ?END OF TH(E|IS) PROJECT GUTENBERG.*$/m);
  const body = all.slice(start >= 0 ? all.indexOf('\n', start) + 1 : 0, end >= 0 ? end : all.length);
  const lines = body.split('\n');
  // 목차·머리말·해설을 건너뜀: 이름 줄이 세 번 이상 나오는 첫 막(ACT) 제목부터 (목차의 ACT 줄, 해설의 INTRODUCTION. 은 제외)
  const isCueLine = (l) => GB_CUE.test(l.trim()) && !GB_ACT.test(l) && !GB_SCENE.test(l);
  const acts = lines.map((l, i) => (GB_ACT.test(l) ? i : -1)).filter((i) => i >= 0);
  const firstAct = acts.find((a, k) => lines.slice(a + 1, acts[k + 1] ?? lines.length).filter(isCueLine).length >= 3);
  const from = firstAct ?? lines.findIndex(isCueLine);
  const paragraphs = lines.slice(Math.max(0, from)).join('\n').split(/\n\s*\n/).map((p) => p.split('\n').map((l) => l.trim()).filter(Boolean)).filter((p) => p.length);
  const isCue = (p) => GB_CUE.test(p[0]) && !GB_ACT.test(p[0]) && !GB_SCENE.test(p[0]);
  const out = [];
  for (let i = 0; i < paragraphs.length; i++) {
    const p = paragraphs[i];
    if (isCue(p)) {
      // 이름 줄 다음에 빈 줄을 두고 대사가 오는 판본(헤다 가블러 등)은 다음 문단을 대사로
      const rest = p.length > 1 ? p.slice(1) : (paragraphs[i + 1] && !isCue(paragraphs[i + 1]) ? paragraphs[++i] : []);
      const speech = cleanGutenberg(rest.join(' '));
      if (speech) out.push(`${GB_CUE.exec(p[0])[1]}\n${speech}`);
      continue;
    }
    const text = cleanGutenberg(p.join(' '));
    out.push(GB_ACT.test(text) || GB_SCENE.test(text) ? text : `(${text.replace(/^\((.*)\)$/, '$1')})`);
  }
  return out.join('\n\n');
}

// ---------- 위키문헌 ----------
// ";이름" 다음 ":대사" 줄, 또는 "'''이름''' 대사" 줄을 "이름: 대사"로. 그 밖의 글은 (지문)으로 감쌈
const WS_END_SECTION = /^==+\s*(라이선스|저작권|주석|각주|참고)\s*==+\s*$/;
const WS_HEADING = /^(==+)\s*(.*?)\s*\1\s*$/;
const WS_BOLD_LINE = /^'''([^']{1,20})'''\s*(.*)$/;

function stripWiki(s) {
  let t = s;
  for (let i = 0; i < 10 && /\{\{[^{}]*\}\}/.test(t); i++) t = t.replace(/\{\{[^{}]*\}\}/g, '');
  return t
    .replace(/<ref[^>]*\/>/g, '').replace(/<ref[^>]*>[\s\S]*?<\/ref>/g, '').replace(/<[^>]+>/g, '')
    .replace(/\[\[(분류|파일|File|Category):[^\]]*\]\]/gi, '')
    .replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, '$1').replace(/\[\[([^\]]*)\]\]/g, '$1');
}

function convertWikisource(raw) {
  const lines = stripWiki(String(raw).replace(/\r/g, '')).split('\n');
  const endAt = lines.findIndex((l) => WS_END_SECTION.test(l.trim()));
  const body = (endAt >= 0 ? lines.slice(0, endAt) : lines).map((l) => l.trim());
  const boldCounts = new Map();
  body.forEach((l) => { const m = WS_BOLD_LINE.exec(l); if (m && m[2]) boldCounts.set(m[1].trim(), (boldCounts.get(m[1].trim()) || 0) + 1); });
  const out = [];
  let speaker = null;
  let scene = 0;
  const plain = (s) => s.replace(/'''?/g, '').trim();
  body.forEach((line) => {
    if (!line) { speaker = null; return; }
    const heading = WS_HEADING.exec(line);
    if (heading) {
      speaker = null;
      const title = plain(heading[2]);
      if (heading[1].length === 2 && /\d|장|막|경|場|幕|景/.test(title)) out.push(`S#${++scene}. ${title}`);
      else if (title) out.push(`(${title})`);
      return;
    }
    if (line.startsWith(';')) { speaker = plain(line.slice(1)); return; }
    if (line.startsWith(':') && speaker) { const said = plain(line.replace(/^:+/, '')); if (said) out.push(`${speaker}: ${said}`); return; }
    const bold = WS_BOLD_LINE.exec(line);
    if (bold && bold[2] && boldCounts.get(bold[1].trim()) >= 2) { out.push(`${bold[1].trim()}: ${plain(bold[2])}`); return; }
    const text = plain(line.replace(/^[*:#]+\s*/, ''));
    if (text) out.push(`(${text.replace(/^\((.*)\)$/, '$1')})`);
  });
  return out.join('\n');
}

// 긴 작품을 막·장 단위로 나눔 (휴대폰에서 원하는 부분만 불러오게)
function splitSections(text, lang) {
  const isBreak = lang === 'en' ? (l) => GB_ACT.test(l) : (l) => /^S#\d+\./.test(l);
  const lines = text.split('\n');
  const sections = [];
  lines.forEach((l) => {
    if (isBreak(l.trim())) sections.push({ title: l.trim().replace(/^S#\d+\.\s*/, ''), lines: [l] });
    else if (sections.length) sections[sections.length - 1].lines.push(l);
  });
  return sections.length ? sections.map((s) => ({ title: s.title, text: s.lines.join('\n').trim() })) : [{ title: '전체', text }];
}

async function fetchSourceText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'acting-practice script library (one copy per work, cached)' }, signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`source ${res.status}`);
  const text = await res.text();
  if (text.length > MAX_SOURCE_BYTES) throw new Error('source too large');
  return text;
}

function createLibraryHandler({ fetchSource = fetchSourceText, sendJson, clientIp, createRateLimiter }) {
  const allow = createRateLimiter(LIBRARY_RATE_LIMIT);
  const cache = new Map();  // id → Promise<작품> (같은 작품을 동시에 여러 번 받지 않게)
  const byId = new Map(CATALOG.map((w) => [w.id, w]));

  function load(work) {
    if (!cache.has(work.id)) {
      const pending = fetchSource(work.url).then((raw) => {
        const text = work.source === 'gutenberg' ? convertGutenberg(raw) : convertWikisource(raw);
        return { ...publicInfo(work), text, sections: splitSections(text, work.lang) };
      });
      cache.set(work.id, pending);
      pending.catch(() => cache.delete(work.id));  // 실패하면 다음에 다시 시도
    }
    return cache.get(work.id);
  }

  return async function handleLibrary(req, res, id) {
    if (!id) return sendJson(res, 200, { works: CATALOG.map(publicInfo) });
    const work = ID_RE.test(id) && byId.get(id);
    if (!work) return sendJson(res, 404, { error: '그런 작품이 없습니다.' });
    if (!allow(clientIp(req))) return sendJson(res, 429, { error: '잠시 뒤 다시 해 주세요.' });
    try {
      return sendJson(res, 200, await load(work));
    } catch (err) {
      console.error('[library]', work.id, err.message);
      return sendJson(res, 502, { error: '대본을 받아 오지 못했습니다. 잠시 뒤 다시 해 주세요.' });
    }
  };
}

module.exports = { CATALOG, convertGutenberg, convertWikisource, splitSections, createLibraryHandler };
