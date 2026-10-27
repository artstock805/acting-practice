// 연습 범위: 전체 / 장면 하나 / 약한 대사만(바로 앞 상대 대사와 함께). 재생 순서와 반복을 계산함
(function (root) {
  'use strict';

  // 장면 목록: [{ key: 'scene:6', title, start, end }] (end는 다음 장면 바로 앞 항목)
  function scenesOf(items) {
    const starts = items.map((it, i) => (it.type === 'scene' ? i : -1)).filter((i) => i >= 0);
    return starts.map((start, k) => ({
      key: `scene:${start}`,
      title: items[start].text,
      start,
      end: (starts[k + 1] ?? items.length) - 1,
    }));
  }

  // 약한 대사: 내 대사 중 마지막 점수가 통과 기준보다 낮은 것 (한 번도 안 한 대사는 빼고)
  function weakLines(items, lineStats, isMine, threshold) {
    return items
      .map((it, i) => i)
      .filter((i) => items[i].type === 'line' && isMine(items[i].character)
        && lineStats[i] && lineStats[i].last < threshold);
  }

  // 약한 대사 바로 앞의 상대 대사 (받아칠 신호). 없으면 -1
  function cueBefore(items, index, isMine) {
    for (let i = index - 1; i >= 0; i--) {
      if (items[i].type === 'scene') return -1;
      if (items[i].type === 'line') return isMine(items[i].character) ? -1 : i;
    }
    return -1;
  }

  // 범위의 항목 번호 목록 (재생 순서). range: 'all' | 'scene:<시작 번호>' | 'weak'
  function planIndexes(items, range, { isMine, weak }) {
    const all = items.map((it, i) => i);
    if (range === 'weak') {
      const picked = new Set();
      weak.forEach((w) => {
        const cue = cueBefore(items, w, isMine);
        if (cue >= 0) picked.add(cue);
        picked.add(w);
      });
      return [...picked].sort((a, b) => a - b);
    }
    const scene = scenesOf(items).find((s) => s.key === range);
    return scene ? all.slice(scene.start, scene.end + 1) : all;
  }

  // 지금 다음에 할 항목. 범위 끝이면 반복일 때 처음으로, 아니면 -1
  function nextIndex(plan, current, loop) {
    const after = plan.find((i) => i > current);
    if (after !== undefined) return after;
    return loop && plan.length ? plan[0] : -1;
  }

  // 시작 위치: 지금 줄이 범위 안이면 그대로, 아니면 범위 처음
  function startIndex(plan, current) {
    if (!plan.length) return -1;
    return plan.includes(current) ? current : plan[0];
  }

  // 대사별 점수 기록 (새 객체로 돌려줌): 마지막·최고 점수와 시도 횟수
  function addScore(lineStats, index, score) {
    const prev = lineStats[index];
    const next = prev
      ? { last: score, best: Math.max(prev.best, score), tries: prev.tries + 1 }
      : { last: score, best: score, tries: 1 };
    return { ...lineStats, [index]: next };
  }

  const api = { scenesOf, weakLines, planIndexes, nextIndex, startIndex, addScore };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PracticePlan = api;
})(this);
