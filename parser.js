// 대본 해석 · 유사도 · 씬 분위기 추정 (순수 함수, 브라우저/Node 공용)
(function (root) {
  'use strict';

  const MAX_NAME_LEN = 15;
  const SCENE_RE = /^\s*(S\s*#\s*\d+|#\s*\d+|씬\s*\d+|장면\s*\d+|INT\.|EXT\.|\d+\.\s*(실내|실외|내부|외부))/i;
  const INLINE_RE = new RegExp('^\\s*([^\\s:：()（）][^:：()（）]{0,' + (MAX_NAME_LEN - 1) + '}?)\\s*(\\([^)]*\\))?\\s*[:：]\\s*(.+)$');
  const DIRECTION_RE = /^\s*[(（\[].*[)）\]]\s*$/;

  // ---------- '이름 대사' 형식 (희곡에서 흔함: 쌍점 없이 이름 뒤에 띄어쓰기) ----------
  // 줄 맨 앞에 여러 번 나오는 짧은 단어를 인물 이름으로 봄. '수철이 들어온다'처럼 조사가 붙은 건 지문
  const MIN_SPEAKER_LINES = 3;
  const MIN_SPOKEN_NAME_LEN = 2;   // 한 글자('는' '이' '을')는 PDF 줄바꿈으로 줄 앞에 남은 조각인 경우가 대부분
  const MAX_SPOKEN_NAME_LEN = 6;
  const PARTICLE_END = /[이가은는을를의와과도에]$/;
  const NOT_NAMES = new Set(['그리고', '그때', '이때', '다시', '모두', '잠시', '한편', '무대', '조명', '암전', '음악', '효과', '그러자', '그런데', '하지만',
    '과거', '현재', '장면', '다음', '이어', '이윽고', '등장인물',
    // 대사·지문 첫머리에 흔한 말 (시나리오·쌍점 대본에서 이름으로 오인하지 않게)
    '아니', '아니야', '우리', '그래', '근데', '내가', '네가', '그럼', '그냥', '정말', '진짜', '이제', '지금', '여기', '저기', '거기',
    '그건', '이건', '저건', '어서', '자네', '당신', '혹시', '제발', '얼른', '빨리', '아마', '역시', '그러니까', '그러면']);
  const SPOKEN_LINE_RE = /^([가-힣A-Za-z]{1,6})\s+(\S.*)$/;
  // 문서 전체가 희곡식일 때만 이 인식을 켬: 이름으로 시작하는 줄이 이 비율 이상이고, 쌍점·시나리오식 줄보다 확실히 많아야 함
  const PLAY_MIN_SHARE = 0.3;

  function findSpokenNames(lines) {
    const candidates = speakerCandidates(lines);
    if (!candidates.size) return candidates;
    const nonEmpty = lines.map((l) => String(l).trim()).filter(Boolean);
    const spoken = nonEmpty.filter((l) => { const m = SPOKEN_LINE_RE.exec(l); return m && candidates.has(m[1]); }).length;
    const colon = nonEmpty.filter((l) => { const m = l.match(INLINE_RE); return m && looksLikeName(m[1]); }).length;
    const standalone = nonEmpty.filter(isStandaloneName).length;
    const playLike = spoken >= nonEmpty.length * PLAY_MIN_SHARE && spoken > colon * 2 && standalone < spoken * 0.6;
    return playLike ? candidates : new Set();
  }

  // 줄 맨 앞에 MIN_SPEAKER_LINES번 이상 나오는 짧은 단어 (조사·조각·흔한 첫말 제외)
  function speakerCandidates(lines) {
    const counts = new Map();
    lines.forEach((raw) => {
      const m = SPOKEN_LINE_RE.exec(String(raw).trim());
      if (m) counts.set(m[1], (counts.get(m[1]) || 0) + 1);
    });
    const names = new Set();
    counts.forEach((n, word) => {
      if (n < MIN_SPEAKER_LINES || word.length < MIN_SPOKEN_NAME_LEN || word.length > MAX_SPOKEN_NAME_LEN || NOT_NAMES.has(word)) return;
      // 조사로 끝나면: 앞부분이 이름이거나(상범이 → 상범) 많이 나오지 않으면 지문의 주어로 봄. '순이'처럼 이로 끝나는 이름은 자주 나오면 인정
      if (PARTICLE_END.test(word)) {
        const stem = word.slice(0, -1);
        if ((counts.get(stem) || 0) >= MIN_SPEAKER_LINES || n < MIN_SPEAKER_LINES + 2) return;
      }
      names.add(word);
    });
    return names;
  }

  // "이름: 대사", "이름(속삭이며): 대사", 시나리오식 "이름\n대사", 희곡식 "이름 대사" 형식을 모두 지원
  function parseScript(text) {
    const lines = String(text || '').replace(/\r/g, '').split('\n');
    const spokenNames = findSpokenNames(lines);
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
      const spoken = SPOKEN_LINE_RE.exec(line);
      if (spoken && spokenNames.has(spoken[1])) {
        const { text: speech, note } = splitNote(spoken[2]);
        items.push({ type: 'line', character: spoken[1], text: speech, note: joinNotes('', note), scene });
        return;
      }
      // 희곡식('이름 대사') 대본이면 '김상범 전세환' 같은 배역표 줄을 시나리오식 이름 줄로 보지 않음
      if (!spokenNames.size && isStandaloneName(line)) { pendingName = { name: line, note: '' }; return; }
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

  // ---------- 채점 ----------
  // 한글 음절을 자모로 풀어 비교 → '빨라'와 '발라'처럼 소리가 비슷하면 부분 점수 (음절 통째로 틀림 처리하지 않음)
  const CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
  const JUNG = 'ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ';
  const JONG = ' ㄱㄲㄳㄴㄵㄶㄷㄹㄺㄻㄼㄽㄾㄿㅀㅁㅂㅄㅅㅆㅇㅈㅊㅋㅌㅍㅎ';
  function toJamo(s) {
    let out = '';
    for (const ch of s) {
      const code = ch.charCodeAt(0) - 0xac00;
      if (code < 0 || code > 11171) { out += ch; continue; }
      out += CHO[Math.floor(code / 588)] + JUNG[Math.floor((code % 588) / 28)] + (code % 28 ? JONG[code % 28] : '');
    }
    return out;
  }

  function jamoSimilarity(a, b) {
    const ja = toJamo(a);
    const jb = toJamo(b);
    if (!ja.length && !jb.length) return 1;
    return 1 - levenshtein(ja, jb) / Math.max(ja.length, jb.length);
  }

  // 숫자 읽기: 인식기는 '3년'을 '삼 년'으로, '세 시'를 '3시'로 적기도 함 → 양쪽을 한글 읽기로 맞춰 비교
  const SINO = ['', '일', '이', '삼', '사', '오', '육', '칠', '팔', '구'];
  const NATIVE_ONES = ['', '한', '두', '세', '네', '다섯', '여섯', '일곱', '여덟', '아홉'];
  const NATIVE_TENS = ['', '열', '스물', '서른', '마흔', '쉰', '예순', '일흔', '여든', '아흔'];
  const NATIVE_MAX = 99;

  function sinoNumber(n) {
    if (n === 0) return '영';
    if (n >= 100000000) {
      const eok = Math.floor(n / 100000000);
      return sinoNumber(eok) + '억' + (n % 100000000 ? sinoNumber(n % 100000000) : '');
    }
    if (n >= 10000) {
      const man = Math.floor(n / 10000);
      return (man === 1 ? '' : sinoNumber(man)) + '만' + (n % 10000 ? sinoNumber(n % 10000) : '');
    }
    return [[1000, '천'], [100, '백'], [10, '십'], [1, '']].map(([unit, name]) => {
      const d = Math.floor(n / unit) % 10;
      if (!d) return '';
      return (d === 1 && unit > 1 ? '' : SINO[d]) + name;
    }).join('');
  }

  // 시·살·개처럼 고유어로 읽는 단위 앞의 꼴 (20은 '스무')
  function nativeNumber(n) {
    if (n === 20) return '스무';
    return NATIVE_TENS[Math.floor(n / 10)] + NATIVE_ONES[n % 10];
  }

  // 정규화된 문장의 숫자를 한자어·고유어 읽기로 바꾼 후보들 (숫자가 없으면 원문 하나)
  // 숫자는 12자리(천억)까지 한 덩어리로 읽음. 그보다 긴 숫자열은 끊어 읽어 무한 재귀·Infinity를 막음
  const DIGIT_RUN = /\d{1,12}/g;
  function readings(s) {
    if (!/\d/.test(s)) return [s];
    const sino = s.replace(DIGIT_RUN, (d) => sinoNumber(Number(d)));
    const native = s.replace(DIGIT_RUN, (d) => (Number(d) >= 1 && Number(d) <= NATIVE_MAX ? nativeNumber(Number(d)) : sinoNumber(Number(d))));
    return sino === native ? [sino] : [sino, native];
  }

  function bestOf(as, bs, score) {
    let best = 0;
    as.forEach((a) => bs.forEach((b) => { best = Math.max(best, score(a, b)); }));
    return best;
  }

  function syllableSimilarity(a, b) {
    if (!a.length && !b.length) return 1;
    return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
  }

  // '응'·'네'처럼 아주 짧은 대사는 자모 부분 점수를 주면 '음'·'내'도 통과해 버림 → 음절이 정확해야 함
  const SHORT_LINE_SYLLABLES = 2;

  // 0~1, 띄어쓰기·문장부호를 무시하고 자모 단위로 비교한 일치율. 숫자는 읽는 방식 차이를 무시
  function similarity(expected, spoken) {
    const exp = normalize(expected);
    const score = Array.from(exp).length <= SHORT_LINE_SYLLABLES ? syllableSimilarity : jamoSimilarity;
    return bestOf(readings(exp), readings(normalize(spoken)), score);
  }

  const WORD_MATCH = 0.8;  // 단어 표시에서 '맞음'으로 볼 자모 일치율 (빨라↔발라 = 0.8)

  // spoken 안에 word와 소리가 거의 같은 구간이 있는지 (앞뒤 한 음절 차이까지 허용)
  function containsSimilar(spoken, word) {
    if (spoken.includes(word)) return true;
    const said = Array.from(spoken);
    const len = Array.from(word).length;
    for (let size = Math.max(1, len - 1); size <= len + 1; size++) {
      for (let i = 0; i + size <= said.length; i++) {
        if (jamoSimilarity(word, said.slice(i, i + size).join('')) >= WORD_MATCH) return true;
      }
    }
    return false;
  }

  // 단어별 맞음/틀림 표시용
  function wordDiff(expected, spoken) {
    const said = readings(normalize(spoken));
    return String(expected || '').split(/\s+/).filter(Boolean).map((w) => {
      const n = normalize(w);
      return { word: w, ok: !n || readings(n).some((r) => said.some((s) => containsSimilar(s, r))) };
    });
  }

  // 인식기가 준 후보 문장들 중, 지금까지 말한 내용(prefix)에 붙였을 때 대사와 가장 가까운 것
  function bestAlternative(expected, prefix, candidates) {
    let best = '';
    let bestScore = -1;
    (candidates || []).forEach((c) => {
      const score = similarity(expected, (prefix + ' ' + c).trim());
      if (score > bestScore) { best = c; bestScore = score; }
    });
    return best;
  }

  // 말이 끝났다고 볼 침묵 길이(ms). 긴 대사, '...' 같은 쉼이 있는 대사는 연기 호흡을 기다려 줌
  const SILENCE_BASE_MS = 1400;
  const SILENCE_PER_CHAR_MS = 30;    // 12글자를 넘는 글자마다
  const SILENCE_PAUSE_MS = 700;      // '...', '…', '—' 가 있으면
  const SILENCE_MAX_MS = 3200;
  function silenceForLine(text) {
    const chars = normalize(text).length;
    const pause = /\.\.\.|…|—/.test(String(text || '')) ? SILENCE_PAUSE_MS : 0;
    return Math.min(SILENCE_MAX_MS, SILENCE_BASE_MS + Math.max(0, chars - 12) * SILENCE_PER_CHAR_MS + pause);
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

  const api = { parseScript, findSpokenNames, listCharacters, renameCharacter, similarity, wordDiff, bestAlternative, silenceForLine, firstLetterHint, detectMood, detectEmotion, normalize };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ScriptKit = api;
})(this);
