// 실행: node --test
const test = require('node:test');
const assert = require('node:assert');
const PP = require('./practiceplan.js');

// 0 장면 · 1 지문 · 2 민수 · 3 지연(나) · 4 민수 · 5 지연(나) · 6 장면 · 7 지연(나) · 8 민수 · 9 지연(나)
const ITEMS = [
  { type: 'scene', text: 'S#1. 카페' },
  { type: 'direction', text: '비가 온다.' },
  { type: 'line', character: '민수', text: '늦었네.' },
  { type: 'line', character: '지연', text: '미안.' },
  { type: 'line', character: '민수', text: '괜찮아.' },
  { type: 'line', character: '지연', text: '고마워.' },
  { type: 'scene', text: 'S#2. 거리' },
  { type: 'line', character: '지연', text: '어디 가?' },
  { type: 'line', character: '민수', text: '집에.' },
  { type: 'line', character: '지연', text: '같이 가.' },
];
const isMine = (name) => name === '지연';

test('scenes are listed with their item ranges', () => {
  assert.deepStrictEqual(PP.scenesOf(ITEMS), [
    { key: 'scene:0', title: 'S#1. 카페', start: 0, end: 5 },
    { key: 'scene:6', title: 'S#2. 거리', start: 6, end: 9 },
  ]);
  assert.deepStrictEqual(PP.scenesOf([{ type: 'line', character: 'A', text: 'x' }]), []);
});

test('weak lines are my lines whose last score is below the pass mark', () => {
  const stats = { 3: { last: 0.5 }, 5: { last: 0.9 }, 9: { last: 0.2 }, 2: { last: 0.1 } };
  assert.deepStrictEqual(PP.weakLines(ITEMS, stats, isMine, 0.7), [3, 9]);
  assert.deepStrictEqual(PP.weakLines(ITEMS, {}, isMine, 0.7), []);
});

test('the plan for a range lists the items to play in order', () => {
  const ctx = { isMine, weak: [3, 9] };
  assert.deepStrictEqual(PP.planIndexes(ITEMS, 'all', ctx), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepStrictEqual(PP.planIndexes(ITEMS, 'scene:6', ctx), [6, 7, 8, 9]);
  // 약한 대사는 바로 앞 상대 대사(신호)와 함께
  assert.deepStrictEqual(PP.planIndexes(ITEMS, 'weak', ctx), [2, 3, 8, 9]);
  assert.deepStrictEqual(PP.planIndexes(ITEMS, 'weak', { isMine, weak: [7] }), [7]);   // 장면 첫 대사는 앞 장면 대사를 신호로 쓰지 않음
  assert.deepStrictEqual(PP.planIndexes(ITEMS, 'weak', { isMine, weak: [] }), []);
  // 없는 장면이면 전체로
  assert.deepStrictEqual(PP.planIndexes(ITEMS, 'scene:99', ctx).length, ITEMS.length);
});

test('next and start positions follow the plan, looping when asked', () => {
  const plan = [2, 3, 8, 9];
  assert.strictEqual(PP.nextIndex(plan, 3, false), 8);
  assert.strictEqual(PP.nextIndex(plan, 9, false), -1);
  assert.strictEqual(PP.nextIndex(plan, 9, true), 2);
  assert.strictEqual(PP.nextIndex(plan, 5, false), 8);   // 범위 밖이면 뒤쪽 첫 항목
  assert.strictEqual(PP.nextIndex([], 0, true), -1);
  assert.strictEqual(PP.startIndex(plan, 8), 8);
  assert.strictEqual(PP.startIndex(plan, 5), 2);
  assert.strictEqual(PP.startIndex([], 5), -1);
});

test('line scores remember the last, best and number of tries', () => {
  let stats = {};
  stats = PP.addScore(stats, 3, 0.4);
  stats = PP.addScore(stats, 3, 0.8);
  stats = PP.addScore(stats, 3, 0.6);
  assert.deepStrictEqual(stats[3], { last: 0.6, best: 0.8, tries: 3 });
  const frozen = Object.freeze({ 3: Object.freeze({ last: 0.1, best: 0.1, tries: 1 }) });
  assert.strictEqual(PP.addScore(frozen, 3, 0.5)[3].tries, 2);   // 원본을 바꾸지 않음
});
