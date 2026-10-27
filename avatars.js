// 상대 배역 아바타: AI 초상화(Pollinations) 또는 만화 아바타(DiceBear avataaars).
// 배역 분석(성별·나이·영어 외모 묘사)이나 목소리 성별로 얼굴을 정하고, 같은 배역은 늘 같은 얼굴(이름으로 고정한 seed).
// 무대에서는 그 배역이 말하는 동안 목소리 크기에 맞춰 움직임 (만화는 입이 열리고 닫힘)
(function (root) {
  'use strict';

  const PORTRAIT_URL = 'https://image.pollinations.ai/prompt/';
  const CARTOON_URL = 'https://api.dicebear.com/9.x/avataaars/svg';
  const AGE_WORDS = {
    '어린이': 'child', '10대': 'teenage', '20대': 'young adult in their twenties', '30대': 'adult in their thirties',
    '40대': 'middle-aged adult in their forties', '50대': 'adult in their fifties', '60대 이상': 'elderly',
  };
  const FEMALE_TOPS = ['bob', 'bun', 'curvy', 'longButNotTooLong', 'miaWallace', 'straight01', 'straight02', 'straightAndStrand', 'bigHair'];
  const MALE_TOPS = ['shortFlat', 'shortRound', 'shortWaved', 'shortCurly', 'theCaesar', 'theCaesarAndSidePart', 'sides'];
  const DARK_HAIR = ['2c1b18', '4a312c', '724133', 'a55728'];
  const GRAY_HAIR = 'e8e1e1';
  const KOREAN_SKIN = ['edb98a', 'ffdbb4', 'd08b5b'];
  const ANY_SKIN = ['614335', 'd08b5b', 'ae5d29', 'edb98a', 'ffdbb4'];
  const CLOTHING = ['blazerAndShirt', 'blazerAndSweater', 'collarAndSweater', 'hoodie', 'shirtCrewNeck', 'shirtScoopNeck', 'shirtVNeck'];
  const MOUTH_CLOSED = 'serious';
  const MOUTH_OPEN = 'disbelief';
  const BEARD_AGES = ['40대', '50대', '60대 이상'];

  // 이름 → 늘 같은 숫자 (FNV-1a)
  function seedOf(text) {
    let h = 0x811c9dc5;
    for (const ch of String(text)) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
    return h;
  }
  const pick = (list, seed, salt) => list[seedOf(`${seed}|${salt}`) % list.length];
  const genderOf = (profile, voiceGender) => (profile && ['male', 'female'].includes(profile.gender) ? profile.gender : voiceGender || 'unknown');

  // 그림 서비스에 보낼 영어 묘사 (한글 성격 설명은 보내지 않음: 영어 외모 묘사 look만)
  function portraitPrompt({ profile, voiceGender, lang }) {
    const gender = genderOf(profile, voiceGender);
    const age = profile && AGE_WORDS[profile.age];
    const who = [lang === 'ko' ? 'Korean' : '', age === 'elderly' ? 'elderly' : '', gender === 'male' ? 'man' : gender === 'female' ? 'woman' : 'person']
      .filter(Boolean).join(' ');
    const look = profile && typeof profile.look === 'string' ? profile.look.replace(/[가-힣]/g, '').trim() : '';
    return [
      `portrait of a ${who}`,
      age && age !== 'elderly' ? age : '',
      look,
      'theatrical stage lighting, head and shoulders, painterly realistic style, plain dark background, no text',
    ].filter(Boolean).join(', ');
  }

  function portraitUrl(prompt, seed) {
    return `${PORTRAIT_URL}${encodeURIComponent(prompt)}?width=512&height=512&seed=${seed}&nologo=true`;
  }

  // 만화 아바타 모양: 성별로 머리 모양, 나이로 흰머리·수염
  function cartoonOptions({ name, profile, voiceGender, lang }) {
    const gender = genderOf(profile, voiceGender);
    const age = profile ? profile.age : '';
    const tops = gender === 'male' ? MALE_TOPS : gender === 'female' ? FEMALE_TOPS : [...FEMALE_TOPS, ...MALE_TOPS];
    return {
      seed: String(name),
      top: pick(tops, name, 'top'),
      hairColor: age === '60대 이상' ? GRAY_HAIR : pick(DARK_HAIR, name, 'hair'),
      skinColor: pick(lang === 'en' ? ANY_SKIN : KOREAN_SKIN, name, 'skin'),
      clothing: pick(CLOTHING, name, 'clothing'),
      facialHairProbability: gender === 'male' && BEARD_AGES.includes(age) ? 100 : 0,
    };
  }

  // 입만 다른 두 장(닫힘·열림)을 번갈아 보여 말하는 것처럼
  function cartoonUrl(options, mouthOpen) {
    const params = new URLSearchParams({
      seed: options.seed, top: options.top, hairColor: options.hairColor, skinColor: options.skinColor,
      clothing: options.clothing, facialHairProbability: String(options.facialHairProbability),
      topProbability: '100', accessoriesProbability: '0', eyes: 'default', eyebrows: 'defaultNatural',
      mouth: mouthOpen ? MOUTH_OPEN : MOUTH_CLOSED,
    });
    return `${CARTOON_URL}?${params}`;
  }

  // ---------- 무대 위 아바타 ----------
  const OPEN_LEVEL = 0.28;     // 목소리 크기가 이보다 크면 입을 엶
  // 목소리 크기를 알 수 없을 때(기기 음성) 말하는 박자처럼 흉내 냄
  const fakeLevel = (t) => Math.abs(Math.sin(t / 110) * Math.sin(t / 290));

  // host: 아바타를 넣을 곳, getLevel(): 지금 목소리 크기 0~1 (모르면 null)
  function createStage(host, { getLevel }) {
    const box = document.createElement('div');
    box.className = 'avatar';
    box.hidden = true;
    const base = new Image();
    base.className = 'avatar-base';
    base.alt = '';
    const open = new Image();
    open.className = 'avatar-open';
    open.alt = '';
    box.append(base, open);
    host.append(box);
    let frame = 0;

    function stopLoop() {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      open.hidden = true;
      box.style.setProperty('--level', '0');
    }

    function loop(t) {
      const measured = getLevel();
      const level = measured === null || measured === undefined ? fakeLevel(t) : measured;
      box.style.setProperty('--level', level.toFixed(2));
      if (box.classList.contains('cartoon')) open.hidden = level < OPEN_LEVEL;
      frame = requestAnimationFrame(loop);
    }

    return {
      // set: { src, openSrc?, label } 또는 null (숨김)
      show(set) {
        if (!set) { this.hide(); return; }
        if (base.dataset.src !== set.src) { base.src = set.src; base.dataset.src = set.src; }
        if (set.openSrc && open.dataset.src !== set.openSrc) { open.src = set.openSrc; open.dataset.src = set.openSrc; }
        box.classList.toggle('cartoon', !!set.openSrc);
        box.title = set.label || '';
        open.hidden = true;
        box.hidden = false;
      },
      hide() { this.talk(false); box.hidden = true; },
      talk(on) {
        box.classList.toggle('talking', !!on);
        if (on && !frame && !box.hidden) frame = requestAnimationFrame(loop);
        if (!on) stopLoop();
      },
    };
  }

  const api = { seedOf, portraitPrompt, portraitUrl, cartoonOptions, cartoonUrl, createStage, FEMALE_TOPS, MALE_TOPS, GRAY_HAIR };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Avatars = api;
})(this);
