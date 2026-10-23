// 실행: node --test
const test = require('node:test');
const assert = require('node:assert');
const zlib = require('node:zlib');
const F = require('./fileimport.js');

const inflateRaw = async (u8) => new Uint8Array(zlib.inflateRawSync(u8));
const extract = (name, bytes) => F.extractScriptText({ name, bytes: new Uint8Array(bytes) }, { inflateRaw });
const LINES = '민수: 늦었네.\n지연(화가 나서): 왜?';

// ---------- 테스트용 파일 만들기 ----------
// 최소 ZIP: 파일마다 local header + 데이터, 끝에 central directory
function makeZip(files, { deflate = true } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const raw = Buffer.from(content, 'utf8');
    const data = deflate ? zlib.deflateRawSync(raw) : raw;
    const nameBuf = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

// 최소 CFB(OLE) 파일: 512바이트 섹터, 작은 스트림은 mini stream에 넣음 (한글 .hwp 컨테이너)
function makeCfb(streams /* { 'FileHeader': Buffer, 'BodyText/Section0': Buffer } */) {
  const SECTOR = 512;
  const MINI = 64;
  const END = 0xfffffffe;
  const FREE = 0xffffffff;
  // 디렉터리 항목: root, 최상위 스트림/스토리지, 그 아래 스트림
  const entries = [{ name: 'Root Entry', type: 5, children: [] }];
  const byPath = { '': entries[0] };
  for (const path of Object.keys(streams)) {
    const parts = path.split('/');
    let parent = byPath[''];
    for (let i = 0; i < parts.length; i++) {
      const p = parts.slice(0, i + 1).join('/');
      if (!byPath[p]) {
        const isStream = i === parts.length - 1;
        const entry = { name: parts[i], type: isStream ? 2 : 1, children: [], data: isStream ? streams[path] : null };
        entry.id = entries.length;
        entries.push(entry);
        byPath[p] = entry;
        parent.children.push(entry);
      }
      parent = byPath[p];
    }
  }
  entries[0].id = 0;
  // mini stream 구성
  const miniFat = [];
  const miniChunks = [];
  for (const e of entries.filter((x) => x.type === 2)) {
    const count = Math.max(1, Math.ceil(e.data.length / MINI));
    e.start = miniFat.length;
    for (let i = 0; i < count; i++) miniFat.push(i === count - 1 ? END : e.start + i + 1);
    const padded = Buffer.alloc(count * MINI);
    e.data.copy(padded);
    miniChunks.push(padded);
  }
  const miniStream = Buffer.concat(miniChunks);
  const miniSectors = Math.ceil(miniStream.length / SECTOR);
  // 섹터 배치: 0=FAT, 1=디렉터리, 2=miniFAT, 3..=mini stream 컨테이너
  const fat = new Array(SECTOR / 4).fill(FREE);
  fat[0] = 0xfffffffd;
  fat[1] = END;
  fat[2] = END;
  for (let i = 0; i < miniSectors; i++) fat[3 + i] = i === miniSectors - 1 ? END : 3 + i + 1;
  entries[0].start = 3;
  entries[0].size = miniStream.length;

  const header = Buffer.alloc(SECTOR);
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(header, 0);
  header.writeUInt16LE(0x3e, 24);
  header.writeUInt16LE(3, 26);
  header.writeUInt16LE(0xfffe, 28);
  header.writeUInt16LE(9, 30);
  header.writeUInt16LE(6, 32);
  header.writeUInt32LE(1, 44);
  header.writeUInt32LE(1, 48);
  header.writeUInt32LE(4096, 56);
  header.writeUInt32LE(2, 60);
  header.writeUInt32LE(1, 64);
  header.writeUInt32LE(END, 68);
  for (let i = 0; i < 109; i++) header.writeUInt32LE(i === 0 ? 0 : FREE, 76 + i * 4);

  const fatSector = Buffer.alloc(SECTOR);
  fat.forEach((v, i) => fatSector.writeUInt32LE(v >>> 0, i * 4));
  const dirSector = Buffer.alloc(SECTOR);
  entries.forEach((e, i) => {
    const off = i * 128;
    const name = Buffer.from(e.name + '\0', 'utf16le');
    name.copy(dirSector, off);
    dirSector.writeUInt16LE(name.length, off + 64);
    dirSector[off + 66] = e.type;
    dirSector[off + 67] = 1;
    // 형제는 right로 이어 붙인 단순 트리
    dirSector.writeUInt32LE(FREE, off + 68);
    dirSector.writeUInt32LE(FREE, off + 72);
    dirSector.writeUInt32LE(e.children.length ? e.children[0].id : FREE, off + 76);
    dirSector.writeUInt32LE(e.type === 1 ? 0 : (e.start >>> 0), off + 116);
    dirSector.writeUInt32LE(e.type === 1 ? 0 : (e.type === 5 ? e.size : e.data.length), off + 120);
  });
  entries.forEach((e) => e.children.forEach((c, i) => {
    if (i + 1 < e.children.length) dirSector.writeUInt32LE(e.children[i + 1].id, c.id * 128 + 72);
  }));
  const miniFatSector = Buffer.alloc(SECTOR, 0xff);
  miniFat.forEach((v, i) => miniFatSector.writeUInt32LE(v >>> 0, i * 4));
  const container = Buffer.alloc(miniSectors * SECTOR);
  miniStream.copy(container);
  return Buffer.concat([header, fatSector, dirSector, miniFatSector, container]);
}

// 한글 5.0 레코드: [tag 10bit | level 10bit | size 12bit]
function record(tag, payload) {
  const head = Buffer.alloc(4);
  head.writeUInt32LE((tag | (payload.length << 20)) >>> 0);
  return Buffer.concat([head, payload]);
}
const wchars = (...codes) => { const b = Buffer.alloc(codes.length * 2); codes.forEach((c, i) => b.writeUInt16LE(c, i * 2)); return b; };
// 탭은 8 WCHAR짜리 인라인 컨트롤, 구역 정의 등은 8 WCHAR짜리 확장 컨트롤
function paraText(text, { withControls = false } = {}) {
  const parts = [];
  if (withControls) parts.push(wchars(2, 0x6364, 0x6573, 0, 0, 0, 0, 2));
  Array.from(text).forEach((ch) => parts.push(ch === '\t' ? wchars(9, 0, 0, 0, 0, 0, 0, 9) : Buffer.from(ch, 'utf16le')));
  parts.push(wchars(13));
  return Buffer.concat(parts);
}
function makeHwp(paragraphs, { compressed = true, password = false } = {}) {
  const header = Buffer.alloc(256);
  header.write('HWP Document File', 0, 'ascii');
  header.writeUInt32LE(0x05000300, 32);
  header.writeUInt32LE((compressed ? 1 : 0) | (password ? 2 : 0), 36);
  const body = Buffer.concat(paragraphs.flatMap((p, i) => [
    record(66, Buffer.alloc(22)),                                        // PARA_HEADER (건너뛰어야 함)
    record(67, paraText(p, { withControls: i === 0 })),                  // PARA_TEXT
  ]));
  return makeCfb({ FileHeader: header, 'BodyText/Section0': compressed ? zlib.deflateRawSync(body) : body });
}

// ---------- 텍스트 ----------
test('UTF-8 text (with or without BOM) is read as is', async () => {
  assert.strictEqual((await extract('a.txt', Buffer.from(LINES, 'utf8'))).text, LINES);
  assert.strictEqual((await extract('a.txt', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(LINES)]))).text, LINES);
});

test('old Korean text files (EUC-KR / CP949) are not garbled', async () => {
  const euckr = Buffer.from([0xb9, 0xce, 0xbc, 0xf6, 0x3a, 0x20, 0xbe, 0xc8, 0xb3, 0xe7]);  // "민수: 안녕"
  const r = await extract('old.txt', euckr);
  assert.strictEqual(r.text, '민수: 안녕');
});

test('UTF-16 text files are decoded', async () => {
  const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(LINES, 'utf16le')]);
  assert.strictEqual((await extract('u16.txt', le)).text, LINES);
  assert.strictEqual((await extract('u16-nobom.txt', Buffer.from(LINES, 'utf16le'))).text, LINES);
});

// ---------- Word / 한글(hwpx) / OpenDocument ----------
test('Word .docx paragraphs, tabs and line breaks become lines', async () => {
  const doc = '<?xml version="1.0"?><w:document xmlns:w="x"><w:body>'
    + '<w:p><w:pPr><w:pStyle w:val="a"/></w:pPr><w:r><w:t>민수: 늦었네.</w:t></w:r></w:p>'
    + '<w:p/>'
    + '<w:p><w:r><w:t xml:space="preserve">지연(화가 나서): </w:t></w:r><w:r><w:t>왜?</w:t></w:r></w:p>'
    + '<w:p><w:r><w:t>A&amp;B</w:t><w:tab/><w:t>C</w:t><w:br/><w:t>D</w:t></w:r></w:p>'
    + '</w:body></w:document>';
  const r = await extract('script.docx', makeZip({ '[Content_Types].xml': '<x/>', 'word/document.xml': doc }));
  assert.strictEqual(r.format, 'docx');
  assert.strictEqual(r.text, '민수: 늦었네.\n\n지연(화가 나서): 왜?\nA&B\tC\nD');
});

test('Hangul .hwpx sections are read in order, including nested table paragraphs', async () => {
  const sec = (body) => `<hs:sec xmlns:hs="s" xmlns:hp="p">${body}</hs:sec>`;
  const zip = makeZip({
    mimetype: 'application/hwp+zip',
    'Contents/section1.xml': sec('<hp:p><hp:run><hp:t>지연: 왜?</hp:t></hp:run></hp:p>'),
    'Contents/section0.xml': sec('<hp:p><hp:run><hp:t>민수: 늦었네.</hp:t></hp:run></hp:p>'
      + '<hp:p><hp:run><hp:tbl><hp:tr><hp:tc><hp:subList><hp:p><hp:run><hp:t>표 안</hp:t></hp:run></hp:p></hp:subList></hp:tc></hp:tr></hp:tbl></hp:run></hp:p>'),
  });
  const r = await extract('script.hwpx', zip);
  assert.strictEqual(r.format, 'hwpx');
  assert.strictEqual(r.text, '민수: 늦었네.\n표 안\n지연: 왜?');
});

test('OpenDocument .odt text, spaces and headings', async () => {
  const content = '<office:document-content xmlns:office="o" xmlns:text="t"><office:body><office:text>'
    + '<text:h>S#1. 카페</text:h><text:p>민수:<text:s/>늦었네.</text:p><text:p>지연:<text:s text:c="2"/>왜?</text:p>'
    + '</office:text></office:body></office:document-content>';
  const r = await extract('script.odt', makeZip({ mimetype: 'application/vnd.oasis.opendocument.text', 'content.xml': content }, { deflate: false }));
  assert.strictEqual(r.format, 'odt');
  assert.strictEqual(r.text, 'S#1. 카페\n민수: 늦었네.\n지연:  왜?');
});

// ---------- 한글(hwp 5.0) ----------
test('Hangul .hwp 5.0 body text is extracted (compressed, with controls and tabs)', async () => {
  const r = await extract('script.hwp', makeHwp(['민수: 늦었네.', '지연(화가 나서):\t왜?']));
  assert.strictEqual(r.format, 'hwp');
  assert.strictEqual(r.text, '민수: 늦었네.\n지연(화가 나서):\t왜?');
});

test('uncompressed .hwp also works; password-protected .hwp gives a clear message', async () => {
  assert.strictEqual((await extract('a.hwp', makeHwp(['안녕'], { compressed: false }))).text, '안녕');
  await assert.rejects(extract('locked.hwp', makeHwp(['비밀'], { password: true })), /암호/);
});

// ---------- RTF ----------
test('RTF with Korean (hex code page 949 and \\u escapes) becomes plain text', async () => {
  const rtf = '{\\rtf1\\ansi\\ansicpg949{\\fonttbl{\\f0 Batang;}}{\\*\\generator x;}\\f0 '
    + "\\'b9\\'ce\\'bc\\'f6: \\u45734?\\u50632?\\u45348?.\\par "
    + '\\u51648?\\u50672?: \\u50780??\\par}';
  const r = await extract('script.rtf', Buffer.from(rtf, 'latin1'));
  assert.strictEqual(r.format, 'rtf');
  assert.strictEqual(r.text, '민수: 늦었네.\n지연: 왜?');
});

// ---------- PDF (줄 복원) ----------
test('PDF text items are rebuilt into lines in reading order', () => {
  const items = [
    { str: '지연:', x: 50, y: 680, width: 30, height: 12 },
    { str: '왜?', x: 86, y: 680.4, width: 20, height: 12 },
    { str: '민수: 늦었네.', x: 50, y: 700, width: 80, height: 12 },
    { str: 'S#2. 거리', x: 50, y: 640, width: 60, height: 12 },        // 앞 줄과 간격이 넓음 → 빈 줄
    { str: '3', x: 300, y: 40, width: 6, height: 10 },                // 쪽 번호 → 버림
  ];
  assert.strictEqual(F.pdfPageText(items), '민수: 늦었네.\n지연: 왜?\n\nS#2. 거리');
});

test('PDF characters split into separate items are joined without extra spaces', () => {
  const items = [
    { str: '늦', x: 50, y: 700, width: 12, height: 12 },
    { str: '었', x: 62, y: 700, width: 12, height: 12 },
    { str: '네', x: 74, y: 700, width: 12, height: 12 },
    { str: '왜', x: 100, y: 700, width: 12, height: 12 },
  ];
  assert.strictEqual(F.pdfPageText(items), '늦었네 왜');
});

// ---------- 지원하지 않는 형식은 깨진 글자 대신 안내 ----------
test('unsupported or binary files give a helpful message instead of garbage', async () => {
  await assert.rejects(extract('old.doc', makeCfb({ WordDocument: Buffer.alloc(100) })), /\.docx/);
  await assert.rejects(extract('photo.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 2, 3, 4, 5, 0, 0, 0, 0])), /이미지|읽을 수 없/);
  await assert.rejects(extract('random.zip', makeZip({ 'a.bin': 'x' })), /압축/);
  await assert.rejects(extract('empty.txt', Buffer.alloc(0)), /비어/);
});

test('files over the size limit are rejected before reading', async () => {
  await assert.rejects(F.extractScriptText({ name: 'big.pdf', bytes: { length: F.MAX_FILE_BYTES + 1 } }, { inflateRaw }), /너무 큽니다/);
});

test('extracted text is tidied: CRLF, trailing spaces, extra blank lines, invisible characters', async () => {
  const messy = '민수: 늦었네.  \r\n\r\n\r\n\r\n지연: 왜?​\r\n';
  assert.strictEqual((await extract('m.txt', Buffer.from(messy))).text, '민수: 늦었네.\n\n지연: 왜?');
});

test('PDF lines wrapped at the right margin are joined back; new speakers are not', () => {
  const items = [
    { str: '민수: 3년 만에 갑자기 나타나서 커피 한 잔 시켜 놓고 두 시간째야. 할 말 있으면', x: 50, y: 700, width: 480, height: 12 },
    { str: '해.', x: 50, y: 684, width: 14, height: 12 },
    { str: '지연(화가 나서): 할 말? 먼저 연락 끊은 게 누군데 나한테 할 말을 물어?', x: 50, y: 668, width: 470, height: 12 },
    { str: '민수: 그건...', x: 50, y: 652, width: 60, height: 12 },
    { str: '(정적. 빗소리만 들린다.)', x: 50, y: 636, width: 120, height: 12 },
  ];
  assert.strictEqual(F.pdfPageText(items), [
    '민수: 3년 만에 갑자기 나타나서 커피 한 잔 시켜 놓고 두 시간째야. 할 말 있으면 해.',
    '지연(화가 나서): 할 말? 먼저 연락 끊은 게 누군데 나한테 할 말을 물어?',
    '민수: 그건...',
    '(정적. 빗소리만 들린다.)',
  ].join('\n'));
});

test('PDF: a line starting with a known speaker name ("이름 대사" plays) is never joined to the previous line', () => {
  const rows = F.pdfPageRows([
    { str: '용자 네? … 저희들은 43호에 살고 있어요. 전 박용자라고 해요. 용감할 용, 아들 자.', x: 50, y: 700, width: 480, height: 12 },
    { str: '상범 … 네. 미스 박은 잘 압니다.', x: 50, y: 684, width: 200, height: 12 },
  ]);
  const isNewLine = (t) => /^(상범|용자)\s/.test(t);
  assert.strictEqual(F.joinPdfRows(rows, isNewLine).split('\n').length, 2);
});

test('PDF: a sentence wrapped across a page break is joined', () => {
  const page1 = F.pdfPageRows([
    { str: '민수: 짧은 줄.', x: 50, y: 120, width: 60, height: 12 },
    { str: '탱크는 소희에게 자기가 제일이라는 몸 시늉을 한다. 소희는 흩어', x: 50, y: 104, width: 480, height: 12 },
  ]);
  const page2 = F.pdfPageRows([
    { str: '져 있는 잡지를 훑어본다.', x: 50, y: 760, width: 150, height: 12 },
    { str: '민수: 다음.', x: 50, y: 744, width: 50, height: 12 },
  ]);
  assert.strictEqual(F.joinPdfRows([...page1, ...page2]), '민수: 짧은 줄.\n탱크는 소희에게 자기가 제일이라는 몸 시늉을 한다. 소희는 흩어 져 있는 잡지를 훑어본다.\n민수: 다음.');
});
