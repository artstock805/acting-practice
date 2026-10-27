// 📊 연습 기록 창: 오늘 요약, 최근 7일 막대, 이 대본의 약한 대사, 자주 틀린 낱말
(function (root) {
  'use strict';

  const WEEK = 7;
  const WEAK_SHOWN = 5;
  const WORDS_SHOWN = 10;
  const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

  function el(tag, props, ...children) {
    const node = document.createElement(tag);
    Object.entries(props || {}).forEach(([k, v]) => { node[k] = v; });
    node.append(...children);
    return node;
  }

  const minutes = (ms) => (ms < 60_000 ? (ms ? '1분 미만' : '0분') : `${Math.round(ms / 60_000)}분`);
  const percent = (x) => (x === null || x === undefined ? '–' : `${Math.round(x * 100)}%`);

  function tile(label, value) {
    return el('div', { className: 'stats-tile' }, el('span', { className: 'note', textContent: label }), el('b', { textContent: value }));
  }

  function weekChart(days) {
    const most = Math.max(1, ...days.map((d) => d.lines));
    const chart = el('div', { className: 'stats-week', role: 'img', ariaLabel: '최근 7일 말한 대사 수' });
    days.forEach((d) => {
      const [y, m, day] = d.date.split('-').map(Number);
      const bar = el('div', { className: 'stats-bar' });
      bar.style.height = d.lines ? `${Math.max(4, Math.round((d.lines / most) * 100))}%` : '0';
      bar.title = `${m}/${day} · 대사 ${d.lines}개 · 평균 ${percent(d.avg)} · ${minutes(d.ms)}`;
      chart.append(el('div', { className: 'stats-day' },
        el('span', { className: 'stats-count', textContent: d.lines || '' }),
        el('div', { className: 'stats-track' }, bar),
        el('span', { className: 'note', textContent: WEEKDAYS[new Date(y, m - 1, day).getDay()] })));
    });
    return chart;
  }

  // dialog: <dialog>, log: PracticeLog, weak: [{ who, text, last, tries }], onPracticeWeak(): 약한 대사만 연습 시작
  function render(dialog, { log, weak, onPracticeWeak }) {
    const today = log.today();
    const body = el('div', { className: 'stats-body' });
    body.append(
      el('h2', { textContent: '📊 연습 기록' }),
      el('p', { className: 'library-label', textContent: '오늘' }),
      el('div', { className: 'stats-tiles' },
        tile('연습 시간', minutes(today.ms)),
        tile('말한 대사', `${today.lines}개`),
        tile('통과', today.lines ? `${Math.round((today.passed / today.lines) * 100)}%` : '–'),
        tile('평균 점수', percent(today.avg))),
      el('p', { className: 'library-label', textContent: '최근 7일 (말한 대사 수)' }),
      weekChart(log.days(WEEK)));

    body.append(el('p', { className: 'library-label', textContent: `이 대본의 약한 대사 (${weak.length}개)` }));
    if (weak.length) {
      const list = el('ol', { className: 'stats-weak' });
      weak.slice().sort((a, b) => a.last - b.last).slice(0, WEAK_SHOWN).forEach((w) => list.append(el('li', {},
        el('b', { textContent: w.who + ' ' }), w.text.length > 40 ? w.text.slice(0, 40) + '…' : w.text,
        el('span', { className: 'note', textContent: ` — 마지막 ${percent(w.last)} · ${w.tries}번` }))));
      const go = el('button', { className: 'primary', type: 'button', textContent: '⚠ 약한 대사만 연습하기' });
      go.onclick = () => { dialog.close(); onPracticeWeak(); };
      body.append(list, el('div', { className: 'row' }, go));
    } else {
      body.append(el('p', { className: 'note', textContent: '통과 기준보다 낮게 나온 대사가 없어요. 연습하면 여기에 모여요.' }));
    }

    const words = log.topMissed(WORDS_SHOWN);
    body.append(el('p', { className: 'library-label', textContent: '자주 틀린 낱말' }));
    body.append(words.length
      ? el('div', { className: 'stats-words' }, ...words.map((w) => el('span', { className: 'stats-word', textContent: `${w.word} ${w.count}` })))
      : el('p', { className: 'note', textContent: '아직 없어요.' }));

    const clear = el('button', { className: 'ghost', type: 'button', textContent: '기록 지우기' });
    clear.onclick = () => {
      if (!root.confirm('연습 기록(날짜별 통계·틀린 낱말)을 모두 지울까요?')) return;
      log.clear();
      render(dialog, { log, weak, onPracticeWeak });
    };
    body.append(el('p', { className: 'note', textContent: '기록은 이 휴대폰·PC에만 저장돼요 (최근 60일).' }),
      el('div', { className: 'row stats-actions' }, clear, el('span', { className: 'spacer' }),
        el('form', { method: 'dialog' }, el('button', { className: 'primary', textContent: '닫기' }))));
    dialog.replaceChildren(body);
    if (!dialog.open) dialog.showModal();
  }

  root.StatsView = { render };
})(this);
