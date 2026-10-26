// 무료 대본 서재 창: 공개 저작물 희곡 목록 → 작품을 고르면 전체 또는 막·장 하나를 대본 칸에 넣음.
// 아래에서 Gutenberg·위키문헌 작품 주소를 붙여 넣어 바로 불러오거나, 다른 사이트에서 파일로 받는 방법을 안내 (저작권은 사용자가 확인)
(function (root) {
  'use strict';

  // 주소를 붙여 넣으면 바로 불러올 수 있는 곳
  const IMPORT_SITES = [
    { name: 'Project Gutenberg 희곡 목록', lang: '영어', url: 'https://www.gutenberg.org/ebooks/bookshelf/642?sort_order=downloads' },
    { name: '위키문헌 희곡 목록', lang: '한국어', url: 'https://ko.wikisource.org/wiki/분류:희곡' },
  ];
  // 공유마당(한국저작권위원회): 어문 저작물에서 '희곡'으로 검색한 결과. 사이트가 자동 내려받기를 막아서 파일은 사람이 직접 받음
  const GONGU_SEARCH = { name: '공유마당 희곡 검색', lang: '한국어', url: 'https://gongu.copyright.or.kr/gongu/wrt/wrtCl/listWrtText.do?menuNo=200019&searchKeyword=%ED%9D%AC%EA%B3%A1' };
  // 파일로 받아 '📄 대본 파일 열기'로 넣는 곳
  const FILE_SITES = [
    { name: 'Internet Archive', desc: '오래된 희곡집. 작품 → 오른쪽 DOWNLOAD OPTIONS의 TEXT 또는 PDF → 📄 대본 파일 열기', url: 'https://archive.org/search?query=plays' },
  ];
  const MORE_SITES = [...IMPORT_SITES, GONGU_SEARCH, ...FILE_SITES];

  // 붙여 넣은 주소 → 서버가 알아보는 작품 id (gb-책번호 / ws-위키문헌 제목). 모르는 주소는 null
  function parseSourceAddress(input) {
    const s = String(input || '').trim();
    const gb = /gutenberg\.org\/(?:ebooks|cache\/epub|files)\/(\d{1,6})\b/i.exec(s) || /^#?(\d{1,6})$/.exec(s);
    if (gb) return 'gb-' + gb[1];
    const ws = /ko(?:\.m)?\.wikisource\.org\/wiki\/([^?#]+)/i.exec(s);
    if (!ws) return null;
    try { return 'ws-' + decodeURIComponent(ws[1]).replace(/_/g, ' ').trim(); } catch { return null; }
  }

  function el(tag, props, ...children) {
    const node = document.createElement(tag);
    Object.entries(props || {}).forEach(([k, v]) => { node[k] = v; });
    node.append(...children);
    return node;
  }

  const lineCount = (text) => text.split('\n').filter((l) => /^[^()\s][^:]{0,30}:\s|^[A-Z][A-Z .'’-]+$/.test(l.trim())).length;

  // dialog: <dialog> 요소, onPick({ text, lang, title, custom }) 고르면 불러옴 (custom: 사용자가 주소로 가져온 작품)
  // onOpenFile(): 앱의 '📄 대본 파일 열기'를 엶 (공유마당 등에서 받은 파일용)
  function create(dialog, { onPick, onOpenFile }) {
    const status = el('p', { className: 'note import-status', hidden: true });
    const list = el('div', { className: 'library-list' });
    const sections = el('div', { className: 'library-sections', hidden: true });
    let works = [];
    let filter = 'all';

    const setStatus = (text, isError) => { status.hidden = !text; status.textContent = text; status.classList.toggle('error', !!isError); };

    const filters = el('div', { className: 'row library-filters' });
    [['all', '전체'], ['ko', '한국어'], ['en', 'English']].forEach(([key, label]) => {
      const b = el('button', { className: 'ghost', textContent: label, type: 'button' });
      b.dataset.filter = key;
      b.onclick = () => { filter = key; renderList(); };
      filters.append(b);
    });

    function renderList() {
      filters.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.filter === filter));
      list.textContent = '';
      sections.hidden = true;
      works.filter((w) => filter === 'all' || w.lang === filter).forEach((w) => {
        const pick = el('button', { className: 'primary', textContent: '불러오기', type: 'button' });
        pick.onclick = () => load(w, pick);
        const title = w.titleKo && w.titleKo !== w.title ? `${w.title} · ${w.titleKo}` : w.title;
        list.append(el('article', { className: 'library-item' },
          el('div', {},
            el('b', { textContent: title }),
            el('div', { className: 'note', textContent: `${w.author} · ${w.year} · ${w.lang === 'en' ? 'English' : '한국어'}` }),
            el('div', { className: 'note', textContent: `✅ 공개 저작물: ${w.rights} · 출처 ${w.sourceName}` })),
          pick));
      });
    }

    async function load(work, button, statusLine = setStatus) {
      button.disabled = true;
      statusLine(`📥 「${work.titleKo || work.title}」을(를) 받아 오는 중…`);
      try {
        const res = await fetch('/api/library/' + encodeURIComponent(work.id));
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || `받아 오지 못했어요 (${res.status})`);
        statusLine('');
        showSections(body);
      } catch (err) {
        statusLine('⚠ ' + err.message, true);
      } finally {
        button.disabled = false;
      }
    }

    // 긴 작품은 막·장 하나만 골라 불러올 수 있게 (휴대폰에서 빠르고, AI 분석 한도에도 맞음)
    function showSections(work) {
      sections.textContent = '';
      sections.append(el('p', { className: 'merge-title', textContent: `「${work.titleKo || work.title}」 어디를 불러올까요?` }));
      if (work.custom) sections.append(el('p', { className: 'note', textContent: '⚠ 직접 고른 작품이에요. 작가·번역가가 세상을 떠난 지 70년이 넘었는지(한국은 1963년 이전 사망) 확인하고, 저작권이 남아 있으면 개인 연습용으로만 쓰세요.' }));
      const choices = work.sections.length > 1 ? [{ title: '전체', text: work.text }, ...work.sections] : [{ title: '전체', text: work.text }];
      const row = el('div', { className: 'row' });
      choices.forEach((s) => {
        const b = el('button', { className: s.title === '전체' ? 'ghost' : 'primary', type: 'button', textContent: `${s.title} (대사 ${lineCount(s.text)}줄)` });
        b.onclick = () => { onPick({ text: s.text, lang: work.lang, custom: !!work.custom, title: `${work.titleKo || work.title}${s.title === '전체' ? '' : ' · ' + s.title}` }); dialog.close(); };
        row.append(b);
      });
      sections.append(row);
      sections.hidden = false;
      sections.scrollIntoView({ block: 'nearest' });
    }

    // ➕ 다른 작품: 목록 사이트 열기 → 주소 복사 → 붙여 넣고 불러오기
    function buildImport() {
      const box = el('details', { className: 'library-more' }, el('summary', { textContent: '➕ 다른 작품 찾아서 불러오기' }));
      const step = (n, text) => el('p', { className: 'library-step' }, el('b', { textContent: n + ' ' }), text);
      const siteRow = el('div', { className: 'library-sites' });
      IMPORT_SITES.forEach((site) => siteRow.append(el('a', { className: 'library-site', href: site.url, target: '_blank', rel: 'noopener noreferrer', textContent: `${site.name} (${site.lang}) ↗` })));
      const input = el('input', { type: 'url', className: 'library-address', placeholder: '예) https://www.gutenberg.org/ebooks/1524', inputMode: 'url', autocomplete: 'off' });
      const importStatus = el('p', { className: 'note import-status', hidden: true });
      const say = (text, isError) => { importStatus.hidden = !text; importStatus.textContent = text; importStatus.classList.toggle('error', !!isError); };
      const go = el('button', { className: 'primary', type: 'button', textContent: '불러오기' });
      const paste = el('button', { className: 'ghost', type: 'button', textContent: '📋 붙여넣기' });
      paste.hidden = !(navigator.clipboard && navigator.clipboard.readText);
      paste.onclick = async () => {
        try { input.value = (await navigator.clipboard.readText()).trim(); go.click(); }
        catch { say('붙여넣기를 할 수 없어요. 칸을 길게 눌러 직접 붙여 넣어 주세요.', true); }
      };
      go.onclick = () => {
        const id = parseSourceAddress(input.value);
        if (!id) return say('Project Gutenberg(gutenberg.org/ebooks/숫자) 또는 위키문헌(ko.wikisource.org/wiki/제목) 작품 주소를 넣어 주세요.', true);
        return load({ id, title: id.startsWith('gb-') ? `Gutenberg #${id.slice(3)}` : id.slice(3) }, go, say);
      };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go.click(); } });
      const fileList = el('ul', {});
      FILE_SITES.forEach((site) => fileList.append(el('li', {}, el('a', { href: site.url, target: '_blank', rel: 'noopener noreferrer', textContent: site.name + ' ↗' }), ` — ${site.desc}`)));
      const openFile = el('button', { className: 'primary', type: 'button', textContent: '📄 받은 파일 열기' });
      openFile.hidden = !onOpenFile;
      openFile.onclick = () => { dialog.close(); onOpenFile(); };
      const gongu = el('div', { className: 'library-gongu' },
        el('p', { className: 'library-step' }, el('b', { textContent: '📁 공유마당에서 파일로 받기 ' }), '(한국어 희곡)'),
        el('div', { className: 'library-sites' }, el('a', { className: 'library-site', href: GONGU_SEARCH.url, target: '_blank', rel: 'noopener noreferrer', textContent: `${GONGU_SEARCH.name} ↗` })),
        step('①', '검색 결과에서 작품을 누르세요'),
        step('②', '작품 페이지에서 이용 조건을 확인하세요'),
        el('p', { className: 'note', textContent: '「만료」는 저작권이 끝난 작품이라 자유롭게 연습할 수 있어요. 「CC」·「기증」 표시는 적힌 조건(출처 표시 등) 안에서 쓸 수 있어요. 아무 표시가 없거나 상업적 이용 금지 등 조건이 있으면 개인 연습용으로만 쓰세요.' }),
        step('③', '「다운로드」를 눌러 파일(한글·PDF·TXT)을 받으세요'),
        step('④', '이 앱으로 돌아와 받은 파일을 여세요'),
        el('div', { className: 'row' }, openFile),
        el('p', { className: 'note', textContent: '휴대폰에서는 받은 파일이 보통 「다운로드」 폴더에 있어요.' }));
      box.append(
        step('①', '아래 목록에서 희곡을 고르세요 (새 창으로 열려요)'),
        siteRow,
        step('②', '작품 페이지가 열리면 위쪽 주소창의 주소를 복사하세요'),
        el('p', { className: 'note', textContent: 'Gutenberg는 책 번호만 넣어도 돼요 (예: 1524). 위키문헌은 작품 제목을 누른 페이지의 주소.' }),
        step('③', '이 앱으로 돌아와 주소를 붙여 넣고 불러오기'),
        el('div', { className: 'row library-import' }, input, paste, go),
        importStatus,
        el('p', { className: 'note', textContent: '⚠ 목록에는 저작권이 남은 번역본도 섞여 있어요. 작가·번역가가 세상을 떠난 지 70년이 넘었는지 확인하고, 저작권이 있는 대본은 개인 연습용으로만 쓰고 공유하지 마세요.' }),
        gongu,
        el('p', { className: 'library-step' }, el('b', { textContent: '그 밖의 사이트 ' }), '(파일로 받아 📄 대본 파일 열기로 넣기)'),
        fileList);
      return box;
    }
    const more = buildImport();

    dialog.append(
      el('h2', { textContent: '📚 무료 대본 서재' }),
      el('p', { className: 'note', textContent: '저작권이 끝난 공개 저작물 희곡을 바로 불러와 연습할 수 있어요. 작가(번역본은 번역가도)가 세상을 떠난 지 70년이 넘어 한국·미국 등 대부분 나라에서 자유롭게 쓸 수 있는 작품만 모았습니다.' }),
      filters, status, list, sections, more,
      el('form', { method: 'dialog' }, el('button', { className: 'ghost', textContent: '닫기' })));

    return {
      async open() {
        dialog.showModal();
        if (works.length) return renderList();
        setStatus('📚 목록을 불러오는 중…');
        try {
          const res = await fetch('/api/library');
          if (!res.ok) throw new Error(`목록을 받지 못했어요 (${res.status})`);
          works = (await res.json()).works || [];
          setStatus('');
          renderList();
        } catch (err) {
          setStatus('⚠ ' + err.message + ' 인터넷 연결을 확인해 주세요.', true);
        }
      },
    };
  }

  root.LibraryView = { create, parseSourceAddress, MORE_SITES };
})(this);
