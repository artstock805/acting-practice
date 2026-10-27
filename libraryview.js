// 무료 대본 서재 창: 공개 저작물 희곡 목록 → 작품을 고르면 전체 또는 막·장 하나를 대본 칸에 넣음.
// 아래에서 Gutenberg·위키문헌 작품 주소를 붙여 넣어 바로 불러오거나, 다른 사이트에서 파일로 받는 방법을 안내 (저작권은 사용자가 확인)
(function (root) {
  'use strict';

  // 주소를 붙여 넣으면 바로 불러올 수 있는 곳
  const IMPORT_SITES = [
    { name: 'Project Gutenberg 희곡 목록', lang: '영어', url: 'https://www.gutenberg.org/ebooks/bookshelf/642?sort_order=downloads' },
    { name: '위키문헌 희곡 목록', lang: '한국어', url: 'https://ko.wikisource.org/wiki/분류:희곡' },
  ];
  // 공유마당(한국저작권위원회) 작품 페이지. 사이트가 자동 내려받기를 막아서 파일은 사람이 직접 받음
  const gonguWorkUrl = (id) => `https://gongu.copyright.or.kr/gongu/wrt/wrt/view.do?wrtSn=${id}&menuNo=200019`;
  // 공유마당 「만료」 어문 저작물 중 '#희곡' 태그가 붙은 작품 (84편, 2026-10 기준). [작품 번호(wrtSn), 제목, 바로 불러오기 id(위키문헌·서재에 있으면)]
  const GONGU_PLAYS = [
    ['채만식', [[9001456, '간도행'], [9001459, '감독의 안해'], [9001449, '그의 가정풍경'], [9001446, '낙일'], [9001460, '낚시질판의 풍파'], [9001447, '농촌 스켓치'], [9001445, '당랑의 전설'], [9001452, '두부'], [9001461, '목침맞은 사또'], [9001450, '미가대폭락'], [9001448, '밥'], [9001462, '부촌'], [9001455, '사라지는 그림자'], [9001451, '스님과 새장수'], [9001454, '야생소년군'], [9001465, '영웅모집'], [9001467, '예수나 안믿었드면'], [9001464, '인테리와 빈대떡'], [9001444, '제향날'], [9001457, '조그마한 기업가'], [9001463, '조조'], [9001453, '코떼인 지사'], [9001458, '행랑들창에서 들리는 소리'], [9001466, '흘러간 고향']]],
    ['함세덕', [[9030902, '감자와 쪽제비와 여교원'], [9031524, '고목'], [9002039, '기미년3월1일'], [9002043, '낙화암'], [9002048, '닭과 아이들'], [9002034, '동승'], [9002044, '마을은 쾌청'], [9002042, '무의도 기행'], [9030904, '산사람들'], [9002033, '산허구리'], [9030903, '소위 대통령'], [9002052, '심원의 삽화'], [9002038, '에밀레종'], [9002049, '오월의 아침'], [9030901, '추석'], [9002037, '추장 이사베라'], [9030900, '해연']]],
    ['김정진', [[9021301, '15분간'], [9030939, '개'], [9030941, '그 사람들'], [9021304, '그리운 밤'], [9021306, '기적 불 때'], [9030938, '메아리'], [9021310, '사인의 심리'], [9030942, '약수풍경'], [9030940, '잔설'], [9021314, '전변'], [9021285, '찬 웃음']]],
    ['김우진', [[9000385, '난파'], [9000386, '두더기 시인의 환멸'], [9000387, '산돼지'], [9000388, '이영녀'], [9000389, '정오']]],
    ['박용철', [[9033075, '[낸] 의 비극'], [9033078, '기사와 서기'], [9033076, '바보'], [9033077, '베니스의 상인'], [9033079, '사랑의 기적 소품']]],
    ['방정환', [[9029597, '남녀 학교 소사 대화 이'], [9029596, '남녀 학교 소사 대화 일'], [9000552, '노래주머니', 'ws-노래 주머니']]],
    ['이무영', [[9035687, '벽'], [9035686, '톨스토이'], [9035685, '한낮에꿈꾸는사람들']]],
    ['홍사용', [[9002206, '출가'], [9002207, '할미꽃'], [9029390, '흰 젖', 'ws-흰 젖']]],
    ['권환', [[9018734, '광!'], [9018764, '인쇄한 러브레터', 'ws-인쇄한 러브레터']]],
    ['나정월', [[9000514, '백결생에게 답함'], [9000515, '파리의 그 여자']]],
    ['유지영', [[9030937, '연과 죄 (전3막)'], [9030936, '이상적 결혼 (전2막 3장)']]],
    ['조명희', [[9001326, '김영일의 사'], [9001327, '파사']]],
    ['김상용', [[9034030, '빈궁']]],
    ['박아지', [[9001028, '어머니와딸']]],
    ['박인환', [[9029505, '황금아Golden boy']]],
    ['이광수', [[9030935, '규한', 'gyuhan']]],
    ['이효석', [[9029968, '역사']]],
  ];
  // 파일로 받아 '📄 대본 파일 열기'로 넣는 곳
  const FILE_SITES = [
    { name: 'Internet Archive', desc: '오래된 희곡집. 작품 → 오른쪽 DOWNLOAD OPTIONS의 TEXT 또는 PDF → 📄 대본 파일 열기', url: 'https://archive.org/search?query=plays' },
  ];
  const MORE_SITES = [...IMPORT_SITES, ...FILE_SITES];

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

    const statusLine = () => {
      const p = el('p', { className: 'note import-status', hidden: true });
      const say = (text, isError) => { p.hidden = !text; p.textContent = text; p.classList.toggle('error', !!isError); };
      return [p, say];
    };
    const howTo = (text) => el('p', { className: 'library-howto', textContent: text });
    const openFileButton = () => {
      const b = el('button', { className: 'primary', type: 'button', textContent: '📄 받은 파일 열기' });
      b.hidden = !onOpenFile;
      b.onclick = () => { dialog.close(); onOpenFile(); };
      return b;
    };

    // 🔗 주소로: Gutenberg·위키문헌 목록 열기 → 작품 주소 복사 → 붙여 넣고 불러오기
    function addressPanel() {
      const siteRow = el('div', { className: 'library-sites' });
      IMPORT_SITES.forEach((site) => siteRow.append(el('a', { className: 'library-site', href: site.url, target: '_blank', rel: 'noopener noreferrer', textContent: `${site.name} (${site.lang}) ↗` })));
      const input = el('input', { type: 'url', className: 'library-address', placeholder: '작품 주소 또는 Gutenberg 책 번호', inputMode: 'url', autocomplete: 'off' });
      const [importStatus, say] = statusLine();
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
      return el('div', {},
        howTo('목록에서 작품을 고르고 → 주소를 복사해 → 아래에 붙여 넣으세요. (Gutenberg는 책 번호만 넣어도 돼요, 예: 1524)'),
        siteRow,
        el('div', { className: 'row library-import' }, input, paste, go),
        importStatus);
    }

    // 📜 공유마당: 만료 희곡 목록 (많이 쓴 작가는 따로, 나머지는 묶음). 제목은 작품 페이지로, ⚡는 바로 불러오기
    const GONGU_OWN_GROUP_MIN = 3;
    function gonguPanel() {
      const total = GONGU_PLAYS.reduce((n, [, list]) => n + list.length, 0);
      const [playsStatus, sayPlays] = statusLine();
      const quickRow = el('div', { className: 'library-sites' });
      GONGU_PLAYS.forEach(([, list]) => list.filter(([, , quick]) => quick).forEach(([, title, quick]) => {
        const now = el('button', { className: 'ghost library-play-quick', type: 'button', textContent: `⚡ ${title}` });
        now.onclick = () => load({ id: quick, title }, now, sayPlays);
        quickRow.append(now);
      }));
      const workLink = (id, title, author) => el('a', { className: 'library-play', href: gonguWorkUrl(id), target: '_blank', rel: 'noopener noreferrer', textContent: author ? `${title} (${author}) ↗` : `${title} ↗` });
      const group = (label, links) => el('details', { className: 'library-author' }, el('summary', { textContent: label }), el('div', { className: 'library-play-list' }, ...links));
      const big = GONGU_PLAYS.filter(([, list]) => list.length >= GONGU_OWN_GROUP_MIN);
      const rest = GONGU_PLAYS.filter(([, list]) => list.length < GONGU_OWN_GROUP_MIN).flatMap(([author, list]) => list.map((w) => [author, ...w]));
      const groups = el('div', { className: 'library-authors' },
        ...big.map(([author, list]) => group(`${author} (${list.length}편)`, list.map(([id, title]) => workLink(id, title)))),
        group(`그 밖의 작가 (${rest.length}편)`, rest.map(([author, id, title]) => workLink(id, title, author))));
      return el('div', {},
        el('p', { className: 'library-label', textContent: '⚡ 바로 불러오기' }),
        quickRow,
        playsStatus,
        el('p', { className: 'library-label', textContent: `📜 저작권이 끝난 희곡 ${total}편 — 작가를 누르면 작품이 나와요` }),
        howTo('제목을 누르면 공유마당 페이지가 열려요 → 「다운로드」 → 이 앱으로 돌아와 아래 버튼으로 여세요. (휴대폰은 보통 「다운로드」 폴더)'),
        groups,
        el('div', { className: 'row' }, openFileButton()));
    }

    // 📁 그 밖의 사이트: 파일로 받아 여는 곳
    function filePanel() {
      const fileList = el('ul', {});
      FILE_SITES.forEach((site) => fileList.append(el('li', {}, el('a', { href: site.url, target: '_blank', rel: 'noopener noreferrer', textContent: site.name + ' ↗' }), ` — ${site.desc}`)));
      return el('div', {}, howTo('파일(한글·PDF·TXT)로 받아서 아래 버튼으로 여세요.'), fileList, el('div', { className: 'row' }, openFileButton()));
    }

    // ➕ 다른 작품: 가져오는 방법별 탭 (한 번에 하나만 보임)
    function buildImport() {
      const tabs = [['address', '🔗 주소로', addressPanel()], ['gongu', '📜 공유마당', gonguPanel()], ['file', '📁 다른 사이트', filePanel()]];
      const tabRow = el('div', { className: 'row library-tabs', role: 'tablist' });
      const show = (key) => tabs.forEach(([k, , panel], i) => {
        panel.hidden = k !== key;
        tabRow.children[i].classList.toggle('active', k === key);
        tabRow.children[i].setAttribute('aria-selected', String(k === key));
      });
      tabs.forEach(([key, label]) => {
        const b = el('button', { className: 'ghost', type: 'button', textContent: label });
        b.setAttribute('role', 'tab');
        b.onclick = () => show(key);
        tabRow.append(b);
      });
      show('address');
      return el('details', { className: 'library-more' },
        el('summary', { textContent: '➕ 다른 작품 찾아서 불러오기' }),
        tabRow,
        ...tabs.map(([, , panel]) => panel),
        el('p', { className: 'note', textContent: '⚠ 직접 고른 작품은 작가·번역가가 세상을 떠난 지 70년이 넘었는지 확인하세요. 저작권이 남아 있으면 개인 연습용으로만 쓰세요.' }));
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

  root.LibraryView = { create, parseSourceAddress, gonguWorkUrl, GONGU_PLAYS, MORE_SITES };
})(this);
