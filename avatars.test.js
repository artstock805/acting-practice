// 실행: node --test
const test = require('node:test');
const assert = require('node:assert');
const A = require('./avatars.js');

const JIYEON = { gender: 'female', age: '20대', personality: '예민함', look: 'tired eyes, wet hair, beige trench coat' };
const ELDER = { gender: 'male', age: '60대 이상', personality: '완고함' };

test('portrait prompts describe age, gender and look in English for the image service', () => {
  const p = A.portraitPrompt({ profile: JIYEON, lang: 'ko' });
  assert.match(p, /Korean/);
  assert.match(p, /woman/);
  assert.match(p, /twenties/);
  assert.match(p, /tired eyes, wet hair, beige trench coat/);
  assert.match(p, /no text/);
  assert.doesNotMatch(p, /[가-힣]/);   // 한글 성격 설명은 그림 서비스에 보내지 않음
  assert.match(A.portraitPrompt({ profile: ELDER, lang: 'ko' }), /elderly man/);
  // AI 분석이 없으면 목소리 성별만으로
  assert.match(A.portraitPrompt({ profile: null, voiceGender: 'male', lang: 'en' }), /\bman\b/);
  assert.doesNotMatch(A.portraitPrompt({ profile: null, voiceGender: 'male', lang: 'en' }), /Korean/);
});

test('the same character always gets the same picture', () => {
  assert.strictEqual(A.seedOf('지연'), A.seedOf('지연'));
  assert.notStrictEqual(A.seedOf('지연'), A.seedOf('민수'));
  const url = A.portraitUrl('portrait of a woman', A.seedOf('지연'));
  assert.match(url, /^https:\/\/image\.pollinations\.ai\/prompt\/portrait%20of%20a%20woman\?/);
  assert.match(url, new RegExp(`seed=${A.seedOf('지연')}`));
  assert.match(url, /width=512&height=512/);
});

test('cartoon avatars follow gender and age, and only the mouth changes while talking', () => {
  const her = A.cartoonOptions({ name: '지연', profile: JIYEON });
  assert.ok(A.FEMALE_TOPS.includes(her.top));
  assert.strictEqual(her.facialHairProbability, 0);
  const him = A.cartoonOptions({ name: '할아버지', profile: ELDER });
  assert.ok(A.MALE_TOPS.includes(him.top));
  assert.strictEqual(him.hairColor, A.GRAY_HAIR);
  assert.deepStrictEqual(A.cartoonOptions({ name: '지연', profile: JIYEON }), her);   // 늘 같은 얼굴

  const closed = new URL(A.cartoonUrl(her, false));
  const open = new URL(A.cartoonUrl(her, true));
  assert.strictEqual(closed.origin + closed.pathname, 'https://api.dicebear.com/9.x/avataaars/svg');
  assert.notStrictEqual(closed.searchParams.get('mouth'), open.searchParams.get('mouth'));
  closed.searchParams.delete('mouth');
  open.searchParams.delete('mouth');
  assert.strictEqual(closed.toString(), open.toString());
  // 성별을 모르면 목소리 성별로
  assert.ok(A.MALE_TOPS.includes(A.cartoonOptions({ name: 'X', profile: null, voiceGender: 'male' }).top));
});
