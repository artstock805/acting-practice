// 무료 대본 서재 창: 공개 저작물 희곡 목록 → 작품을 고르면 전체 또는 막·장 하나를 대본 칸에 넣음.
// 아래에는 공개 저작물 대본을 더 찾아볼 수 있는 사이트 링크 (저작권은 사용자가 확인)
(function (root) {
  'use strict';

  const MORE_SITES = [
    { name: 'Project Gutenberg', desc: '영어 공개 저작물 희곡·문학 (셰익스피어, 체호프, 입센 등)', url: 'https://www.gutenberg.org/ebooks/search/?query=drama' },
    { name: 'Wikisource (영어)', desc: '영어 희곡 원문 모음', url: 'https://en.wikisource.org/wiki/Portal:Drama' },
    { name: '위키문헌 희곡', desc: '한국어 공개 저작물 희곡 (일제강점기 신극 등)', url: 'https://ko.wikisource.org/wiki/분류:희곡' },
    { name: '공유마당', desc: '한국저작권위원회의 만료·기증 저작물 검색', url: 'https://gongu.copyright.or.kr/' },
    { name: 'Internet Archive', desc: '오래된 희곡집 스캔본·텍스트', url: 'https://archive.org/search?query=plays' },
  ];

  function el(tag, props, ...children) {
    const node = document.createElement(tag);
    Object.entries(props || {}).forEach(([k, v]) => { node[k] = v; });
    node.append(...children);
    return node;
  }

  const lineCount = (text) => text.split('\n').filter((l) => /^[^()\s][^:]{0,30}:\s|^[A-Z][A-Z .'’-]+$/.test(l.trim())).length;

  // dialog: <dialog> 요소, onPick({ text, lang, title }) 고르면 불러옴
  function create(dialog, { onPick }) {
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

    async function load(work, button) {
      button.disabled = true;
      setStatus(`📥 「${work.titleKo || work.title}」을(를) 받아 오는 중…`);
      try {
        const res = await fetch('/api/library/' + encodeURIComponent(work.id));
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || `받아 오지 못했어요 (${res.status})`);
        showSections(body);
        setStatus('');
      } catch (err) {
        setStatus('⚠ ' + err.message, true);
      } finally {
        button.disabled = false;
      }
    }

    // 긴 작품은 막·장 하나만 골라 불러올 수 있게 (휴대폰에서 빠르고, AI 분석 한도에도 맞음)
    function showSections(work) {
      sections.textContent = '';
      sections.append(el('p', { className: 'merge-title', textContent: `「${work.titleKo || work.title}」 어디를 불러올까요?` }));
      const choices = work.sections.length > 1 ? [{ title: '전체', text: work.text }, ...work.sections] : [{ title: '전체', text: work.text }];
      const row = el('div', { className: 'row' });
      choices.forEach((s) => {
        const b = el('button', { className: s.title === '전체' ? 'ghost' : 'primary', type: 'button', textContent: `${s.title} (대사 ${lineCount(s.text)}줄)` });
        b.onclick = () => { onPick({ text: s.text, lang: work.lang, title: `${work.titleKo || work.title}${s.title === '전체' ? '' : ' · ' + s.title}` }); dialog.close(); };
        row.append(b);
      });
      sections.append(row);
      sections.hidden = false;
      sections.scrollIntoView({ block: 'nearest' });
    }

    const more = el('details', { className: 'library-more' }, el('summary', { textContent: '🔎 더 찾아보기 (다른 공개 저작물 사이트)' }));
    const links = el('ul', {});
    MORE_SITES.forEach((s) => links.append(el('li', {}, el('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer', textContent: s.name }), ` — ${s.desc}`)));
    more.append(links, el('p', { className: 'note', textContent: '⚠ 다른 사이트의 대본은 저작권이 끝났는지(작가·번역가 사망 후 70년 등) 꼭 확인하고, 받은 파일은 📄 대본 파일 열기로 불러오세요. 저작권이 있는 대본은 개인 연습용으로만 쓰고 공유하지 마세요.' }));

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

  root.LibraryView = { create, MORE_SITES };
})(this);
