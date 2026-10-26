// 실행: node --test
// 인물 관계도 배치: 이름표가 인물 원·다른 이름표·다른 선 위에 겹치지 않고, 선이 다른 인물 원을 뚫고 지나가지 않는지
const test = require('node:test');
const assert = require('node:assert');
const { planGraph } = require('./insightview.js').InsightView;

// 사용자가 보낸 「규한」 관계도 그림과 같은 인물·관계 (가운데 이씨, 둘레 6명)
const LINE_COUNTS = { 이씨: 40, 최씨: 30, 순옥: 25, 노파: 20, 병준: 15, 김의관: 10, 모: 8 };
const RELATIONSHIPS = [
  { a: '최씨', b: '이씨', kind: 'friend', label: '동병상련의 이웃', direction: 'mutual' },
  { a: '모', b: '이씨', kind: 'family', label: '며느리와 시어머니', direction: 'mutual' },
  { a: '김의관', b: '이씨', kind: 'family', label: '며느리와 시아버지', direction: 'mutual' },
  { a: '모', b: '김의관', kind: 'family', label: '부부', direction: 'mutual' },
  { a: '이씨', b: '병준', kind: 'family', label: '형수와 시동생', direction: 'mutual' },
  { a: '이씨', b: '순옥', kind: 'family', label: '올케와 시누이', direction: 'mutual' },
  { a: '김의관', b: '병준', kind: 'family', label: '아버지와 아들', direction: 'mutual' },
  { a: '병준', b: '순옥', kind: 'family', label: '남매', direction: 'mutual' },
  { a: '노파', b: '순옥', kind: 'work', label: '매파와 혼처의 처녀', direction: 'a_to_b' },
  { a: '최씨', b: '순옥', kind: 'friend', label: '이웃 아주머니와 처녀', direction: 'mutual' },
  { a: '이씨', b: '최씨', kind: 'friend', label: '서로 위로하는 사이', direction: 'mutual' },
];

const plan = planGraph(RELATIONSHIPS, LINE_COUNTS);
const nodeList = Object.entries(plan.nodes);

const circleHitsRect = (c, rect, margin) => {
  const nx = Math.max(rect.x, Math.min(c.x, rect.x + rect.w));
  const ny = Math.max(rect.y, Math.min(c.y, rect.y + rect.h));
  return Math.hypot(c.x - nx, c.y - ny) < c.r + margin;
};
const rectsOverlap = (p, q) => p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h;
const inRect = (pt, rect) => pt.x > rect.x && pt.x < rect.x + rect.w && pt.y > rect.y && pt.y < rect.y + rect.h;

test('every relationship gets a line and a label', () => {
  assert.strictEqual(plan.edges.length, RELATIONSHIPS.length);
  plan.edges.forEach((e) => assert.ok(e.label && e.label.text, e.rel.label));
});

test('no label sits on or behind a character circle', () => {
  plan.edges.forEach((e) => nodeList.forEach(([name, c]) => {
    assert.ok(!circleHitsRect(c, e.label, 2), `「${e.rel.label}」 이름표가 ${name} 원과 겹침`);
  }));
});

test('no two labels overlap', () => {
  plan.edges.forEach((e, i) => plan.edges.slice(i + 1).forEach((f) => {
    assert.ok(!rectsOverlap(e.label, f.label), `「${e.rel.label}」와 「${f.rel.label}」 겹침`);
  }));
});

test('no line runs through a character it does not connect', () => {
  plan.edges.forEach((e) => nodeList.filter(([n]) => n !== e.rel.a && n !== e.rel.b).forEach(([name, c]) => {
    e.points.forEach((pt) => assert.ok(Math.hypot(pt.x - c.x, pt.y - c.y) > c.r + 4, `「${e.rel.label}」 선이 ${name} 원을 지나감`));
  }));
});

test('no other line passes under a label', () => {
  plan.edges.forEach((e) => plan.edges.filter((f) => f !== e).forEach((f) => {
    f.points.forEach((pt) => assert.ok(!inRect(pt, e.label), `「${f.rel.label}」 선이 「${e.rel.label}」 이름표 밑을 지나감`));
  }));
});

test('two relationships between the same pair are drawn apart', () => {
  const pair = plan.edges.filter((e) => [e.rel.a, e.rel.b].sort().join() === ['이씨', '최씨'].sort().join());
  assert.strictEqual(pair.length, 2);
  const mid = (e) => e.points[Math.floor(e.points.length / 2)];
  assert.ok(Math.hypot(mid(pair[0]).x - mid(pair[1]).x, mid(pair[0]).y - mid(pair[1]).y) > 20);
});

test('labels stay inside the picture', () => {
  plan.edges.forEach((e) => {
    assert.ok(e.label.x >= 0 && e.label.y >= 0 && e.label.x + e.label.w <= plan.size && e.label.y + e.label.h <= plan.size, e.rel.label);
  });
});
