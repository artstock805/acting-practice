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
  const COLORS = { bg: '#17191e', node: '#23262e', nodeMine: '#ff5d5d', text: '#e9eaee', muted: '#8b8f99', label: '#0e0f12' };
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

  // ---------- 선·이름표 배치 (겹치지 않게) ----------
  const LABEL_H = 26;
  const LABEL_MAX_CHARS = 12;
  const CURVE_SAMPLES = 60;
  const PAIR_GAP = 46;        // 같은 두 인물 사이 관계가 여럿이면 선을 이만큼씩 벌림
  const NODE_CLEARANCE = 10;  // 선이 다른 인물 원에서 떨어질 거리
  const BEND_STEPS = [0, 50, -50, 100, -100, 150, -150, 200, -200];
  // 이름표 후보: 선을 따라 가운데부터 바깥으로, 선에서 비켜도 자기 선에 붙어 보일 만큼만
  const LABEL_TS = [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6, -6].map((k) => 0.5 + k * 0.06);
  const LABEL_SHIFTS = [0, 22, -22, 36, -36];
  const HARD = 1000;          // 인물 원·다른 이름표·그림 밖과 겹침
  const CROSS = 50;           // 다른 선이 이름표 밑을 지나감 (점 하나당)

  const labelText = (s) => { const t = String(s || ''); return t.length > LABEL_MAX_CHARS ? t.slice(0, LABEL_MAX_CHARS - 1) + '…' : t; };
  const labelWidth = (text) => 13.5 * text.length + 18;
  const quad = (p, c, q, t) => ({ x: (1 - t) * (1 - t) * p.x + 2 * (1 - t) * t * c.x + t * t * q.x, y: (1 - t) * (1 - t) * p.y + 2 * (1 - t) * t * c.y + t * t * q.y });
  const toward = (from, to, dist) => { const d = Math.hypot(to.x - from.x, to.y - from.y) || 1; return { x: from.x + ((to.x - from.x) / d) * dist, y: from.y + ((to.y - from.y) / d) * dist }; };
  const circleHitsRect = (c, rect, margin) => {
    const nx = Math.max(rect.x, Math.min(c.x, rect.x + rect.w));
    const ny = Math.max(rect.y, Math.min(c.y, rect.y + rect.h));
    return Math.hypot(c.x - nx, c.y - ny) < c.r + margin;
  };
  const rectsOverlap = (p, q, m) => p.x < q.x + q.w + m && q.x < p.x + p.w + m && p.y < q.y + q.h + m && q.y < p.y + p.h + m;
  const inRect = (pt, r) => pt.x > r.x && pt.x < r.x + r.w && pt.y > r.y && pt.y < r.y + r.h;

  // a→b를 bend만큼 휜 곡선 (bend 0이면 직선). 양 끝은 인물 원 바깥에서 시작·끝
  function curve(a, b, bend) {
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const normal = { x: -(b.y - a.y) / len, y: (b.x - a.x) / len };
    const ctrl = { x: (a.x + b.x) / 2 + normal.x * bend * 2, y: (a.y + b.y) / 2 + normal.y * bend * 2 };
    const start = toward(a, ctrl, a.r + 4);
    const end = toward(b, ctrl, b.r + 4);
    const points = Array.from({ length: CURVE_SAMPLES + 1 }, (_, i) => quad(start, ctrl, end, i / CURVE_SAMPLES));
    return { start, ctrl, end, points, normal };
  }

  // 다른 인물 원과 가장 가까운 거리 (클수록 좋음)
  const clearance = (points, others) => Math.min(Infinity, ...others.flatMap((c) => points.map((p) => Math.hypot(p.x - c.x, p.y - c.y) - c.r)));

  // 관계마다 곡선 고르기: 같은 쌍의 관계는 나란히 벌리고, 다른 인물 원을 지나가면 비켜 휨
  function planEdges(relationships, nodes) {
    const pairKey = (r) => [r.a, r.b].sort().join('\u0000');
    const pairTotal = new Map();
    const pairSeen = new Map();
    relationships.forEach((r) => pairTotal.set(pairKey(r), (pairTotal.get(pairKey(r)) || 0) + 1));
    return relationships.filter((r) => nodes[r.a] && nodes[r.b] && r.a !== r.b).map((r) => {
      const key = pairKey(r);
      const k = pairSeen.get(key) || 0;
      pairSeen.set(key, k + 1);
      // a·b 순서가 반대인 관계도 같은 기준으로 벌어지게 이름 순서로 방향을 맞춤
      const flip = [r.a, r.b].sort()[0] === r.a ? 1 : -1;
      const base = (k - (pairTotal.get(key) - 1) / 2) * PAIR_GAP * flip;
      const others = Object.entries(nodes).filter(([n]) => n !== r.a && n !== r.b).map(([, c]) => c);
      let best = null;
      for (const step of BEND_STEPS) {
        const c = { ...curve(nodes[r.a], nodes[r.b], base + step) };
        c.room = clearance(c.points, others);
        if (!best || c.room > best.room) best = c;
        if (c.room > NODE_CLEARANCE) { best = c; break; }
      }
      return { rel: r, ...best };
    });
  }

  // 이름표 자리 고르기: 자기 선 위나 바로 옆에서, 인물 원·다른 이름표·다른 선과 겹치지 않는 곳
  function placeLabels(edges, nodes, size) {
    const circles = Object.values(nodes);
    const placed = [];
    // 긴 이름표부터 자리를 잡아야 짧은 것이 남은 틈에 들어감
    const order = edges.map((e, i) => i).sort((i, j) => labelText(edges[j].rel.label).length - labelText(edges[i].rel.label).length);
    order.forEach((i) => {
      const e = edges[i];
      const text = labelText(e.rel.label);
      if (!text) return;
      const w = labelWidth(text);
      let best = null;
      LABEL_TS.forEach((t, ti) => LABEL_SHIFTS.forEach((shift) => {
        const p = quad(e.start, e.ctrl, e.end, t);
        const rect = { x: p.x + e.normal.x * shift - w / 2, y: p.y + e.normal.y * shift - LABEL_H / 2, w, h: LABEL_H, text };
        let score = ti + Math.abs(shift) * 0.3;
        if (rect.x < 4 || rect.y < 4 || rect.x + w > size - 4 || rect.y + LABEL_H > size - 4) score += HARD;
        circles.forEach((c) => { if (circleHitsRect(c, rect, 4)) score += HARD; });
        placed.forEach((q) => { if (rectsOverlap(rect, q, 4)) score += HARD; });
        edges.forEach((f) => { if (f !== e) f.points.forEach((pt) => { if (inRect(pt, rect)) score += CROSS; }); });
        if (!best || score < best.score) best = { rect, score };
      }));
      e.label = best.rect;
      placed.push(best.rect);
    });
    return edges;
  }

  // 그림 없이 위치만 계산 (그리기·테스트 공용)
  // 반환: { size, hub, nodes: {이름: {x, y, r}}, edges: [{rel, start, ctrl, end, points, label: {x, y, w, h, text}}] }
  function planGraph(relationships, lineCounts) {
    const linked = new Set(relationships.flatMap((r) => [r.a, r.b]));
    const names = Object.keys(lineCounts).filter((n) => linked.has(n)).sort((a, b) => lineCounts[b] - lineCounts[a]);
    if (!names.length) return { size: SIZE, hub: null, nodes: {}, edges: [] };
    const { pos, hub } = layout(names, relationships);
    const maxLines = Math.max(...names.map((n) => lineCounts[n] || 1));
    const nodes = {};
    names.forEach((n) => { nodes[n] = { ...pos[n], r: MIN_NODE_R + (MAX_NODE_R - MIN_NODE_R) * Math.sqrt((lineCounts[n] || 1) / maxLines) }; });
    return { size: SIZE, hub, nodes, edges: placeLabels(planEdges(relationships, nodes), nodes, SIZE) };
  }

  // relationships: [{a, b, kind, label, direction}], lineCounts: {이름: 대사 수}, mine: Set(내 배역)
  function drawGraph(relationships, lineCounts, mine) {
    const svg = svgEl('svg', { viewBox: `0 0 ${SIZE} ${SIZE}`, xmlns: SVG_NS, role: 'img', 'aria-label': '인물 관계도', class: 'insight-graph' });
    svg.append(svgEl('rect', { x: 0, y: 0, width: SIZE, height: SIZE, fill: COLORS.bg, rx: 16 }));
    const plan = planGraph(relationships, lineCounts);
    const names = Object.keys(plan.nodes);
    if (!names.length) {
      svg.append(svgEl('text', { x: SIZE / 2, y: SIZE / 2, fill: COLORS.muted, 'font-family': FONT, 'font-size': 18, 'text-anchor': 'middle' }, '관계 정보가 없어요'));
      return svg;
    }

    const defs = svgEl('defs');
    Object.entries(KIND_STYLE).forEach(([kind, s]) => {
      const marker = svgEl('marker', { id: 'arrow-' + kind, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' });
      marker.append(svgEl('path', { d: 'M0,0 L10,5 L0,10 z', fill: s.color }));
      defs.append(marker);
    });
    svg.append(defs);

    const edges = svgEl('g');
    const labels = svgEl('g');
    plan.edges.forEach(({ rel: r, start, ctrl, end, label }) => {
      const style = KIND_STYLE[r.kind] || KIND_STYLE.other;
      const line = svgEl('path', {
        d: `M${start.x},${start.y} Q${ctrl.x},${ctrl.y} ${end.x},${end.y}`, fill: 'none',
        stroke: style.color, 'stroke-width': 3, 'stroke-linecap': 'round', opacity: 0.85,
        ...(style.dash ? { 'stroke-dasharray': style.dash } : {}),
      });
      if (r.direction === 'a_to_b') line.setAttribute('marker-end', `url(#arrow-${r.kind})`);
      if (r.direction === 'b_to_a') line.setAttribute('marker-start', `url(#arrow-${r.kind})`);
      edges.append(line);
      if (label) {
        labels.append(svgEl('rect', { x: label.x, y: label.y, width: label.w, height: label.h, rx: label.h / 2, fill: COLORS.label, stroke: style.color, 'stroke-width': 1.5 }));
        labels.append(svgEl('text', { x: label.x + label.w / 2, y: label.y + label.h / 2 + 5, fill: COLORS.text, 'font-family': FONT, 'font-size': 13, 'text-anchor': 'middle' }, label.text));
      }
    });
    svg.append(edges, labels);

    names.forEach((n) => {
      const p = plan.nodes[n];
      const isMine = mine.has(n);
      svg.append(svgEl('circle', { cx: p.x, cy: p.y, r: p.r, fill: isMine ? COLORS.nodeMine : COLORS.node, stroke: isMine ? '#ffd2c8' : COLORS.muted, 'stroke-width': isMine ? 3 : 1.5 }));
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

  root.InsightView = { render, drawGraph, planGraph, saveGraphImage, toText, KIND_STYLE };
})(this);
