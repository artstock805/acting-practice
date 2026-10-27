// 연습 기록: 날짜별 연습 시간·말한 대사 수·통과 수·점수, 자주 틀린 낱말. 이 기기(localStorage)에만 저장
(function (root) {
  'use strict';

  const STORAGE_KEY = 'acting-practice-log-v1';
  const KEEP_DAYS = 60;                  // 이보다 오래된 날은 지움
  const MAX_WORDS = 300;                 // 틀린 낱말은 많이 틀린 순으로 이만큼만 둠
  const MAX_CHUNK_MS = 30 * 60_000;      // 한 번에 30분 넘게 쌓인 시간은 자리를 비운 것으로 봄
  const DAY_MS = 24 * 60 * 60_000;

  const pad = (n) => String(n).padStart(2, '0');
  const dateKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;   // 이 기기 시간대 기준
  const emptyDay = () => ({ ms: 0, lines: 0, passed: 0, scoreSum: 0 });
  const emptyData = () => ({ v: 1, days: {}, missed: {} });

  // 낱말 비교용: 괄호 지문·문장부호를 빼고 소문자로
  const cleanWord = (w) => String(w || '').replace(/\([^)]*\)/g, '').replace(/[^\p{L}\p{N}']/gu, '').toLowerCase();

  function createLog(storage = root.localStorage, now = () => new Date()) {
    let data = load();
    // 브라우저와 설치한 앱(또는 탭 여러 개)이 같은 기록을 쓰므로, 읽고 쓸 때마다 저장된 것을 다시 읽음
    const refresh = () => { data = load(); };

    function load() {
      try {
        const parsed = JSON.parse(storage.getItem(STORAGE_KEY));
        return parsed && parsed.v === 1 && parsed.days && parsed.missed ? parsed : emptyData();
      } catch (_) { return emptyData(); }
    }

    function save(next) {
      const oldest = dateKey(new Date(now().getTime() - KEEP_DAYS * DAY_MS));
      const days = Object.fromEntries(Object.entries(next.days).filter(([d]) => d >= oldest));
      const missed = Object.fromEntries(Object.entries(next.missed).sort((a, b) => b[1] - a[1]).slice(0, MAX_WORDS));
      data = { ...next, days, missed };
      try { storage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch (_) { /* 저장 불가 환경(시크릿 창 등)에서는 무시 */ }
    }

    function changeToday(fn) {
      refresh();
      const key = dateKey(now());
      save({ ...data, days: { ...data.days, [key]: fn(data.days[key] || emptyDay()) } });
    }

    // 채점한 대사 하나: score 0~1, passed 통과 여부, missed 틀린 낱말들
    function record({ score, passed, missed = [] }) {
      changeToday((d) => ({ ...d, lines: d.lines + 1, passed: d.passed + (passed ? 1 : 0), scoreSum: d.scoreSum + score }));
      const words = missed.map(cleanWord).filter(Boolean);
      if (!words.length) return;
      refresh();
      const counts = { ...data.missed };
      words.forEach((w) => { counts[w] = (counts[w] || 0) + 1; });
      save({ ...data, missed: counts });
    }

    function addTime(ms) {
      const add = Math.min(Math.max(0, ms), MAX_CHUNK_MS);
      if (add) changeToday((d) => ({ ...d, ms: d.ms + add }));
    }

    // 오늘을 끝으로 지난 n일 (기록 없는 날도 0으로). avg는 대사가 없으면 null
    function days(n) {
      refresh();
      const today = now();
      return Array.from({ length: n }, (_, k) => {
        const date = dateKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() - (n - 1 - k)));
        const d = data.days[date] || emptyDay();
        return { date, ms: d.ms, lines: d.lines, passed: d.passed, avg: d.lines ? Math.round((d.scoreSum / d.lines) * 1000) / 1000 : null };
      });
    }

    function topMissed(n) {
      refresh();
      return Object.entries(data.missed).sort((a, b) => b[1] - a[1]).slice(0, n).map(([word, count]) => ({ word, count }));
    }

    function clear() { save(emptyData()); }

    return { record, addTime, today: () => days(1)[0], days, topMissed, clear };
  }

  const api = { createLog, STORAGE_KEY, MAX_CHUNK_MS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PracticeLog = api;
})(this);
