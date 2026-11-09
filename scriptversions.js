// 대본 버전: 대본을 고친 뒤 '대본 분석'을 누를 때 '새 버전으로 저장'을 고르면 고친 대본을 버전으로 쌓아 둠 (모바일 앱 versions.js와 같은 규칙)
// 고치기 전 대본이 아직 목록에 없으면 '원본'으로 함께 남김. 같은 글은 두 번 저장하지 않고, 최근 30개까지만 둠
// 이 기기(localStorage)에만, 앱 상태와 다른 키에 저장: 대본이 길어 저장 공간이 차도 앱 상태 저장은 망가지지 않게
(function (root) {
  'use strict';

  const STORAGE_KEY = 'acting-practice-versions-v1';
  const MAX_VERSIONS = 30;

  const pad = (n) => String(n).padStart(2, '0');
  const stamp = (d) => `${d.getMonth() + 1}월 ${d.getDate()}일 ${pad(d.getHours())}:${pad(d.getMinutes())}`;

  function entry(n, text, at, original) {
    return { id: `${at.getTime()}-${n}`, n, label: `${original ? '원본' : `버전 ${n}`} · ${stamp(at)}`, text, savedAt: at.getTime() };
  }

  function addVersion(list, { before, after }, at) {
    if (!after.trim() || list.some((v) => v.text === after)) return list;
    const out = [...list];
    let last = list.reduce((m, v) => Math.max(m, v.n || 0), 0);
    // 고치기 전 대본(불러온 대본)이 아직 없으면 원본으로 먼저 남김
    if (before.trim() && before !== after && !list.some((v) => v.text === before)) out.push(entry(++last, before, at, true));
    out.push(entry(++last, after, at, false));
    return out.slice(-MAX_VERSIONS);
  }

  const removeVersion = (list, id) => list.filter((v) => v.id !== id);

  // 저장소에서 읽은 값 중 모양이 맞는 것만
  const sanitizeVersions = (raw) => (Array.isArray(raw)
    ? raw.filter((v) => v && typeof v.id === 'string' && typeof v.label === 'string' && typeof v.text === 'string' && typeof v.savedAt === 'number')
    : []);

  // save는 성공 여부를 돌려줌 (저장 공간이 꽉 차면 false → 화면에서 오래된 버전을 지우라고 안내)
  function createStore(storage) {
    return {
      load() {
        try { return sanitizeVersions(JSON.parse(storage.getItem(STORAGE_KEY))); } catch (_) { return []; }
      },
      save(list) {
        try { storage.setItem(STORAGE_KEY, JSON.stringify(list)); return true; } catch (_) { return false; }
      },
    };
  }

  const api = { STORAGE_KEY, MAX_VERSIONS, addVersion, removeVersion, sanitizeVersions, createStore };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.ScriptVersions = api;
})(this);
