// 대본 파일 읽기: txt(인코딩 자동)·PDF·Word(.docx)·한글(.hwp·.hwpx)·OpenDocument(.odt)·RTF → 순수 텍스트.
// 모두 브라우저 안에서 처리 (대본을 서버로 보내지 않음). PDF만 pdf.js를 필요할 때 불러옴.
(function (root) {
  'use strict';

  const MAX_FILE_BYTES = 30 * 1024 * 1024;
  const PDFJS_DIR = 'vendor/pdfjs/';

  // 사용자에게 그대로 보여 줄 수 있는 안내 문구를 담은 오류
  class ImportError extends Error {}
  const fail = (message) => { throw new ImportError(message); };

  // ---------- 바이트 도우미 ----------
  const u16 = (b, o) => b[o] | (b[o + 1] << 8);
  const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  const startsWith = (b, sig) => sig.every((v, i) => b[i] === v);
  const SIG = {
    pdf: [0x25, 0x50, 0x44, 0x46],                                   // %PDF
    zip: [0x50, 0x4b, 0x03, 0x04],                                   // PK..
    cfb: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1],           // OLE (한글 .hwp, 옛 Word .doc)
  };
  const IMAGE_SIGS = [[0xff, 0xd8, 0xff], [0x89, 0x50, 0x4e, 0x47], [0x47, 0x49, 0x46, 0x38], [0x52, 0x49, 0x46, 0x46]];
  const latin1 = (b) => { let s = ''; for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode.apply(null, b.subarray(i, i + 8192)); return s; };

  // ---------- 텍스트 인코딩 ----------
  // UTF-8 → (BOM/0바이트로 보이는) UTF-16 → 옛 한글 txt(EUC-KR/CP949) 순으로 시도
  function decodeText(b) {
    if (startsWith(b, [0xef, 0xbb, 0xbf])) return new TextDecoder('utf-8').decode(b.subarray(3));
    if (startsWith(b, [0xff, 0xfe])) return new TextDecoder('utf-16le').decode(b.subarray(2));
    if (startsWith(b, [0xfe, 0xff])) return new TextDecoder('utf-16be').decode(b.subarray(2));
    if (looksUtf16le(b)) return new TextDecoder('utf-16le').decode(b);
    try { return new TextDecoder('utf-8', { fatal: true }).decode(b); } catch (_) { /* UTF-8이 아님 */ }
    return new TextDecoder('euc-kr').decode(b);   // 브라우저의 euc-kr은 CP949(확장 완성형)까지 포함
  }

  // BOM 없는 UTF-16LE: 띄어쓰기·문장부호 같은 ASCII 글자의 상위 바이트(홀수 위치)가 0으로 자주 나옴.
  // (한글만으로 된 바이트 패턴은 EUC-KR과 헷갈리므로 판단에 쓰지 않음. 윈도우는 UTF-16에 BOM을 붙여 저장함)
  function looksUtf16le(b) {
    if (b.length < 4 || b.length % 2) return false;
    let oddZero = 0;
    let evenZero = 0;
    const n = Math.min(b.length, 4000);
    for (let i = 0; i < n; i += 2) { if (b[i] === 0) evenZero++; if (b[i + 1] === 0) oddZero++; }
    const pairs = n / 2;
    return oddZero > pairs * 0.3 && evenZero < pairs * 0.05;
  }

  // 제어 문자가 많으면 글이 아니라 다른 형식의 파일
  function looksBinary(text) {
    if (!text.length) return false;
    const sample = text.slice(0, 4000);
    const bad = (sample.match(/[\u0000-\u0008\u000e-\u001f�]/g) || []).length;
    return bad / sample.length > 0.05;
  }

  // ---------- XML (docx · hwpx · odt) ----------
  function xmlUnescape(s) {
    return s.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (m, e) => {
      const k = e.toLowerCase();
      if (k[0] === '#') return String.fromCodePoint(k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10));
      return { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }[k];
    });
  }

  // 문단 태그(paragraph) 끝마다 줄을 나누고, 글자는 textIn 태그 안(없으면 문단 안 어디든)에서만 모음
  // spec: { paragraph: ['p'], textIn: ['t'] | null, tab: [...], lineBreak: [...], space: 's' }
  function xmlToText(xml, spec) {
    const out = [];
    let line = '';
    let textDepth = 0;
    let paraDepth = 0;
    const nested = [];   // 문단마다 안쪽 문단(표 칸 등)이 이미 줄을 냈는지 → 바깥 문단이 빈 줄을 덧붙이지 않게
    const is = (list, name) => list && list.includes(name);
    const re = /<[?!][\s\S]*?>|<(\/?)(?:[\w.-]+:)?([\w.-]+)((?:\s[^>]*?)?)(\/?)>|([^<]+)/g;
    let m;
    while ((m = re.exec(xml))) {
      const [, closing, name, attrs, selfClosing, text] = m;
      if (text !== undefined) {
        if (paraDepth > 0 && (spec.textIn ? textDepth > 0 : true)) line += xmlUnescape(text);
        continue;
      }
      if (!name) continue;
      if (is(spec.paragraph, name)) {
        if (closing) {
          paraDepth = Math.max(0, paraDepth - 1);
          const hadNested = nested.pop();
          if (line || !hadNested) out.push(line);
          line = '';
          if (nested.length) nested[nested.length - 1] = true;
        } else if (selfClosing) {
          out.push(line); line = '';
        } else {
          if (paraDepth > 0 && line) { out.push(line); line = ''; }
          if (nested.length) nested[nested.length - 1] = true;
          nested.push(false);
          paraDepth++;
        }
        continue;
      }
      if (is(spec.textIn, name) && !selfClosing) { textDepth = Math.max(0, textDepth + (closing ? -1 : 1)); continue; }
      if (closing) continue;
      if (is(spec.tab, name)) line += '\t';
      else if (is(spec.lineBreak, name)) line += '\n';
      else if (spec.space && name === spec.space) {
        const c = /\bc="(\d+)"/.exec(attrs);
        line += ' '.repeat(c ? Math.min(Number(c[1]), 100) : 1);
      }
    }
    if (line) out.push(line);
    return out.join('\n');
  }

  const DOCX = { paragraph: ['p'], textIn: ['t'], tab: ['tab'], lineBreak: ['br', 'cr'] };
  const HWPX = { paragraph: ['p'], textIn: ['t'], tab: ['tab'], lineBreak: ['lineBreak'] };
  const ODT = { paragraph: ['p', 'h'], textIn: null, tab: ['tab'], lineBreak: ['line-break'], space: 's' };

  // ---------- ZIP (docx · hwpx · odt는 ZIP 안에 XML) ----------
  async function readZip(b, inflateRaw) {
    let eocd = -1;
    for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) if (u32(b, i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) fail('압축 파일 구조를 읽지 못했습니다. 파일이 손상되었을 수 있어요.');
    const count = u16(b, eocd + 10);
    let p = u32(b, eocd + 16);
    const entries = {};
    for (let i = 0; i < count && u32(b, p) === 0x02014b50; i++) {
      const nameLen = u16(b, p + 28);
      const name = new TextDecoder('utf-8').decode(b.subarray(p + 46, p + 46 + nameLen));
      entries[name] = { method: u16(b, p + 10), compSize: u32(b, p + 20), local: u32(b, p + 42) };
      p += 46 + nameLen + u16(b, p + 30) + u16(b, p + 32);
    }
    return {
      names: Object.keys(entries),
      async text(name) {
        const e = entries[name];
        if (!e) return null;
        const start = e.local + 30 + u16(b, e.local + 26) + u16(b, e.local + 28);
        const data = b.subarray(start, start + e.compSize);
        if (e.method === 0) return new TextDecoder('utf-8').decode(data);
        if (e.method === 8) return new TextDecoder('utf-8').decode(await inflateRaw(data));
        return fail('지원하지 않는 압축 방식입니다.');
      },
    };
  }

  async function zipText(b, inflateRaw) {
    const zip = await readZip(b, inflateRaw);
    if (zip.names.includes('word/document.xml')) return { format: 'docx', text: xmlToText(await zip.text('word/document.xml'), DOCX) };
    const sections = zip.names.filter((n) => /^Contents\/section\d+\.xml$/i.test(n))
      .sort((a, c) => Number(/(\d+)\.xml$/.exec(a)[1]) - Number(/(\d+)\.xml$/.exec(c)[1]));
    if (sections.length) {
      const parts = [];
      for (const s of sections) parts.push(xmlToText(await zip.text(s), HWPX));
      return { format: 'hwpx', text: parts.join('\n') };
    }
    if (zip.names.includes('content.xml')) return { format: 'odt', text: xmlToText(await zip.text('content.xml'), ODT) };
    return fail('압축(zip) 파일 안에서 대본 문서를 찾지 못했습니다. 대본 파일(.txt·.pdf·.docx·.hwp)을 직접 골라 주세요.');
  }

  // ---------- CFB/OLE (한글 .hwp 5.0 컨테이너) ----------
  const END_OF_CHAIN = 0xfffffffe;
  function readCfb(b) {
    const sectorSize = 1 << u16(b, 30);
    const miniSize = 1 << u16(b, 32);
    const cutoff = u32(b, 56);
    const sectorOffset = (i) => (i + 1) * sectorSize;
    const maxSectors = Math.ceil(b.length / sectorSize) + 1;

    // FAT 섹터 목록: 헤더의 DIFAT 109개 + 이어지는 DIFAT 섹터
    const fatSectors = [];
    for (let i = 0; i < 109; i++) { const s = u32(b, 76 + i * 4); if (s < 0xfffffffa) fatSectors.push(s); }
    let difat = u32(b, 68);
    for (let guard = 0; difat < 0xfffffffa && guard < maxSectors; guard++) {
      const off = sectorOffset(difat);
      for (let i = 0; i < sectorSize / 4 - 1; i++) { const s = u32(b, off + i * 4); if (s < 0xfffffffa) fatSectors.push(s); }
      difat = u32(b, off + sectorSize - 4);
    }
    const fat = [];
    fatSectors.forEach((s) => { const off = sectorOffset(s); for (let i = 0; i < sectorSize / 4; i++) fat.push(u32(b, off + i * 4)); });

    const chain = (start, table, limit) => {
      const out = [];
      for (let s = start; s !== END_OF_CHAIN && s < table.length && out.length < limit; s = table[s]) out.push(s);
      return out;
    };
    const readChain = (start) => {
      const sectors = chain(start, fat, maxSectors);
      const out = new Uint8Array(sectors.length * sectorSize);
      sectors.forEach((s, i) => out.set(b.subarray(sectorOffset(s), sectorOffset(s) + sectorSize), i * sectorSize));
      return out;
    };

    const dir = readChain(u32(b, 48));
    const entries = [];
    for (let off = 0; off + 128 <= dir.length; off += 128) {
      const nameLen = u16(dir, off + 64);
      entries.push({
        name: new TextDecoder('utf-16le').decode(dir.subarray(off, off + Math.max(0, nameLen - 2))),
        type: dir[off + 66], left: u32(dir, off + 68), right: u32(dir, off + 72), child: u32(dir, off + 76),
        start: u32(dir, off + 116), size: u32(dir, off + 120),
      });
    }
    const rootEntry = entries[0];
    const miniStream = readChain(rootEntry.start);
    const miniFatBytes = readChain(u32(b, 60));
    const miniFat = [];
    for (let i = 0; i + 4 <= miniFatBytes.length; i += 4) miniFat.push(u32(miniFatBytes, i));

    // 디렉터리 트리를 펼쳐 '저장소/스트림' 경로로 찾을 수 있게 함
    const paths = {};
    const visit = (id, prefix, seen) => {
      if (id >= entries.length || seen.has(id)) return;
      seen.add(id);
      const e = entries[id];
      visit(e.left, prefix, seen);
      visit(e.right, prefix, seen);
      const path = prefix ? `${prefix}/${e.name}` : e.name;
      paths[path] = e;
      if (e.type === 1) visit(e.child, path, seen);
    };
    visit(rootEntry.child, '', new Set());

    return {
      paths: Object.keys(paths),
      read(path) {
        const e = paths[path];
        if (!e || e.type !== 2) return null;
        if (e.size < cutoff) {
          const sectors = chain(e.start, miniFat, Math.ceil(miniStream.length / miniSize) + 1);
          const out = new Uint8Array(sectors.length * miniSize);
          sectors.forEach((s, i) => out.set(miniStream.subarray(s * miniSize, (s + 1) * miniSize), i * miniSize));
          return out.subarray(0, e.size);
        }
        return readChain(e.start).subarray(0, e.size);
      },
    };
  }

  // ---------- 한글 .hwp 5.0 ----------
  const HWPTAG_PARA_TEXT = 67;
  // 8 WCHAR짜리 컨트롤(인라인·확장): 이 코드 뒤 7 WCHAR는 글자가 아님. 9(탭)도 여기에 속함
  const HWP_WIDE_CONTROLS = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]);

  function hwpParagraphText(p) {
    let s = '';
    for (let i = 0; i + 1 < p.length; i += 2) {
      const c = u16(p, i);
      if (c >= 32) { s += String.fromCharCode(c); continue; }
      if (c === 9) s += '\t';
      else if (c === 10) s += '\n';
      if (HWP_WIDE_CONTROLS.has(c)) i += 14;   // 남은 7 WCHAR 건너뜀
    }
    return s;
  }

  async function hwpText(cfb, inflateRaw) {
    const header = cfb.read('FileHeader');
    if (!header || latin1(header.subarray(0, 17)) !== 'HWP Document File') return null;
    const props = u32(header, 36);
    if (props & 2) fail('암호가 걸린 한글 파일입니다. 한글에서 암호를 풀고 저장한 뒤 다시 열어 주세요.');
    const sections = cfb.paths.filter((p) => /^BodyText\/Section\d+$/.test(p))
      .sort((a, c) => Number(a.replace(/\D/g, '')) - Number(c.replace(/\D/g, '')));
    if (!sections.length) {
      if ((props & 4) || cfb.paths.some((p) => p.startsWith('ViewText/'))) fail('배포용(보기 전용) 한글 문서라 글자를 꺼낼 수 없습니다. 한글에서 내용을 복사해 붙여 넣어 주세요.');
      fail('한글 파일에서 본문을 찾지 못했습니다.');
    }
    const paragraphs = [];
    for (const path of sections) {
      let data = cfb.read(path);
      if (props & 1) data = await inflateRaw(data);
      for (let off = 0; off + 4 <= data.length;) {
        const head = u32(data, off);
        const tag = head & 0x3ff;
        let size = head >>> 20;
        off += 4;
        if (size === 0xfff) { size = u32(data, off); off += 4; }
        if (tag === HWPTAG_PARA_TEXT) paragraphs.push(hwpParagraphText(data.subarray(off, off + size)));
        off += size;
      }
    }
    return { format: 'hwp', text: paragraphs.join('\n') };
  }

  // ---------- RTF ----------
  const RTF_SKIP = new Set(['fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'object', 'header', 'footer', 'headerl', 'headerr',
    'footerl', 'footerr', 'footnote', 'listtable', 'listoverridetable', 'rsidtbl', 'xmlnstbl', 'themedata', 'colorschememapping', 'latentstyles', 'datastore']);

  function rtfText(src) {
    const cp = /\\ansicpg(\d+)/.exec(src);
    const legacy = cp && ['949', '51949'].includes(cp[1]) ? 'euc-kr' : 'windows-1252';
    let out = '';
    let pendingBytes = [];
    const flush = () => { if (pendingBytes.length) { out += new TextDecoder(legacy).decode(Uint8Array.from(pendingBytes)); pendingBytes = []; } };
    const stack = [];
    let skip = false;
    let uc = 1;
    let skipChars = 0;   // \uN 다음에 대체 글자로 건너뛸 개수
    const re = /\\([a-z]+)(-?\d+)? ?|\\'([0-9a-f]{2})|\\([^a-z])|([{}])|([^\\{}]+)/gi;
    let m;
    while ((m = re.exec(src))) {
      const [, word, num, hex, sym, brace, text] = m;
      if (brace === '{') { stack.push({ skip, uc }); continue; }
      if (brace === '}') { flush(); const s = stack.pop(); if (s) ({ skip, uc } = s); continue; }
      if (hex !== undefined) {
        if (skipChars > 0) { skipChars--; continue; }
        if (!skip) pendingBytes.push(parseInt(hex, 16));
        continue;
      }
      if (sym !== undefined) {
        if (sym === '*') { skip = true; continue; }
        if (skipChars > 0) { skipChars--; continue; }
        if (!skip && (sym === '\\' || sym === '{' || sym === '}')) { flush(); out += sym; }
        else if (!skip && sym === '~') { flush(); out += ' '; }
        continue;
      }
      if (word !== undefined) {
        if (RTF_SKIP.has(word)) { skip = true; continue; }
        if (skip) continue;
        flush();
        if (word === 'par' || word === 'line') out += '\n';
        else if (word === 'tab') out += '\t';
        else if (word === 'uc') uc = Number(num || 1);
        else if (word === 'u') { let n = Number(num); if (n < 0) n += 65536; out += String.fromCharCode(n); skipChars = uc; }
        continue;
      }
      if (text !== undefined && !skip) {
        let t = text.replace(/[\r\n]/g, '');
        if (skipChars > 0) { const k = Math.min(skipChars, t.length); t = t.slice(k); skipChars -= k; }
        if (t) { flush(); out += t; }
      }
    }
    flush();
    return out;
  }

  // ---------- PDF: 글자 조각을 줄로 다시 맞추기 ----------
  const PAGE_NUMBER = /^[-–—\s]*\(?\d{1,4}\)?[-–—\s]*$|^\d+\s*\/\s*\d+$/;

  // items: [{ str, x, y, width, height }] (PDF 좌표: y는 위로 갈수록 큼)
  function pdfPageText(items, isNewLine) {
    return joinPdfRows(pdfPageRows(items), isNewLine);
  }

  // 한 쪽의 글자 조각 → 줄 목록. 줄마다 오른쪽 끝까지 찼는지(full), 앞에 문단 간격이 있는지(gapBefore)를 표시
  function pdfPageRows(items) {
    const parts = items.filter((it) => it.str && it.str.trim()).map((it) => ({ ...it, height: it.height || 10 }));
    if (!parts.length) return [];
    const heights = parts.map((p) => p.height).sort((a, c) => a - c);
    const lineHeight = heights[Math.floor(heights.length / 2)];
    // 같은 줄로 볼 y 차이
    const tolerance = Math.max(2, lineHeight * 0.5);
    const lines = [];
    parts.sort((a, c) => c.y - a.y || a.x - c.x).forEach((p) => {
      const line = lines.find((l) => Math.abs(l.y - p.y) <= tolerance);
      if (line) line.parts.push(p); else lines.push({ y: p.y, parts: [p] });
    });
    lines.sort((a, c) => c.y - a.y);
    const rows = lines.map(joinLineParts(lineHeight)).filter((r) => r.text && !PAGE_NUMBER.test(r.text));
    if (!rows.length) return [];
    const maxRight = Math.max(...rows.map((r) => r.right));
    return rows.map((row, i) => ({
      ...row,
      lineHeight,
      pageStart: i === 0,
      // 줄 간격이 평소보다 넓으면 문단이 바뀐 것 (장면 구분 유지)
      gapBefore: i > 0 && rows[i - 1].y - row.y > lineHeight * 2.2,
      full: row.right >= maxRight - lineHeight * 3,
    }));
  }

  // 여러 쪽의 줄을 이어 글로 만듦. 오른쪽 끝까지 찬 줄 다음에 새 인물·지문·장면이 아닌 줄이 오면
  // PDF가 자동 줄바꿈한 것 → 앞 줄에 이어 붙임 (쪽이 넘어가며 끊긴 문장도 포함)
  // isNewLine(text): 새 줄로 시작해야 하는지 (기본: '이름:'·괄호 지문·장면 제목. 희곡은 인물 이름도 넘겨 받음)
  function joinPdfRows(rows, isNewLine = (t) => NEW_LINE_START.test(t)) {
    const out = [];
    let prev = null;
    for (const row of rows) {
      const indentOk = row.pageStart || row.left >= prev.left - row.lineHeight;
      const wrapped = prev && prev.full && !row.gapBefore && indentOk && !isNewLine(row.text);
      if (wrapped) out[out.length - 1] += ' ' + row.text;
      else {
        if (row.gapBefore || (prev && row.pageStart && !prev.full)) out.push('');
        out.push(row.text);
      }
      prev = row;
    }
    return out.join('\n');
  }

  // 희곡처럼 '이름 대사'로 쓴 대본이면 문서 전체에서 인물 이름을 찾아, 그 이름으로 시작하는 줄도 새 줄로 둠
  function newLineTest(rows) {
    const K = root.ScriptKit;
    const names = K && K.findSpokenNames ? K.findSpokenNames(rows.map((r) => r.text)) : new Set();
    return (text) => NEW_LINE_START.test(text) || [...names].some((n) => text.startsWith(n + ' '));
  }

  // 새 줄로 시작해야 하는 줄: '이름:' '이름(지문):', 괄호 지문, 장면 제목
  const NEW_LINE_START = /^(?:[^\s:()]{1,20}\s*(?:\([^)]{0,30}\))?\s*:|[(（]|S#|씬\s*\d|#\s*\d|INT\.|EXT\.)/i;

  // 한 줄의 조각들을 왼쪽부터 이어 붙임. 조각 사이가 벌어져 있으면 띄어쓰기
  function joinLineParts(lineHeight) {
    return (line) => {
      line.parts.sort((a, c) => a.x - c.x);
      let text = '';
      let end = null;
      for (const p of line.parts) {
        const gap = end === null ? 0 : p.x - end;
        if (end !== null && gap > lineHeight * 0.25 && !/\s$/.test(text) && !/^\s/.test(p.str)) text += ' ';
        text += p.str;
        end = p.x + (p.width || 0);
      }
      return { text: text.replace(/\s+/g, ' ').trim(), y: line.y, left: line.parts[0].x, right: end };
    };
  }

  async function pdfText(b, baseUrl) {
    const dir = new URL(PDFJS_DIR, baseUrl).href;
    const pdfjs = await import(dir + 'pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = dir + 'pdf.worker.min.mjs';
    let doc;
    try {
      doc = await pdfjs.getDocument({ data: b, cMapUrl: dir + 'cmaps/', cMapPacked: true, isEvalSupported: false }).promise;
    } catch (err) {
      if (err && err.name === 'PasswordException') fail('암호가 걸린 PDF입니다. 암호를 풀고 저장한 뒤 다시 열어 주세요.');
      fail('PDF를 열지 못했습니다. 파일이 손상되었을 수 있어요.');
    }
    try {
      const rows = [];
      for (let n = 1; n <= doc.numPages; n++) {
        const page = await doc.getPage(n);
        const content = await page.getTextContent();
        rows.push(...pdfPageRows(content.items.map((it) => ({
          str: it.str, x: it.transform[4], y: it.transform[5], width: it.width, height: it.height || Math.abs(it.transform[3]),
        }))));
        page.cleanup();
      }
      const text = joinPdfRows(rows, newLineTest(rows));
      if (!text.replace(/\s/g, '').length) fail('이 PDF에는 글자 정보가 없습니다(스캔한 이미지로 된 PDF). 글자를 복사할 수 있는 PDF나 원본 문서(한글·워드)로 열어 주세요.');
      return { format: 'pdf', text };
    } finally {
      doc.destroy();
    }
  }

  // ---------- 정리 ----------
  function tidy(text) {
    return String(text)
      .replace(/\r\n?/g, '\n')
      .replace(/[   　]/g, ' ')
      .replace(/[​-‍⁠﻿]/g, '')
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
      .split('\n').map((l) => l.replace(/[ \t]+$/, '')).join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // 브라우저 기본 압축 해제 (Chrome 80+, Safari 16.4+)
  async function browserInflateRaw(data) {
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  // file: { name, bytes(Uint8Array) } → { format, text }. 읽을 수 없으면 ImportError(안내 문구)
  async function extractScriptText(file, { inflateRaw = browserInflateRaw, baseUrl = root.location && root.location.href } = {}) {
    if (file.bytes.length > MAX_FILE_BYTES) fail(`파일이 너무 큽니다(${Math.round(MAX_FILE_BYTES / 1024 / 1024)}MB까지).`);
    const b = file.bytes;
    if (!b.length) fail('파일이 비어 있습니다.');
    let result;
    if (startsWith(b, SIG.pdf)) result = await pdfText(b, baseUrl);
    else if (startsWith(b, SIG.zip)) result = await zipText(b, inflateRaw);
    else if (startsWith(b, SIG.cfb)) {
      const cfb = readCfb(b);
      result = await hwpText(cfb, inflateRaw);
      if (!result && cfb.paths.includes('WordDocument')) fail('옛 Word 형식(.doc)은 읽을 수 없습니다. Word에서 "다른 이름으로 저장 → .docx"로 저장하거나, 내용을 복사해 붙여 넣어 주세요.');
      if (!result) fail('이 파일 형식은 읽을 수 없습니다. 대본을 .txt·.pdf·.docx·.hwp 파일로 저장해 열어 주세요.');
    } else if (IMAGE_SIGS.some((sig) => startsWith(b, sig))) {
      fail('이미지 파일에서는 글자를 꺼낼 수 없습니다. 대본 문서(.txt·.pdf·.docx·.hwp)를 열어 주세요.');
    } else if (latin1(b.subarray(0, 5)) === '{\\rtf') {
      result = { format: 'rtf', text: rtfText(latin1(b)) };
    } else {
      const text = decodeText(b);
      if (looksBinary(text)) fail('이 파일은 글자로 읽을 수 없는 형식입니다. 대본을 .txt·.pdf·.docx·.hwp 파일로 저장해 열어 주세요.');
      result = { format: 'text', text };
    }
    const text = tidy(result.text);
    if (!text) fail('파일에서 글자를 찾지 못했습니다. 내용이 비어 있거나 그림으로만 된 문서일 수 있어요.');
    return { format: result.format, text };
  }

  // 파일 선택 창에서 고를 수 있게 할 확장자
  const ACCEPT = '.txt,.text,.md,.srt,.vtt,.csv,.rtf,.pdf,.docx,.hwp,.hwpx,.odt,text/plain,application/pdf';

  const api = { MAX_FILE_BYTES, ACCEPT, ImportError, extractScriptText, decodeText, xmlToText, readZip, readCfb, rtfText, pdfPageText, pdfPageRows, joinPdfRows, tidy };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FileImport = api;
})(this);
