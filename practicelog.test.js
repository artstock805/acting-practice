// 실행: node --test
const test = require('node:test');
const assert = require('node:assert');
const PL = require('./practicelog.js');

function memoryStorage() {
  const map = new Map();
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k) };
}

test('a day collects practice time, lines, passes and average score', () => {
  let clock = new Date(2026, 9, 27, 21, 0);
  const log = PL.createLog(memoryStorage(), () => clock);
  log.record({ score: 0.9, passed: true, missed: [] });
  log.record({ score: 0.5, passed: false, missed: ['우산이', '없어서.'] });
  log.addTime(5 * 60_000);
  const today = log.today();
  assert.deepStrictEqual(today, { date: '2026-10-27', ms: 300_000, lines: 2, passed: 1, avg: 0.7 });

  clock = new Date(2026, 9, 28, 9, 0);
  log.record({ score: 1, passed: true, missed: ['우산이'] });
  const week = log.days(3);
  assert.deepStrictEqual(week.map((d) => [d.date, d.lines]), [['2026-10-26', 0], ['2026-10-27', 2], ['2026-10-28', 1]]);
  assert.strictEqual(week[0].avg, null);
});

test('missed words are counted without punctuation and listed most-missed first', () => {
  const log = PL.createLog(memoryStorage(), () => new Date(2026, 9, 27));
  log.record({ score: 0.4, passed: false, missed: ['우산이', '없어서.', 'Hello,'] });
  log.record({ score: 0.4, passed: false, missed: ['우산이!', '(웃으며)', ''] });
  assert.deepStrictEqual(log.topMissed(2), [{ word: '우산이', count: 2 }, { word: '없어서', count: 1 }]);
  assert.ok(log.topMissed(10).some((w) => w.word === 'hello'));
});

test('the log survives reloads, ignores broken data, and can be cleared', () => {
  const storage = memoryStorage();
  const now = () => new Date(2026, 9, 27);
  PL.createLog(storage, now).record({ score: 0.8, passed: true, missed: ['a1'] });
  assert.strictEqual(PL.createLog(storage, now).today().lines, 1);
  storage.setItem(PL.STORAGE_KEY, '{not json');
  assert.strictEqual(PL.createLog(storage, now).today().lines, 0);
  const log = PL.createLog(storage, now);
  log.record({ score: 1, passed: true, missed: [] });
  log.clear();
  assert.strictEqual(PL.createLog(storage, now).today().lines, 0);
});

test('long idle stretches are not counted as practice, and old days are dropped', () => {
  let clock = new Date(2026, 0, 1);
  const log = PL.createLog(memoryStorage(), () => clock);
  log.addTime(3 * 60 * 60_000);
  assert.strictEqual(log.today().ms, PL.MAX_CHUNK_MS);
  log.addTime(-5);
  assert.strictEqual(log.today().ms, PL.MAX_CHUNK_MS);
  clock = new Date(2026, 5, 1);
  log.record({ score: 1, passed: true, missed: [] });
  assert.strictEqual(log.days(200).filter((d) => d.lines || d.ms).length, 1);   // 1월 기록은 지워짐
});

test('two windows sharing the same storage see each other\'s records', () => {
  const storage = memoryStorage();
  const now = () => new Date(2026, 9, 27);
  const browser = PL.createLog(storage, now);
  const app = PL.createLog(storage, now);
  browser.record({ score: 1, passed: true, missed: ['하나'] });
  app.record({ score: 0, passed: false, missed: ['하나'] });
  assert.strictEqual(browser.today().lines, 2);
  assert.deepStrictEqual(browser.topMissed(1), [{ word: '하나', count: 2 }]);
});
