// 작품 분석 화면: 작품 전체 초목표, 배역별 초목표 카드(직접 고칠 수 있음), 인물 관계도(SVG) 그리기·이미지 저장·텍스트 복사.
// 관계도는 인물을 원 둘레에 놓고 관계 종류마다 색이 다른 선으로 이음 (대사가 많을수록 원이 큼, 내 배역은 테두리 강조)
(function (root) {
  'use strict';

  // 이미지로 저장할 때도 같은 색이 나오게 CSS 변수 대신 색을 직접 씀
  const KIND_STYLE = {
    love: { label: '사랑', color: '#ff6b81' },
    family: { label: '가족', color: '#f5b041' },
    friend: { label: '우정', color: '#58d68d' },
    rival: { label: '경쟁', color: '#af7ac5', dash: '3 6' },
    hostile: { label: '적대', color: '#e74c3c', dash: '8 6' },
    work: { label: '일', color: '#5dade2' },
    other: { label: '기타', color: '#aab7b8' },
  };
  const COLORS = { bg: '#17130f', node: '#2d241c', nodeMine: '#e8573c', text: '#f4ecdc', muted: '#a8998a', label: '#231c16' };
  const FONT = "'Noto Sans KR', 'Malgun Gothic', sans-serif";
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const SIZE = 640;
  const MIN_NODE_R = 22;
  const MAX_NODE_R = 40;

  function el(tag, props, ...children) {
    const node = document.createElement(tag);
    Object.entries(props || {}).forEach(([k, v]) => { node[k] = v; });
    node.append(...children);
    return node;
  }

  function svgEl(tag, attrs, text) {
    const node = document.createElementNS(SVG_NS, tag);
    Object.entries(attrs || {}).forEach(([k, v]) => node.setAttribute(k, String(v)));
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // 인물 위치: 둘이면 좌우. 셋 이상이면 관계가 가장 많은 인물(중심 인물)을 가운데, 나머지를 원 둘레에 둠
  // (중심 인물을 둘레에 두면 선과 이름표가 한쪽으로 몰림)
  function layout(names, relationships) {
    const center = SIZE / 2;
    if (names.length === 1) return { pos: { [names[0]]: { x: center, y: center } }, hub: names[0] };
    if (names.length === 2) return { pos: { [names[0]]: { x: center - 170, y: center }, [names[1]]: { x: center + 170, y: center } }, hub: null };
    const degree = (n) => relationships.filter((r) => r.a === n || r.b === n).length;
    const hub = [...names].sort((a, b) => degree(b) - degree(a))[0];
    const ring = names.filter((n) => n !== hub);
    const radius = SIZE / 2 - 70;
    const pos = { [hub]: { x: center, y: center } };
    ring.forEach((n, i) => {
      const angle = -Math.PI / 2 + (2 * Math.PI * i) / ring.length;
      pos[n] = { x: center + radius * Math.cos(angle), y: center + radius * Math.sin(angle) };
    });
    return { pos, hub };
  }

  // relationships: [{a, b, kind, label, direction}], lineCounts: {이름: 대사 수}, mine: Set(내 배역)
  function drawGraph(relationships, lineCounts, mine) {
    const linked = new Set(relationships.flatMap((r) => [r.a, r.b]));
    const names = Object.keys(lineCounts).filter((n) => linked.has(n)).sort((a, b) => lineCounts[b] - lineCounts[a]);
    const svg = svgEl('svg', { viewBox: `0 0 ${SIZE} ${SIZE}`, xmlns: SVG_NS, role: 'img', 'aria-label': '인물 관계도', class: 'insight-graph' });
    svg.append(svgEl('rect', { x: 0, y: 0, width: SIZE, height: SIZE, fill: COLORS.bg, rx: 16 }));
    if (!names.length) {
      svg.append(svgEl('text', { x: SIZE / 2, y: SIZE / 2, fill: COLORS.muted, 'font-family': FONT, 'font-size': 18, 'text-anchor': 'middle' }, '관계 정보가 없어요'));
      return svg;
    }
    const { pos, hub } = layout(names, relationships);
    const maxLines = Math.max(...names.map((n) => lineCounts[n] || 1));
    const radiusOf = (n) => MIN_NODE_R + (MAX_NODE_R - MIN_NODE_R) * Math.sqrt((lineCounts[n] || 1) / maxLines);

    const defs = svgEl('defs');
    Object.entries(KIND_STYLE).forEach(([kind, s]) => {
      const marker = svgEl('marker', { id: 'arrow-' + kind, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' });
      marker.append(svgEl('path', { d: 'M0,0 L10,5 L0,10 z', fill: s.color }));
      defs.append(marker);
    });
    svg.append(defs);

    const edges = svgEl('g');
    const labels = svgEl('g');
    relationships.forEach((r) => {
      const a = pos[r.a];
      const b = pos[r.b];
      if (!a || !b) return;
      const style = KIND_STYLE[r.kind] || KIND_STYLE.other;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      const ra = radiusOf(r.a) + 4;
      const rb = radiusOf(r.b) + 4;
      const line = svgEl('line', {
        x1: a.x + (dx / len) * ra, y1: a.y + (dy / len) * ra, x2: b.x - (dx / len) * rb, y2: b.y - (dy / len) * rb,
        stroke: style.color, 'stroke-width': 3, 'stroke-linecap': 'round', opacity: 0.85,
        ...(style.dash ? { 'stroke-dasharray': style.dash } : {}),
      });
      if (r.direction === 'a_to_b') line.setAttribute('marker-end', `url(#arrow-${r.kind})`);
      if (r.direction === 'b_to_a') line.setAttribute('marker-start', `url(#arrow-${r.kind})`);
      edges.append(line);
      if (r.label) {
        const t = r.a === hub ? 0.6 : r.b === hub ? 0.4 : 0.5;
        const mx = a.x + dx * t;
        const my = a.y + dy * t;
        const width = Math.min(150, 14 * r.label.length + 16);
        labels.append(svgEl('rect', { x: mx - width / 2, y: my - 13, width, height: 26, rx: 13, fill: COLORS.label, stroke: style.color, 'stroke-width': 1.5 }));
        labels.append(svgEl('text', { x: mx, y: my + 5, fill: COLORS.text, 'font-family': FONT, 'font-size': 13, 'text-anchor': 'middle' }, r.label.slice(0, 10)));
      }
    });
    svg.append(edges, labels);

    names.forEach((n) => {
      const p = pos[n];
      const isMine = mine.has(n);
      svg.append(svgEl('circle', { cx: p.x, cy: p.y, r: radiusOf(n), fill: isMine ? COLORS.nodeMine : COLORS.node, stroke: isMine ? '#ffd2c8' : COLORS.muted, 'stroke-width': isMine ? 3 : 1.5 }));
      svg.append(svgEl('text', { x: p.x, y: p.y + 5, fill: COLORS.text, 'font-family': FONT, 'font-size': 15, 'font-weight': 700, 'text-anchor': 'middle' }, n.length > 5 ? n.slice(0, 5) + '…' : n));
    });
    return svg;
  }

  function legend(relationships) {
    const used = [...new Set(relationships.map((r) => r.kind))];
    const box = el('div', { className: 'insight-legend' });
    used.forEach((k) => {
      const s = KIND_STYLE[k] || KIND_STYLE.other;
      const swatch = el('span', { className: 'swatch' });
      swatch.style.background = s.dash ? `repeating-linear-gradient(90deg, ${s.color} 0 5px, transparent 5px 8px)` : s.color;
      box.append(el('span', { className: 'legend-item' }, swatch, s.label));
    });
    if (used.length) box.append(el('span', { className: 'legend-item' }, '→ 한쪽만 향하는 마음'));
    return box;
  }

  // 고칠 수 있는 칸: 바꾸면 onChange(값)으로 알려 줌
  function field(label, value, onChange, rows = 2) {
    const area = el('textarea', { value: value || '', rows, spellcheck: false });
    area.addEventListener('input', () => onChange(area.value));
    return el('label', { className: 'insight-field' }, el('span', { className: 'insight-label', textContent: label }), area);
  }

  // insight: 서버가 준 분석(사용자가 고친 내용 포함), opts: { lineCounts, mine, onEdit(경로, 값) }
  function render(container, insight, { lineCounts, mine, onEdit }) {
    container.textContent = '';
    if (!insight) return null;
    const playCard = el('section', { className: 'insight-card insight-play' },
      el('h3', { textContent: '🎭 작품 전체' }),
      field('초목표 (작품이 끝내 말하려는 것)', insight.play.super_objective, (v) => onEdit(['play', 'super_objective'], v)),
      field('주제', insight.play.theme, (v) => onEdit(['play', 'theme'], v), 1),
      field('관통행동 (극 전체를 꿰뚫는 행동)', insight.play.through_action, (v) => onEdit(['play', 'through_action'], v)),
      field('줄거리', insight.play.summary, (v) => onEdit(['play', 'summary'], v), 3));

    const graphBox = el('section', { className: 'insight-card' }, el('h3', { textContent: '🕸 인물 관계도' }));
    const svg = drawGraph(insight.relationships, lineCounts, mine);
    graphBox.append(svg, legend(insight.relationships));
    const notes = el('ul', { className: 'insight-relations' });
    insight.relationships.forEach((r) => notes.append(el('li', {},
      el('b', { textContent: `${r.a} ${arrowOf(r)} ${r.b}` }),
      ` ${r.label}${r.note ? ' — ' + r.note : ''}`)));
    graphBox.append(notes);

    const people = el('section', { className: 'insight-people' });
    const cards = insight.characters.map((c, i) => {
      const isMine = mine.has(c.name);
      const card = el('article', { className: 'insight-card' + (isMine ? ' is-mine' : '') },
        el('h3', { textContent: (isMine ? '⭐ ' : '') + c.name + (isMine ? ' (나)' : '') }),
        field('초목표', c.super_objective, (v) => onEdit(['characters', i, 'super_objective'], v)),
        field('관통행동', c.through_action, (v) => onEdit(['characters', i, 'through_action'], v)),
        field('장애물', c.obstacle, (v) => onEdit(['characters', i, 'obstacle'], v)));
      if (c.evidence.length) {
        const quotes = el('ul', { className: 'insight-evidence' });
        c.evidence.forEach((q) => quotes.append(el('li', { textContent: '“' + q + '”' })));
        card.append(el('span', { className: 'insight-label', textContent: '근거 대사' }), quotes);
      }
      return { card, isMine };
    });
    // 내 배역 카드를 먼저
    cards.filter((c) => c.isMine).concat(cards.filter((c) => !c.isMine)).forEach((c) => people.append(c.card));

    container.append(playCard, graphBox, el('h3', { className: 'insight-section-title', textContent: '👤 배역별 초목표' }), people);
    return svg;
  }

  const arrowOf = (r) => (r.direction === 'mutual' ? '↔' : r.direction === 'a_to_b' ? '→' : '←');

  // 관계도를 PNG 파일로 내려받기 (글꼴은 기기 글꼴로 그려짐)
  function saveGraphImage(svg, fileName = '인물관계도.png') {
    const scale = 2;
    const data = new XMLSerializer().serializeToString(svg);
    const url = URL.createObjectURL(new Blob([data], { type: 'image/svg+xml;charset=utf-8' }));
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = SIZE * scale;
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        canvas.toBlob((blob) => {
          if (!blob) return reject(new Error('이미지를 만들지 못했어요'));
          const link = el('a', { href: URL.createObjectURL(blob), download: fileName });
          document.body.append(link);
          link.click();
          link.remove();
          setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
          resolve();
        }, 'image/png');
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('이미지를 만들지 못했어요')); };
      img.src = url;
    });
  }

  // 노션·메신저에 붙여 넣기 좋은 텍스트
  function toText(insight, mine) {
    const lines = ['# 작품 분석', '', '## 작품 전체',
      `- 초목표: ${insight.play.super_objective}`, `- 주제: ${insight.play.theme}`,
      `- 관통행동: ${insight.play.through_action}`, `- 줄거리: ${insight.play.summary}`, '', '## 배역별 초목표'];
    insight.characters.forEach((c) => {
      lines.push(`### ${c.name}${mine.has(c.name) ? ' (나)' : ''}`, `- 초목표: ${c.super_objective}`, `- 관통행동: ${c.through_action}`, `- 장애물: ${c.obstacle}`);
      if (c.evidence.length) lines.push(`- 근거 대사: ${c.evidence.map((q) => '“' + q + '”').join(' / ')}`);
    });
    lines.push('', '## 인물 관계');
    insight.relationships.forEach((r) => lines.push(`- ${r.a} ${arrowOf(r)} ${r.b}: ${r.label}${r.note ? ' — ' + r.note : ''}`));
    return lines.join('\n');
  }

  root.InsightView = { render, drawGraph, saveGraphImage, toText, KIND_STYLE };
})(this);
