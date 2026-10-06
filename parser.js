// 대본 해석 · 유사도 · 씬 분위기 추정 (순수 함수, 브라우저/Node 공용)
(function (root) {
  'use strict';

  const MAX_NAME_LEN = 15;
  const SCENE_RE = /^\s*(S\s*#\s*\d+|#\s*\d+|씬\s*\d+|장면\s*\d+|INT\.|EXT\.|\d+\.\s*(실내|실외|내부|외부))/i;
  const INLINE_RE = new RegExp('^\\s*([^\\s:：()（）][^:：()（）]{0,' + (MAX_NAME_LEN - 1) + '}?)\\s*(\\([^)]*\\))?\\s*[:：]\\s*(.+)$');
  const DIRECTION_RE = /^\s*[(（\[].*[)）\]]\s*$/;

  // "이름: 대사", "이름(속삭이며): 대사", 시나리오식 "이름\n대사" 형식을 모두 지원
  function parseScript(text) {
    const lines = String(text || '').replace(/\r/g, '').split('\n');
    const items = [];
    let pendingName = null;
    let scene = '';

    lines.forEach((raw) => {
      const line = raw.trim();
      if (!line) { pendingName = null; return; }

      if (SCENE_RE.test(line)) {
        scene = line;
        items.push({ type: 'scene', text: line, scene });
        pendingName = null;
        return;
      }
      if (DIRECTION_RE.test(line) && !pendingName) {
        items.push({ type: 'direction', text: stripBrackets(line), scene });
        return;
      }
      const m = line.match(INLINE_RE);
      if (m && looksLikeName(m[1])) {
        const { text: speech, note } = splitNote(m[3]);
        items.push({ type: 'line', character: m[1].trim(), text: speech, note: joinNotes(m[2], note), scene });
        pendingName = null;
        return;
      }
      if (pendingName) {
        if (DIRECTION_RE.test(line)) { pendingName.note = stripBrackets(line); return; }
        const { text: speech, note } = splitNote(line);
        items.push({ type: 'line', character: pendingName.name, text: speech, note: joinNotes(pendingName.note, note), scene });
        pendingName = null;
        return;
      }
      if (isStandaloneName(line)) { pendingName = { name: line, note: '' }; return; }
      items.push({ type: 'direction', text: line, scene });
    });
    return items;
  }

  function looksLikeName(s) {
    const t = s.trim();
    return t.length > 0 && t.length <= MAX_NAME_LEN && !/[.!?。,]$/.test(t) && t.split(/\s+/).length <= 3;
  }

  // 시나리오식: 한 줄에 이름만 단독으로 (짧고, 문장부호 없음)
  function isStandaloneName(line) {
    return line.length <= 8 && !/[.!?,…~"'“”]/.test(line) && line.split(/\s+/).length <= 2;
  }

  function stripBrackets(s) { return s.trim().replace(/^[(（\[]\s*|\s*[)）\]]$/g, ''); }

  // 대사 맨 앞의 (지문)을 분리
  function splitNote(s) {
    const m = s.match(/^\s*[(（]([^)）]*)[)）]\s*(.*)$/);
    return m ? { text: m[2].trim(), note: m[1].trim() } : { text: s.trim(), note: '' };
  }

  function joinNotes(a, b) {
    return [a, b].map((x) => (x ? stripBrackets(x) : '')).filter(Boolean).join(', ');
  }

  function listCharacters(items) {
    const counts = new Map();
    items.filter((i) => i.type === 'line').forEach((i) => counts.set(i.character, (counts.get(i.character) || 0) + 1));
    return [...counts.entries()].map(([name, lines]) => ({ name, lines })).sort((a, b) => b.lines - a.lines);
  }

  // 인물 이름을 합치거나 바꿀 때 사용 (원본은 건드리지 않음)
  function renameCharacter(items, from, to) {
    return items.map((i) => (i.type === 'line' && i.character === from ? { ...i, character: to } : i));
  }

  function normalize(s) {
    return String(s || '').toLowerCase().replace(/\([^)]*\)/g, '').replace(/[^\p{L}\p{N}]/gu, '');
  }

  function levenshtein(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[b.length];
  }

  // 0~1, 띄어쓰기·문장부호 무시한 글자 단위 일치율
  function similarity(expected, spoken) {
    const a = normalize(expected);
    const b = normalize(spoken);
    if (!a.length && !b.length) return 1;
    return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
  }

  // 단어별 맞음/틀림 표시용
  function wordDiff(expected, spoken) {
    const said = normalize(spoken);
    return String(expected || '').split(/\s+/).filter(Boolean).map((w) => {
      const n = normalize(w);
      return { word: w, ok: !n || said.includes(n) };
    });
  }

  function firstLetterHint(text) {
    return String(text || '').split(/\s+/).map((w) => w.replace(/^([^\p{L}\p{N}]*[\p{L}\p{N}])[\s\S]*$/u, '$1…')).join(' ');
  }

  const MOODS = [
    { key: 'night', words: ['밤', '새벽', '자정', '어둠', '달빛', 'night'], label: '밤', emoji: '🌙', bg: ['#0f1734', '#2a2f5c'] },
    { key: 'rain', words: ['비가', '비 내리', '빗', '폭우', '우산', '장마', 'rain'], label: '비', emoji: '🌧️', bg: ['#2c3e50', '#5d7387'] },
    { key: 'sea', words: ['바다', '해변', '파도', '항구', '배 위'], label: '바다', emoji: '🌊', bg: ['#0b4f6c', '#3fa7c9'] },
    { key: 'cafe', words: ['카페', '커피', '찻집'], label: '카페', emoji: '☕', bg: ['#4b3226', '#a9774f'] },
    { key: 'hospital', words: ['병원', '병실', '응급실', '수술'], label: '병원', emoji: '🏥', bg: ['#cfe3e8', '#7fa7b3'] },
    { key: 'school', words: ['학교', '교실', '복도', '운동장', '교무실'], label: '학교', emoji: '🏫', bg: ['#4e7d3a', '#a6c46a'] },
    { key: 'office', words: ['사무실', '회의실', '회사', '오피스'], label: '사무실', emoji: '🏢', bg: ['#38404a', '#7b8794'] },
    { key: 'home', words: ['거실', '부엌', '주방', '방 안', '집', '침실'], label: '집', emoji: '🏠', bg: ['#6b4b3e', '#c99a6d'] },
    { key: 'street', words: ['거리', '골목', '길가', '도로', '횡단보도'], label: '거리', emoji: '🏙️', bg: ['#2f3542', '#747d8c'] },
    { key: 'snow', words: ['눈이', '눈 내리', '설원', '겨울'], label: '겨울', emoji: '❄️', bg: ['#a4b9cc', '#e6eef5'] },
  ];
  const EMOTIONS = [
    { key: 'anger', words: ['화가', '화내', '화난', '분노', '소리치', '버럭', '짜증', '고함'], label: '분노', color: '#e74c3c' },
    { key: 'sad', words: ['울며', '울먹', '울음', '눈물', '슬프', '흐느', '떨리는'], label: '슬픔', color: '#5b7db1' },
    { key: 'joy', words: ['웃', '기뻐', '신나', '활짝'], label: '기쁨', color: '#f1c40f' },
    { key: 'whisper', words: ['속삭', '작게', '조용히', '귓속말'], label: '속삭임', color: '#9b59b6' },
    { key: 'fear', words: ['떨며', '겁', '두려', '놀라'], label: '긴장', color: '#16a085' },
  ];

  function findByWords(list, text) {
    const t = String(text || '');
    return list.find((m) => m.words.some((w) => t.includes(w))) || null;
  }

  function detectMood(text) { return findByWords(MOODS, text); }
  function detectEmotion(text) { return findByWords(EMOTIONS, text); }

  const api = { parseScript, listCharacters, renameCharacter, similarity, wordDiff, firstLetterHint, detectMood, detectEmotion, normalize };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ScriptKit = api;
})(this);
