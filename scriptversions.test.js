// 실행: npm test (node --test)
const test = require('node:test');
const assert = require('node:assert');
const V = require('./scriptversions.js');

const at = (h, m) => new Date(2026, 10, 6, h, m);   // 11월 6일

test('the first saved edit also keeps the script before editing as "원본"', () => {
  const list = V.addVersion([], { before: '민수: 안녕', after: '민수: 안녕하세요' }, at(14, 5));
  assert.deepStrictEqual(list.map((v) => [v.label, v.text]), [['원본 · 11월 6일 14:05', '민수: 안녕'], ['버전 2 · 11월 6일 14:05', '민수: 안녕하세요']]);
  assert.notStrictEqual(list[0].id, list[1].id);
});

test('later edits become the next numbered version and the original is not saved twice', () => {
  let list = V.addVersion([], { before: 'a: 1', after: 'a: 2' }, at(9, 0));
  list = V.addVersion(list, { before: 'a: 2', after: 'a: 3' }, at(9, 30));
  assert.deepStrictEqual(list.map((v) => v.label), ['원본 · 11월 6일 09:00', '버전 2 · 11월 6일 09:00', '버전 3 · 11월 6일 09:30']);
});

test('editing a newly loaded script keeps its original too, even when other versions exist', () => {
  let list = V.addVersion([], { before: 'a: 1', after: 'a: 2' }, at(9, 0));
  list = V.addVersion(list, { before: 'b: 1', after: 'b: 2' }, at(9, 10));
  assert.deepStrictEqual(list.map((v) => [v.label, v.text]), [
    ['원본 · 11월 6일 09:00', 'a: 1'], ['버전 2 · 11월 6일 09:00', 'a: 2'],
    ['원본 · 11월 6일 09:10', 'b: 1'], ['버전 4 · 11월 6일 09:10', 'b: 2'],
  ]);
});

test('a text that is already saved is not saved again, and the list keeps the newest 30', () => {
  let list = V.addVersion([], { before: 'a: 1', after: 'a: 2' }, at(9, 0));
  assert.strictEqual(V.addVersion(list, { before: 'a: 9', after: 'a: 2' }, at(10, 0)), list);
  for (let i = 3; i < 40; i++) list = V.addVersion(list, { before: '', after: `a: ${i}` }, at(10, i % 60));
  assert.strictEqual(list.length, V.MAX_VERSIONS);
  assert.strictEqual(list.at(-1).text, 'a: 39');
});

test('an empty script is never saved as a version', () => {
  assert.deepStrictEqual(V.addVersion([], { before: '', after: '   ' }, at(9, 0)), []);
  assert.deepStrictEqual(V.addVersion([], { before: '  ', after: 'a: 1' }, at(9, 0)).map((v) => v.label), ['버전 1 · 11월 6일 09:00']);
});

test('deleting removes only that version and returns a new list', () => {
  const list = V.addVersion([], { before: 'a: 1', after: 'a: 2' }, at(9, 0));
  const left = V.removeVersion(list, list[0].id);
  assert.deepStrictEqual(left.map((v) => v.text), ['a: 2']);
  assert.strictEqual(list.length, 2);
});

test('saved versions read back from storage drop broken entries', () => {
  assert.deepStrictEqual(V.sanitizeVersions(null), []);
  const ok = { id: 'x', label: 'l', text: 't', savedAt: 1 };
  assert.deepStrictEqual(V.sanitizeVersions([ok, { id: 3 }, 'nope']), [ok]);
});

test('the store saves under its own key and reports when the browser is full', () => {
  const data = {};
  const storage = { getItem: (k) => data[k] ?? null, setItem: (k, v) => { if (v.length > 200) throw new Error('QuotaExceededError'); data[k] = v; } };
  const store = V.createStore(storage);
  assert.deepStrictEqual(store.load(), []);
  const small = V.addVersion([], { before: 'a: 1', after: 'a: 2' }, at(9, 0));
  assert.strictEqual(store.save(small), true);
  assert.deepStrictEqual(store.load(), small);
  assert.ok(data[V.STORAGE_KEY]);
  const big = V.addVersion(small, { before: '', after: 'a: ' + 'x'.repeat(300) }, at(9, 5));
  assert.strictEqual(store.save(big), false);
  assert.deepStrictEqual(store.load(), small);   // 저장에 실패하면 전에 저장한 목록이 그대로 남음
});

test('the store reads broken storage as an empty list', () => {
  const store = V.createStore({ getItem: () => '{not json', setItem: () => {} });
  assert.deepStrictEqual(store.load(), []);
  assert.deepStrictEqual(V.createStore(null).load(), []);
});
