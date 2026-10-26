// Google 음성 합성(Chirp 3 HD) 한국어 목소리 목록. 앱(목소리 고르기)과 서버(허용 목록·AI 추천)가 같이 씀.
// pitch: 같은 문장을 합성해 잰 평균 음높이(Hz). tone: Google이 밝힌 목소리 성격을 우리말로 옮김.
(function (root) {
  'use strict';

  const VOICES = [
    // 남성 — 낮은 목소리부터
    { id: 'ko-KR-Chirp3-HD-Algenib', gender: 'male', pitch: 122, tone: '거칠고 묵직한' },
    { id: 'ko-KR-Chirp3-HD-Algieba', gender: 'male', pitch: 128, tone: '부드럽고 매끄러운' },
    { id: 'ko-KR-Chirp3-HD-Umbriel', gender: 'male', pitch: 133, tone: '느긋하고 편안한' },
    { id: 'ko-KR-Chirp3-HD-Alnilam', gender: 'male', pitch: 136, tone: '단호하고 힘 있는' },
    { id: 'ko-KR-Chirp3-HD-Enceladus', gender: 'male', pitch: 136, tone: '숨결 섞인 나직한' },
    { id: 'ko-KR-Chirp3-HD-Sadaltager', gender: 'male', pitch: 140, tone: '지적이고 노련한' },
    { id: 'ko-KR-Chirp3-HD-Charon', gender: 'male', pitch: 142, tone: '또박또박 설명하는' },
    { id: 'ko-KR-Chirp3-HD-Sadachbia', gender: 'male', pitch: 150, tone: '생기 있고 여유로운' },
    { id: 'ko-KR-Chirp3-HD-Fenrir', gender: 'male', pitch: 154, tone: '들뜨고 흥분 잘하는' },
    { id: 'ko-KR-Chirp3-HD-Rasalgethi', gender: 'male', pitch: 155, tone: '차분히 알려 주는' },
    { id: 'ko-KR-Chirp3-HD-Achird', gender: 'male', pitch: 160, tone: '다정하고 친근한' },
    { id: 'ko-KR-Chirp3-HD-Zubenelgenubi', gender: 'male', pitch: 160, tone: '격식 없고 수더분한' },
    { id: 'ko-KR-Chirp3-HD-Puck', gender: 'male', pitch: 182, tone: '경쾌하고 명랑한' },
    { id: 'ko-KR-Chirp3-HD-Iapetus', gender: 'male', pitch: 184, tone: '맑고 또렷한' },
    { id: 'ko-KR-Chirp3-HD-Schedar', gender: 'male', pitch: 184, tone: '고르고 담담한' },
    { id: 'ko-KR-Chirp3-HD-Orus', gender: 'male', pitch: 190, tone: '단단하고 곧은' },
    // 여성 — 낮은 목소리부터
    { id: 'ko-KR-Chirp3-HD-Gacrux', gender: 'female', pitch: 176, tone: '성숙하고 원숙한' },
    { id: 'ko-KR-Chirp3-HD-Pulcherrima', gender: 'female', pitch: 178, tone: '적극적이고 당찬' },
    { id: 'ko-KR-Chirp3-HD-Aoede', gender: 'female', pitch: 203, tone: '산뜻하고 가벼운' },
    { id: 'ko-KR-Chirp3-HD-Laomedeia', gender: 'female', pitch: 211, tone: '명랑하고 쾌활한' },
    { id: 'ko-KR-Chirp3-HD-Autonoe', gender: 'female', pitch: 219, tone: '밝고 환한' },
    { id: 'ko-KR-Chirp3-HD-Despina', gender: 'female', pitch: 222, tone: '부드럽고 매끄러운' },
    { id: 'ko-KR-Chirp3-HD-Vindemiatrix', gender: 'female', pitch: 235, tone: '온화하고 상냥한' },
    { id: 'ko-KR-Chirp3-HD-Zephyr', gender: 'female', pitch: 235, tone: '밝고 화사한' },
    { id: 'ko-KR-Chirp3-HD-Kore', gender: 'female', pitch: 242, tone: '단호하고 똑 부러지는' },
    { id: 'ko-KR-Chirp3-HD-Achernar', gender: 'female', pitch: 246, tone: '여리고 부드러운' },
    { id: 'ko-KR-Chirp3-HD-Sulafat', gender: 'female', pitch: 246, tone: '따뜻하고 포근한' },
    { id: 'ko-KR-Chirp3-HD-Erinome', gender: 'female', pitch: 250, tone: '맑고 또렷한' },
    { id: 'ko-KR-Chirp3-HD-Leda', gender: 'female', pitch: 254, tone: '앳되고 어린' },
    { id: 'ko-KR-Chirp3-HD-Callirrhoe', gender: 'female', pitch: 262, tone: '느긋하고 편안한' },
  ];

  // 대본 언어별로 같은 목소리(같은 이름)를 씀: ko-KR-Chirp3-HD-Kore ↔ en-US-Chirp3-HD-Kore
  // (음높이·성격은 한국어 목소리로 잰 값. 같은 성우 모델이라 영어에서도 비슷함)
  const LOCALES = { ko: 'ko-KR', en: 'en-US' };
  const localeOf = (lang) => LOCALES[lang] || LOCALES.ko;
  const forLocale = (locale) => VOICES.map((v) => ({ ...v, id: v.id.replace(/^ko-KR-/, locale + '-') }));
  const ALL = Object.values(LOCALES).flatMap(forLocale);

  // 지문·괄호 지문을 읽는 해설 목소리. 배역과 섞이지 않게 AI 추천에서는 빼 둠
  const NARRATOR_NAME = 'Chirp3-HD-Rasalgethi';
  const narratorVoiceId = (lang) => `${localeOf(lang)}-${NARRATOR_NAME}`;
  const castable = (lang) => forLocale(localeOf(lang)).filter((v) => v.id !== narratorVoiceId(lang));
  const NARRATOR_VOICE_ID = narratorVoiceId('ko');
  const CASTABLE = castable('ko');

  // 'en-US-Chirp3-HD-Kore' → 'en-US', 다른 언어의 같은 목소리로 바꾸기
  const languageOf = (id) => String(id).slice(0, 5);
  const toLanguage = (id, lang) => String(id).replace(/^[a-z]{2}-[A-Z]{2}-/, localeOf(lang) + '-');

  const BY_ID = new Map(ALL.map((v) => [v.id, v]));
  const MIN_RATE = 0.7;
  const MAX_RATE = 1.4;

  function pitchWord(v) {
    const [low, high] = v.gender === 'male' ? [140, 175] : [215, 240];
    return v.pitch < low ? '낮은' : v.pitch > high ? '높은' : '중간';
  }

  // 화면에 보이는 이름: "남성 · 낮은 · 거칠고 묵직한"
  function voiceLabel(v) {
    return `${v.gender === 'male' ? '남성' : '여성'} · ${pitchWord(v)} · ${v.tone}`;
  }

  const isCloudVoice = (id) => BY_ID.has(id);
  const clampRate = (r) => Math.min(MAX_RATE, Math.max(MIN_RATE, Number(r) || 1));

  const api = { VOICES, CASTABLE, NARRATOR_VOICE_ID, LOCALES, MIN_RATE, MAX_RATE, castable, narratorVoiceId, languageOf, toLanguage, localeOf,
    voiceLabel, pitchWord, isCloudVoice, clampRate, getVoice: (id) => BY_ID.get(id) };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.VoiceCatalog = api;
})(this);
