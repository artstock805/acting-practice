// 화면 흐름: 대본 입력 → 배역 설정 → 연습(상대역 낭독 + 내 대사 음성 인식)
(function () {
  'use strict';
  const K = window.ScriptKit;
  const S = window.Speech;
  const R = window.Recorder;
  const C = window.CloudSTT;
  const FI = window.FileImport;
  const STORE_KEY = 'acting-practice-v1';
  const V = window.VoiceKit;
  const VC = window.VoiceCatalog;
  const CT = window.CloudTTS;
  const IV = window.InsightView;
  const LV = window.LibraryView;
  const PP = window.PracticePlan;
  const SV = window.StatsView;
  const AV = window.Avatars;
  const PQ = window.PortraitQueue.createPortraitQueue();  // 무료 그림 서비스 한도(45초에 1장) 때문에 한 장씩 받고 이 기기에 저장
  const LOG = window.PracticeLog.createLog();
  const NARRATOR_VOICE = { voiceURI: '', pitch: 1, rateScale: 0.95 };
  // 대본 언어: state.lang = 'ko' | 'en' (자동 판별 또는 선택), state.langChoice = 'auto' | 'ko' | 'en'
  const scriptLang = () => (state.lang === 'en' ? 'en' : 'ko');
  const speechLocale = () => VC.localeOf(scriptLang());
  // 음성 인식은 대사마다 그 줄의 글자로 언어를 정함 (한국어 대본 속 영어 대사, 그 반대도 제대로 알아들음)
  const lineLocale = (item) => VC.localeOf(K.lineLanguage(speechOf(item), scriptLang()));
  const NARRATOR = '__narrator__';
  const APP_VERSION = 'v45';  // 화면 아래에 표시 (휴대폰이 새 버전을 받았는지 확인용). sw.js의 CACHE 번호와 같이 올림
  const DEFAULT_KEEP_GOING = 10;     // 계속 진행 기준(%): 인식률이 이보다 높으면 통과 기준 미달이어도 다음 대사로 진행
  const KEEP_GOING_PAUSE_MS = 1800;  // 넘어가기 전에 점수·틀린 곳을 보여 주는 시간
  const POST_SPEECH_GAP_MS = 350;  // 상대 대사가 끝나고 내 대사를 듣기 시작하기까지 쉬는 시간
  const $ = (id) => document.getElementById(id);
  const PHONE_OS = phoneOS();
  // 휴대폰은 녹음이 마이크를 잡으면 음성 인식에 무음만 들어감 → 인식이 되는 휴대폰에선 채점을 우선하고 녹음은 하지 않음
  const RECORD_BLOCKS_SCORING = !!PHONE_OS && S.canListen;
  // 서버(Cloud Run)가 있으면 휴대폰도 녹음 파일을 서버로 보내 채점 → 녹음과 채점을 둘 다 할 수 있음
  let cloudReady = false;
  const NOTE_PHONE_LOCAL = '📱 휴대폰에서는 음성 채점과 녹음을 동시에 할 수 없어, 채점을 우선하고 녹음은 하지 않습니다. 녹음해서 다시 들으려면 PC에서 연습하세요.';
  const NOTE_PHONE_CLOUD = '📱 휴대폰에서는 녹음을 서버로 보내 채점합니다. 말을 마치면 1~2초 뒤에 결과가 나와요. 녹음을 끄면 휴대폰 내장 인식으로 바로 채점합니다.';

  let state = loadState() || { text: '', items: [], cast: {}, opts: { mode: 'hint', threshold: 70, keepGoing: DEFAULT_KEEP_GOING, rate: 1, directions: false, aiImage: false, record: true, range: 'all', loop: false, avatar: 'off' }, index: 0, results: {}, lineStats: {} };
  let runToken = 0;
  let listener = null;
  let waiting = false;
  let currentImgScene = null;
  let avatarStage = null;  // 무대 위 상대 배역 얼굴 (Avatars.createStage)
  let takes = {};  // 대사 index → 녹음 blob URL (용량 때문에 저장하지 않고 이 창에서만 유지)

  // ---------- 저장 ----------
  function loadState() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)); } catch (_) { return null; }
  }
  function saveState() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (_) { /* 저장 불가 환경(시크릿 창 등)에서는 무시 */ }
  }
  function update(patch) { state = { ...state, ...patch }; saveState(); }

  // ---------- 화면 전환 ----------
  function showView(name) {
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === name));
    document.body.classList.toggle('practice-mode', name === 'practice');  // 연습 화면: 위쪽 고정, 대본 목록만 스크롤
    if (name !== 'practice') stopPlayback();
  }
  function enableTabs() {
    const hasCast = state.items.some((i) => i.type === 'line');
    document.querySelector('[data-view=cast]').disabled = !hasCast;
    document.querySelector('[data-view=practice]').disabled = !hasCast || !myNames().length;
    document.querySelector('[data-view=insight]').disabled = !hasCast;
  }

  // ---------- 1. 대본 ----------
  function parseAndGo() {
    const text = $('script-input').value;
    const choice = $('opt-lang').value;
    const lang = choice === 'auto' ? K.detectLanguage(text) : choice;
    update({ lang, langChoice: choice });
    S.setLanguage(VC.localeOf(lang));
    showDetectedLanguage();
    const items = K.parseScript(text);
    const chars = K.listCharacters(items);
    if (!chars.length) { alert('인물 대사를 찾지 못했습니다. "이름: 대사" 형식(영어는 "NAME: line"이나 대문자 이름 줄)인지 확인해 주세요.'); return; }
    const cast = {};
    chars.forEach((c, i) => {
      const kept = state.cast[c.name];
      // 같은 이름이 남아 있어도 Google 목소리는 대본 언어 쪽 같은 목소리로 바꿔 줌
      cast[c.name] = kept ? { ...kept, ...(kept.cloudVoice ? { cloudVoice: VC.toLanguage(kept.cloudVoice, lang) } : {}) } : { mine: i === 0 && !myNames().length, isNew: true };
    });
    // 새로 나온 상대 배역에게는 서로 다른 목소리를 자동 배분 (기존 인물 설정은 유지)
    const newOthers = chars.map((c) => c.name).filter((n) => cast[n].isNew && !cast[n].mine);
    const assigned = distributeAllVoices(newOthers, cast);
    Object.keys(cast).forEach((n) => { const { isNew, ...rest } = cast[n]; cast[n] = { ...rest, ...(assigned[n] || {}) }; });
    // 같은 대본이면 대사별 점수 기록(약한 대사)은 남기고, 대본이 바뀌면 지우고 연습 범위도 전체로
    const sameText = text === state.text;
    update({ text, items, cast, index: 0, results: {}, mergeDismissed: [], insight: sameText ? state.insight : null,
      lineStats: sameText ? state.lineStats || {} : {}, opts: sameText ? state.opts : { ...state.opts, range: 'all' } });
    renderCast();
    enableTabs();
    showView('cast');
  }

  // ---------- 인물 이름 오타 합치기 제안 ----------
  function renderMergeSuggestions(chars) {
    const dismissed = new Set(state.mergeDismissed || []);
    const suggestions = K.suggestNameMerges(chars).filter((s) => !dismissed.has(s.from));
    const list = $('merge-list');
    list.textContent = '';
    $('merge-box').hidden = !suggestions.length;
    suggestions.forEach((s) => {
      const li = el('li', { className: 'merge-item' });
      li.append(el('span', { className: 'merge-from', textContent: `${s.from} (대사 ${s.lines}줄)` }), el('span', { className: 'note', textContent: ` — ${s.reason}` }));
      const actions = el('div', { className: 'merge-actions' });
      s.to.forEach((to) => {
        const merge = el('button', { className: 'primary', textContent: `→ ${to}(으)로 합치기` });
        merge.onclick = () => renameChar(s.from, to);
        actions.append(merge);
      });
      const keep = el('button', { className: 'ghost', textContent: '다른 인물이에요' });
      keep.onclick = () => { update({ mergeDismissed: [...(state.mergeDismissed || []), s.from] }); renderCast(); };
      actions.append(keep);
      li.append(actions);
      list.append(li);
    });
  }

  // ---------- 2. 배역 ----------
  function myNames() { return Object.keys(state.cast).filter((n) => state.cast[n].mine); }

  function availableVoiceURIs() { return S.getKoreanVoices().map((v) => v.voiceURI); }

  // 서버가 있으면 Google 목소리를, 없으면(PC에서 파일로 열기 등) 이 기기의 음성을 나눠 줌
  function distributeAllVoices(names, cast) {
    if (CT.available) return distributeCloudVoices(names, cast);
    const device = V.distributeVoices(names, availableVoiceURIs());
    return Object.fromEntries(Object.entries(device).map(([n, v]) => [n, { ...v, cloudVoice: '' }]));
  }

  // 가장 낮은 목소리, 가장 높은 목소리, 그다음 낮은 목소리… 순서로 (이웃한 배역끼리 확실히 다르게)
  function interleaveByPitch(list) {
    const sorted = [...list].sort((a, b) => a.pitch - b.pitch);
    const out = [];
    for (let i = 0, j = sorted.length - 1; i <= j; i++, j--) {
      out.push(sorted[i]);
      if (i !== j) out.push(sorted[j]);
    }
    return out;
  }

  // AI 분석으로 성별을 알면 같은 성별 목소리를, 모르면 남녀를 번갈아 줌. 높고 낮은 목소리를 섞어 서로 구별되게 함
  function distributeCloudVoices(names, cast) {
    const voices = VC.castable(scriptLang());
    const pools = { male: interleaveByPitch(voices.filter((v) => v.gender === 'male')), female: interleaveByPitch(voices.filter((v) => v.gender === 'female')) };
    const used = { male: 0, female: 0 };
    let alternate = 0;
    return Object.fromEntries(names.map((name) => {
      const known = cast[name] && cast[name].profile && cast[name].profile.gender;
      const gender = known === 'male' || known === 'female' ? known : (alternate++ % 2 ? 'female' : 'male');
      const pool = pools[gender];
      const voice = pool[used[gender]++ % pool.length];
      const rateScale = cast[name] && typeof cast[name].rateScale === 'number' ? VC.clampRate(cast[name].rateScale) : 1;  // AI가 고른 속도는 유지
      return [name, { cloudVoice: voice.id, rateScale, persona: 'auto' }];
    }));
  }

  function renderCast() {
    const voices = S.getKoreanVoices();
    const clashes = V.findVoiceClashes(state.cast);
    const body = $('cast-body');
    body.textContent = '';
    const chars = K.listCharacters(state.items);
    renderMergeSuggestions(chars);
    chars.forEach(({ name, lines }) => {
      const cfg = state.cast[name];
      const tr = document.createElement('tr');
      tr.classList.toggle('is-mine', cfg.mine);
      tr.classList.toggle('has-clash', clashes.has(name));

      const mine = el('input', { type: 'checkbox', checked: cfg.mine, title: '내가 연기할 역할' });
      mine.onchange = () => setCast(name, { mine: mine.checked });

      const nameInput = el('input', { type: 'text', value: name, size: 10 });
      nameInput.onchange = () => renameChar(name, nameInput.value.trim());

      const preview = el('button', { className: 'ghost', textContent: '🔊', title: '미리 듣기' });
      preview.onclick = () => previewVoice(name);

      const face = cfg.mine ? null : avatarFor(name);
      const nameCell = face ? el('span', { className: 'cast-name' }) : nameInput;
      if (face) {
        const img = el('img', { className: 'cast-face', src: face.src, alt: '', title: face.label });
        if (face.portrait) img.dataset.portrait = face.portrait;
        nameCell.append(img, nameInput);
      }

      const cells = [mine, nameCell, document.createTextNode(String(lines)), voiceControls(name, cfg, voices, clashes.has(name)), preview];
      cells.forEach((n) => { const td = el('td'); td.append(n); tr.append(td); });
      body.append(tr);
    });
    $('voice-count').textContent = CT.available
      ? `${scriptLang() === 'en' ? '영어' : '한국어'} Google 목소리 ${VC.castable(scriptLang()).length}가지 중에서 고를 수 있어요. AI 분석을 누르면 배역에 맞게 골라 줍니다.`
      : voices.length > 1
      ? `이 브라우저의 한국어 음성 ${voices.length}개를 나눠 씁니다.`
      : '이 브라우저에는 한국어 음성이 1개뿐이라 높낮이·속도로 구분합니다. Edge에서 열면 음성이 더 많습니다.';
  }

  // 인물 한 명의 목소리 설정: 성격 프리셋 · 음성 · 높낮이 · 속도
  function voiceControls(name, cfg, voices, isClash) {
    const v = V.resolveVoice(cfg);
    const box = el('div', { className: 'voice-box' + (v.cloudVoice ? ' is-cloud' : '') });

    const preset = el('select', { title: '목소리 성격' });
    const current = V.matchPreset(cfg);
    preset.append(el('option', { value: 'custom', textContent: '직접 조절', selected: current === 'custom' }));
    Object.entries(V.PRESETS).forEach(([k, p]) => preset.append(el('option', { value: k, textContent: p.label, selected: current === k })));
    preset.onchange = () => {
      if (preset.value === 'custom') return;
      const p = V.PRESETS[preset.value];
      changeVoice(name, { persona: preset.value, pitch: p.pitch, rateScale: p.rateScale });
    };

    const voice = el('select', { title: '음성' });
    if (CT.available) {
      const cloud = el('optgroup', { label: 'Google 목소리 (자연스러움)' });
      VC.castable(scriptLang()).forEach((x) => cloud.append(el('option', { value: 'cloud:' + x.id, textContent: VC.voiceLabel(x), selected: v.cloudVoice === x.id })));
      voice.append(cloud);
    }
    const device = el('optgroup', { label: '이 기기의 음성' });
    device.append(el('option', { value: '', textContent: '기본 음성', selected: !v.cloudVoice && !v.voiceURI }));
    voices.forEach((x) => device.append(el('option', { value: x.voiceURI, textContent: V.shortVoiceName(x.name), selected: !v.cloudVoice && v.voiceURI === x.voiceURI })));
    voice.append(device);
    voice.onchange = () => changeVoice(name, voice.value.startsWith('cloud:')
      ? { cloudVoice: voice.value.slice('cloud:'.length) }
      : { cloudVoice: '', voiceURI: voice.value });

    // Google 목소리는 높낮이를 바꿀 수 없어 성격 프리셋·높낮이는 이 기기 음성일 때만 보여 줌
    box.append(...(v.cloudVoice ? [] : [preset]), voice,
      ...(v.cloudVoice ? [] : [slider('높낮이', 0.5, 2, 0.05, v.pitch, (val) => changeVoice(name, { pitch: val, persona: 'custom' }))]),
      slider('속도', VC.MIN_RATE, VC.MAX_RATE, 0.05, Math.min(VC.MAX_RATE, Math.max(VC.MIN_RATE, v.rateScale)), (val) => changeVoice(name, { rateScale: val, persona: 'custom' })));
    if (cfg.profile) box.append(profileNote(cfg.profile));
    if (isClash) box.append(el('div', { className: 'clash', textContent: '⚠ 다른 상대 배역과 목소리가 거의 같아요' }));
    return box;
  }

  function slider(label, min, max, step, value, onCommit) {
    const wrap = el('label', { className: 'slider' });
    const out = el('span', { textContent: value.toFixed(2) });
    const input = el('input', { type: 'range', min, max, step, value });
    input.oninput = () => { out.textContent = (+input.value).toFixed(2); };
    input.onchange = () => onCommit(+input.value);
    wrap.append(label + ' ', input, out);
    return wrap;
  }

  function changeVoice(name, patch) {
    setCast(name, patch);
    previewVoice(name);
  }

  function previewVoice(name) {
    const sampleLine = state.items.find((i) => i.type === 'line' && i.character === name);
    S.speak(sampleLine ? sampleLine.text : name, voiceCfg(name, null));
  }

  // AI가 읽어 낸 인물 정보: "남성 · 20대 — 소심하지만 야심 있는 회사원" (누르면 말투·추천 이유까지)
  function profileNote(p) {
    const gender = p.gender === 'male' ? '남성' : p.gender === 'female' ? '여성' : '성별 모름';
    const box = el('details', { className: 'profile' });
    box.append(el('summary', { textContent: `🤖 ${gender} · ${p.age} — ${p.personality}` }),
      el('p', { textContent: '말투: ' + p.speech }), el('p', { textContent: '목소리 추천 이유: ' + p.reason }));
    return box;
  }

  // 대본을 서버(Claude)로 보내 배역마다 성격을 읽고 목소리를 추천받아 바로 적용
  async function analyzeCast() {
    const btn = $('btn-ai-cast');
    const names = K.listCharacters(state.items).map((c) => c.name);
    if (!names.length) return;
    btn.disabled = true;
    setAiStatus('🤖 대본을 읽고 배역을 분석하는 중… (긴 대본은 30초~1분)');
    try {
      const res = await fetch('/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ script: state.text, characters: names, lang: scriptLang() }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `분석 실패 (${res.status})`);
      const cast = { ...state.cast };
      body.characters.forEach((c) => {
        const { name: sent, voice, rate, ...profile } = c;
        const name = cast[sent] ? sent : names.find((n) => n.slice(0, 40) === sent);  // 서버는 긴 이름을 40자로 자름
        if (!name) return;
        cast[name] = { ...cast[name], profile, ...(voice ? { cloudVoice: voice, rateScale: rate, persona: 'ai' } : {}) };
      });
      update({ cast });
      renderCast();
      setAiStatus(`✅ ${body.characters.length}명의 배역을 분석해 목소리를 골랐어요. 🔊로 들어 보고 마음에 안 들면 바꾸세요.`);
    } catch (err) {
      setAiStatus('⚠ ' + (err.message || 'AI 분석에 실패했습니다.'), true);
    } finally {
      btn.disabled = false;
    }
  }

  function setAiStatus(text, isError) {
    const box = $('ai-status');
    box.hidden = !text;
    box.textContent = text;
    box.classList.toggle('error', !!isError);
  }

  function autoAssignVoices() {
    const others = K.listCharacters(state.items).map((c) => c.name).filter((n) => !state.cast[n].mine);
    const assigned = distributeAllVoices(others, state.cast);
    const cast = Object.fromEntries(Object.entries(state.cast).map(([n, c]) => [n, { ...c, ...(assigned[n] || {}) }]));
    update({ cast });
    renderCast();
  }

  function setCast(name, patch) {
    update({ cast: { ...state.cast, [name]: { ...state.cast[name], ...patch } } });
    renderCast();
    enableTabs();
  }

  function renameChar(from, to) {
    if (!to || to === from) return renderCast();
    const items = K.renameCharacter(state.items, from, to);
    const cast = { ...state.cast };
    if (!cast[to]) cast[to] = { ...cast[from] };
    delete cast[from];
    update({ items, cast });
    renderCast();
  }

  // 대사 속 괄호 지문: 옵션과 상관없이 항상 화면에 보이고 해설 목소리로 읽음.
  // ('지문도 읽어 주기' 옵션은 따로 떨어진 지문 줄만 정함)
  // 채점·말 끝 기다리기는 항상 지문을 뺀 대사로 (지문을 소리 내 읽을 필요 없음)
  const speechOf = (item) => K.spokenText(item.text);
  const shownText = (item) => item.text;  // 대사 속 괄호 지문은 옵션과 상관없이 항상 보여 줌
  // 대사 맨 앞 괄호("(웃으며) 그래요")는 note로 따로 저장됨. 대본 목록과 낭독에는 다시 붙여 넣음
  // (대사 카드에는 이름 옆 쪽지로 이미 보이므로 카드 본문에는 넣지 않음)
  const withNote = (item) => (item.note ? `(${item.note}) ${item.text}` : item.text);
  const listText = withNote;

  // 첫 글자 힌트: 외울 대사만 줄이고, 보이는 지문은 그대로 둠 ("그… (웃으며) 가…")
  function hintText(item) {
    return K.splitAsides(item.text).map((p) => (p.aside ? `(${p.text})` : K.firstLetterHint(p.text))).join(' ');
  }

  async function speakLine(item, token) {
    for (const part of K.splitAsides(withNote(item))) {
      if (token !== runToken || !part.text) continue;
      await S.speak(part.text, part.aside ? voiceCfg(NARRATOR) : voiceCfg(item.character, item));
    }
  }

  async function speakAsides(item, token) {
    for (const part of K.splitAsides(item.text)) {
      if (token === runToken && part.aside && part.text) await S.speak(part.text, voiceCfg(NARRATOR));
    }
  }

  // 배역 중 누구라도 Google 목소리를 쓰면 해설도 Google 목소리로 (음질을 맞춤)
  function narratorVoice() {
    return CT.available && Object.values(state.cast).some((c) => c.cloudVoice && !c.mine)
      ? { ...NARRATOR_VOICE, cloudVoice: VC.narratorVoiceId(scriptLang()) } : NARRATOR_VOICE;
  }

  function voiceCfg(name, item) {
    const v = name === NARRATOR ? narratorVoice() : V.resolveVoice(state.cast[name]);
    const emotion = item ? K.detectEmotion(item.note) : null;
    return { ...v, rate: state.opts.rate, emotionKey: emotion && emotion.key };
  }

  function bindOptions() {
    const o = state.opts;
    $('opt-mode').value = o.mode;
    $('opt-threshold').value = o.threshold;
    $('opt-keep-going').value = o.keepGoing ?? DEFAULT_KEEP_GOING;  // 이 옵션이 생기기 전에 저장된 설정은 기본값
    $('opt-rate').value = o.rate;
    $('opt-directions').checked = o.directions;
    $('opt-ai-image').checked = o.aiImage;
    $('opt-avatar').value = avatarStyle();
    const recordLocked = RECORD_BLOCKS_SCORING && !cloudReady;
    $('opt-record').checked = o.record !== false && !recordLocked;
    $('opt-record').disabled = recordLocked;
    $('opt-record-note').hidden = !RECORD_BLOCKS_SCORING;
    $('opt-record-note').textContent = cloudReady ? NOTE_PHONE_CLOUD : NOTE_PHONE_LOCAL;
    const sync = () => {
      const avatarChanged = $('opt-avatar').value !== avatarStyle();
      update({ opts: { ...state.opts, mode: $('opt-mode').value, threshold: +$('opt-threshold').value, keepGoing: +$('opt-keep-going').value, rate: +$('opt-rate').value,
        directions: $('opt-directions').checked, aiImage: $('opt-ai-image').checked, avatar: $('opt-avatar').value,
        record: recordLocked ? o.record : $('opt-record').checked } });  // 휴대폰에서 강제로 끈 건 저장하지 않음
      if (avatarChanged) renderCast();
      $('transcript').dataset.mode = state.opts.mode;
      $('opt-threshold-val').textContent = state.opts.threshold + '%';
      $('opt-keep-going-val').textContent = state.opts.keepGoing + '%';
      $('opt-rate-val').textContent = state.opts.rate.toFixed(1) + '×';
      if (!$('opt-record').checked) R.release();  // 녹음을 끄면 열어 둔 마이크도 바로 놓아 줌
    };
    ['opt-mode', 'opt-threshold', 'opt-keep-going', 'opt-rate', 'opt-directions', 'opt-ai-image', 'opt-avatar', 'opt-record'].forEach((id) => { $(id).oninput = sync; $(id).onchange = sync; });
    sync();
    bindOptionHelp();
  }

  // ⓘ를 누르면 옵션 설명을 펼치고 다시 누르면 접음
  function bindOptionHelp() {
    document.querySelectorAll('.info-btn').forEach((btn) => {
      btn.onclick = () => {
        const help = $(btn.dataset.help);
        help.hidden = !help.hidden;
        btn.setAttribute('aria-expanded', String(!help.hidden));
      };
    });
  }

  // ---------- 4. 작품 분석 (초목표·관계도) ----------
  let insightSvg = null;

  const INSIGHT_TAB = '4. 분석';

  function goInsight() {
    showView('insight');
    setInsightTabMark('');  // 다른 탭에 있는 동안 끝난 결과(✅)를 봤으니 표시를 지움
    renderInsight();
  }

  // 분석이 진행 중(⏳)이거나 다른 탭에 있는 동안 끝났으면(✅) 탭 이름 옆에 표시
  function setInsightTabMark(mark) {
    document.querySelector('[data-view=insight]').textContent = mark ? `${INSIGHT_TAB} ${mark}` : INSIGHT_TAB;
  }

  function renderInsight() {
    const lineCounts = Object.fromEntries(K.listCharacters(state.items).map((c) => [c.name, c.lines]));
    insightSvg = IV.render($('insight-body'), state.insight, { lineCounts, mine: new Set(myNames()), onEdit: editInsight });
    $('insight-actions').hidden = !state.insight;
  }

  // 칸을 고치면 바로 저장 (화면은 다시 그리지 않아 글을 쓰는 중에 커서가 튀지 않음)
  function editInsight(pathKeys, value) {
    update({ insight: setIn(state.insight, pathKeys, value) });
  }

  function setIn(obj, [key, ...rest], value) {
    const copy = Array.isArray(obj) ? [...obj] : { ...obj };
    copy[key] = rest.length ? setIn(obj[key], rest, value) : value;
    return copy;
  }

  async function runInsight() {
    const btn = $('btn-insight');
    const names = K.listCharacters(state.items).map((c) => c.name);
    if (!names.length) return;
    if (state.insight && !confirm('지금 분석(직접 고친 내용 포함)을 새 분석으로 바꿀까요?')) return;
    const script = state.text;
    btn.disabled = true;
    // 진행 시간을 1초마다 올려 멈춘 게 아님을 보여 줌. 다른 탭에 가도 분석은 계속되고 결과는 받는 즉시 저장됨
    const started = Date.now();
    const tick = () => {
      const secs = Math.round((Date.now() - started) / 1000);
      setInsightStatus(`🤖 대본을 읽고 초목표와 관계를 정리하는 중… ${secs}초 지남 (긴 대본은 1분 안팎). 다른 탭에 가도 계속 진행되고, 끝나면 결과가 저장돼요.`);
    };
    tick();
    const timer = setInterval(tick, 1000);
    setInsightTabMark('⏳');
    let finished = '';
    try {
      const res = await fetch('/api/insight', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ script, characters: names, lang: scriptLang() }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `분석 실패 (${res.status})`);
      if (state.text !== script) throw new Error('분석하는 사이에 대본이 바뀌어 이 결과는 쓰지 않았어요. 다시 눌러 주세요.');
      update({ insight: body });
      renderInsight();
      const secs = Math.round((Date.now() - started) / 1000);
      setInsightStatus(`✅ ${secs}초 만에 작품 초목표, 배역 ${body.characters.length}명, 관계 ${body.relationships.length}개를 정리했어요. 칸을 눌러 직접 고칠 수 있어요.`);
      finished = '✅';
    } catch (err) {
      setInsightStatus('⚠ ' + (err.message || 'AI 분석에 실패했습니다.'), true);
      finished = '⚠';
    } finally {
      clearInterval(timer);
      btn.disabled = false;
      setInsightTabMark($('view-insight').classList.contains('active') ? '' : finished);
    }
  }

  async function copyInsightText() {
    const text = IV.toText(state.insight, new Set(myNames()));
    try {
      await navigator.clipboard.writeText(text);
      setInsightStatus('📋 분석 내용을 복사했어요. 노션·메신저에 붙여 넣으세요.');
    } catch (_) {
      setInsightStatus('⚠ 복사하지 못했어요. 브라우저가 복사를 막았을 수 있어요.', true);
    }
  }

  function setInsightStatus(text, isError) {
    const box = $('insight-status');
    box.hidden = !text;
    box.textContent = text;
    box.classList.toggle('error', !!isError);
  }

  // ---------- 3. 연습 ----------
  function goPractice() {
    if (!myNames().length) { alert('내 역할을 하나 이상 체크해 주세요.'); return; }
    showView('practice');
    renderTranscript();
    renderRangeOptions();
    renderItem(state.items[state.index] || state.items[0]);
    if (!S.canListen) setMic('⚠ 이 브라우저는 음성 인식을 지원하지 않습니다. Chrome·Edge·Safari를 쓰거나, 대사를 말한 뒤 ⏭를 누르세요.');
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // 연습 범위(전체·장면·약한 대사)를 차례로 진행. 반복이면 범위 끝에서 처음으로 (한 바퀴마다 범위를 다시 계산)
  async function play() {
    const token = ++runToken;
    waiting = false;
    setRetryButtons(false);
    let plan = practicePlan();
    const start = PP.startIndex(plan, state.index);
    if (start < 0) { showNoWeakLines(); return; }
    if (start !== state.index) { update({ index: start }); renderItem(state.items[start]); }
    $('btn-play').textContent = '⏸ 일시정지';
    const startedAt = Date.now();
    try {
      while (token === runToken) {
        const outcome = await step(state.items[state.index], token);
        if (token !== runToken) return;
        if (outcome === 'wait') { waiting = true; $('btn-play').textContent = '▶ 계속'; return; }
        let next = PP.nextIndex(plan, state.index, state.opts.loop);
        if (next >= 0 && next <= state.index) { plan = practicePlan(); next = plan.length ? plan[0] : -1; }  // 한 바퀴 돎: 통과한 약한 대사는 빠짐
        if (next < 0) break;
        update({ index: next });
      }
      if (token === runToken) { update({ index: state.items.length }); finish(); }
    } finally {
      LOG.addTime(Date.now() - startedAt);
    }
  }

  function stopPlayback() {
    runToken++;
    waiting = false;
    $('btn-done-speaking').hidden = true;
    if (avatarStage) avatarStage.talk(false);
    S.stopSpeaking();
    R.release();  // 연습을 멈추면 마이크를 놓아 다른 앱·음성 인식이 쓸 수 있게 함
    R.stopPlaying();
    resetReplayButton();
    if (listener) { listener.stop(); listener = null; }
    setMic('');
    $('btn-play').textContent = '▶ 시작';
  }

  // 앞으로 읽을 상대 대사·지문 몇 개를 미리 받아 두어 대사 사이 끊김을 줄임 (Google 목소리일 때만 실제로 받음)
  const PREFETCH_AHEAD = 3;
  function prefetchAhead(from) {
    state.items.slice(from, from + PREFETCH_AHEAD).forEach((item) => {
      if (item.type === 'direction' && state.opts.directions) S.prefetch(item.text, voiceCfg(NARRATOR));
      if (item.type !== 'line' || !state.cast[item.character]) return;
      if (state.cast[item.character].mine) { if (item.note) S.prefetch(item.note, voiceCfg(NARRATOR)); return; }
      K.splitAsides(withNote(item)).forEach((p) => S.prefetch(p.text, p.aside ? voiceCfg(NARRATOR) : voiceCfg(item.character, item)));
    });
  }

  async function step(item, token) {
    renderItem(item);
    prefetchAhead(state.index);
    if (item.type === 'scene') { await sleep(900); return 'next'; }
    if (item.type === 'direction') {
      if (state.opts.directions) { setRowPhase('speaking'); await S.speak(item.text, voiceCfg(NARRATOR)); setRowPhase(''); } else await sleep(700);
      return 'next';
    }
    if (!state.cast[item.character].mine) {
      setRowPhase('speaking');
      await speakLine(item, token);
      setRowPhase('');
      return 'next';
    }
    // 내 대사 맨 앞 괄호 지문("(웃으며) …")은 말하기 전에 해설 목소리로 읽어 줌 (중간 괄호는 내가 말하는 중이라 화면으로만)
    if (item.note) { setRowPhase('speaking'); await S.speak(item.note, voiceCfg(NARRATOR)); setRowPhase(''); if (token !== runToken) return 'stop'; }
    if (!speechOf(item)) { await speakAsides(item, token); return 'next'; }   // 내 대사가 지문뿐이면 지문만 읽고 넘어감
    if (!S.canListen) return 'wait';
    return listenForLine(item, token);
  }

  async function listenForLine(item, token) {
    const threshold = state.opts.threshold / 100;
    if (!(await hasMicrophone())) {
      if (token !== runToken) return 'wait';
      setMic(NO_MIC_MESSAGE);
      setRetryButtons(true);
      return 'wait';
    }
    // 상대 대사(스피커 소리)의 끝부분이 마이크에 섞이지 않게 잠깐 쉬고 듣기 시작
    await sleep(POST_SPEECH_GAP_MS);
    if (token !== runToken) return 'wait';
    if (useCloudScoring()) return listenViaServer(item, token, threshold);
    const recording = await startRecording();
    if (token !== runToken) { R.discard(); return 'wait'; }
    setMic((recording ? '⏺ 녹음 중 · ' : '') + '듣고 있어요… 대사를 말해 주세요.', true);
    prepareLiveLine(item);
    listener = S.listen({
      lang: lineLocale(item),
      onInterim: (t) => showInterim(item, t),
      shouldStopEarly: (t) => K.similarity(speechOf(item), t) >= Math.max(threshold, 0.9),
      silenceMs: K.silenceForLine(speechOf(item)),
      pickAlternative: (soFar, alternatives) => K.bestAlternative(speechOf(item), soFar, alternatives),
    });
    let spoken = '';
    const trace = listener.trace;
    try { spoken = await listener.promise; } catch (err) {
      R.discard();
      if (token !== runToken) return 'wait';
      setMic(micErrorMessage(err.message) + diagnosis(trace));
      return 'wait';
    }
    listener = null;
    if (token !== runToken) { R.discard(); return 'wait'; }
    if (recording) saveTake(state.index, await R.stop());
    return judgeLine(item, spoken, threshold, diagnosis(trace));
  }

  // 휴대폰 + 서버: 녹음 → 말이 끝나면 자동 정지 → 서버가 글자로 바꿔 줌 → 채점. 녹음은 다시 듣기에 그대로 씀
  async function listenViaServer(item, token, threshold) {
    setMic('⏺ 녹음 중 · 듣고 있어요… 대사를 말해 주세요.', true);
    listener = C.listen({
      lang: lineLocale(item),
      hint: speechOf(item),
      silenceMs: K.silenceForLine(speechOf(item)),
      maxMs: K.takeMsForLine(speechOf(item)),   // 긴 대사도 끝까지 녹음
      onPhase: (phase, ms) => {
        if (token !== runToken) return;
        $('btn-done-speaking').hidden = phase !== 'timed';
        if (phase === 'timed') setMic(`⏺ 녹음 중 · 대사를 말해 주세요 (최대 ${Math.round(ms / 1000)}초, 다 말했으면 ✔)`, true);
        else setMic('⏳ 채점 중…', true);
      },
    });
    const diag = listener.diag;
    let result;
    try { result = await listener.promise; } catch (err) {
      listener = null;
      if (token !== runToken) return 'wait';
      setMic(cloudErrorMessage(err) + cloudDiagnosis(diag));
      setRetryButtons(true);
      return 'wait';
    }
    listener = null;
    if (token !== runToken) return 'wait';
    if (result.blob) saveTake(state.index, result.blob);
    return judgeLine(item, pickFromSegments(speechOf(item), result), threshold, cloudDiagnosis(diag));
  }

  // 서버가 구간마다 준 인식 후보 중 대사에 가장 가까운 것을 앞에서부터 골라 이어 붙임
  function pickFromSegments(line, result) {
    if (!result.segments || !result.segments.length) return result.text;
    return result.segments.reduce((soFar, alternatives) => `${soFar} ${K.bestAlternative(line, soFar, alternatives)}`.trim(), '');
  }

  // 서버 채점이 실패했을 때: 오디오 상태, 들린 최대 소리 크기, 무음 감지 결과, 업로드 크기
  function cloudDiagnosis(d) {
    const upload = d.uploadKB === null ? '업로드 안 함' : `업로드 ${d.uploadKB}KB`;
    return `\n[진단] ${PHONE_OS} 서버채점 · 오디오 ${d.ctx || '?'} · 최대 ${d.peak.toFixed(4)} / 기준 ${d.threshold.toFixed(4)} · ${d.outcome || '?'} · ${upload}`;
  }

  function useCloudScoring() {
    return RECORD_BLOCKS_SCORING && cloudReady && state.opts.record !== false && R.canRecord;
  }

  async function judgeLine(item, spoken, threshold, failDetail) {
    const score = K.similarity(speechOf(item), spoken);
    recordResult(state.index, score);
    noteScore(item, spoken, score, threshold);
    showDiff(item, spoken, score);
    if (score >= threshold) { setMic('👏 좋아요!'); await sleep(700); return 'next'; }
    // 통과 기준에 못 미쳐도 '계속 진행 기준'을 넘으면 멈추지 않고 다음 대사로 (점수·틀린 곳은 남겨 두고 잠깐 보여 줌)
    if (score > (state.opts.keepGoing ?? DEFAULT_KEEP_GOING) / 100) {
      revealLine(item);
      setMic(`조금 달라요 (${Math.round(score * 100)}%). 다음 대사로 넘어가요.`);
      await sleep(KEEP_GOING_PAUSE_MS);
      return 'next';
    }
    setMic(spoken ? '조금 달라요. 다시 말하거나 통과 처리할 수 있어요.' : '소리가 들리지 않았어요. 마이크를 확인해 주세요.' + failDetail);
    revealLine(item);
    setRetryButtons(true);
    return 'wait';
  }

  function cloudErrorMessage(err) {
    if (err.name === 'NotAllowedError') return permissionMessage();
    if (err.name === 'NotFoundError') return NO_MIC_MESSAGE;
    if (err.server) return '🌐 ' + err.message + ' 🔁 다시 말하기를 누르세요.';
    return '🌐 음성을 서버로 보내지 못했습니다. 인터넷 연결을 확인하고 🔁 다시 말하기를 누르세요.';
  }

  async function startRecording() {
    if (state.opts.record === false || !R.canRecord || RECORD_BLOCKS_SCORING) return false;
    try { await R.start(); return true; } catch (err) {
      setMic(err.name === 'NotAllowedError' ? permissionMessage() : '녹음을 시작하지 못해 녹음 없이 계속합니다.');
      return false;
    }
  }

  // 마이크 장치가 하나라도 꽂혀 있는지 (권한 없이도 개수는 알 수 있음)
  async function hasMicrophone() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return true;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices.some((d) => d.kind === 'audioinput');
    } catch (_) { return true; }  // 확인 불가면 일단 시도
  }

  const NO_MIC_MESSAGE = '🎤 연결된 마이크가 없습니다. 마이크(이어폰 마이크·웹캠·USB 마이크)를 연결한 뒤 🔁 다시 말하기를 누르세요. 마이크 없이 하려면 대사를 말하고 ⏭를 누르세요.';

  function permissionMessage() {
    const isAppWindow = window.matchMedia('(display-mode: standalone)').matches || window.matchMedia('(display-mode: minimal-ui)').matches;
    return isAppWindow
      ? '🚫 마이크가 차단되어 있습니다. 창 오른쪽 위 ⋯ 메뉴 → 「사이트 권한」(또는 「앱 권한」)에서 마이크를 「허용」으로 바꾼 뒤 🔁 다시 말하기를 누르세요.'
      : '🚫 마이크가 차단되어 있습니다. 주소창 왼쪽의 🔒(또는 ⓘ) 아이콘 → 마이크 「허용」으로 바꾸고 새로고침하세요.';
  }

  function saveTake(index, blob) {
    if (!blob) return;
    if (takes[index]) URL.revokeObjectURL(takes[index]);
    takes = { ...takes, [index]: URL.createObjectURL(blob) };
    $('btn-my-take').hidden = false;
    refreshTranscriptRow(index);
  }

  // 이 장면을 상대역 음성 + 내 녹음으로 이어서 재생 (내 녹음이 없으면 대사만 표시하고 잠깐 쉼)
  async function replayScene() {
    const startItem = state.items[state.index];
    if (!startItem) return;
    stopPlayback();
    const token = runToken;
    const btn = $('btn-replay-scene');
    btn.textContent = '⏹ 재생 멈춤';
    btn.onclick = () => { stopPlayback(); resetReplayButton(); };
    const indexes = state.items.map((it, i) => i).filter((i) => state.items[i].type === 'line' && state.items[i].scene === startItem.scene);
    for (const i of indexes) {
      if (token !== runToken) return;
      const item = state.items[i];
      update({ index: i });
      renderItem(item);
      if (state.cast[item.character].mine) {
        revealLine(item);
        setMic(takes[i] ? '🎧 내 녹음 재생 중' : '(이 대사는 녹음이 없어요)');
        if (takes[i]) await R.play(takes[i]); else await sleep(1500);
      } else {
        setMic('');
        await speakLine(item, token);
      }
    }
    if (token === runToken) { setMic('장면 재생 끝'); resetReplayButton(); }
  }

  function resetReplayButton() {
    $('btn-replay-scene').textContent = '🎬 장면 다시 듣기';
    $('btn-replay-scene').onclick = replayScene;
  }

  // 인식이 실패했을 때 원인을 찾을 수 있게 이벤트 순서와 환경을 짧게 덧붙임
  function diagnosis(trace) {
    const ua = navigator.userAgent;
    const os = PHONE_OS || 'PC';
    const browser = /SamsungBrowser/.test(ua) ? 'Samsung' : /EdgA?\//.test(ua) ? 'Edge' : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'etc';
    const app = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone ? '앱' : '브라우저';
    const mic = R.isMicOpen() ? ' · 녹음마이크 열림' : '';
    return `\n[진단] ${os} ${browser} ${app}${mic} · ${(trace && trace.length ? trace.join(' → ') : '이벤트 없음')}`;
  }

  function phoneOS() {
    const ua = navigator.userAgent;
    if (/android/i.test(ua)) return 'Android';
    if (/iphone|ipad|ipod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'iOS';
    return '';
  }

  function micErrorMessage(code) {
    if (code === 'audio-capture') return NO_MIC_MESSAGE;
    if (code === 'not-allowed' || code === 'service-not-allowed') return permissionMessage();
    if (code === 'network') return '🌐 음성 인식 서버에 연결하지 못했습니다. 인터넷 연결을 확인하세요.';
    return '음성 인식 오류: ' + code;
  }

  function recordResult(index, score) { update({ results: { ...state.results, [index]: score } }); refreshTranscriptRow(index); }

  // ---------- 연습 범위·기록 ----------
  const isMineName = (name) => !!(state.cast[name] && state.cast[name].mine);
  const weakIndexes = () => PP.weakLines(state.items, state.lineStats || {}, isMineName, state.opts.threshold / 100);
  const practicePlan = () => PP.planIndexes(state.items, state.opts.range || 'all', { isMine: isMineName, weak: weakIndexes() });
  const RANGE_TITLE_MAX = 18;

  // 채점 결과를 대사별 기록(약한 대사 판단)과 날짜별 연습 기록에 남김
  function noteScore(item, spoken, score, threshold) {
    update({ lineStats: PP.addScore(state.lineStats || {}, state.index, score) });
    const missed = K.wordDiff(speechOf(item), spoken).filter((w) => !w.ok).map((w) => w.word);
    LOG.record({ score, passed: score >= threshold, missed });
    renderRangeOptions();
  }

  function renderRangeOptions() {
    const scenes = PP.scenesOf(state.items).map((s) => [s.key, s.title.length > RANGE_TITLE_MAX ? s.title.slice(0, RANGE_TITLE_MAX) + '…' : s.title]);
    const options = [['all', '전체'], ...scenes, ['weak', `⚠ 약한 대사만 (${weakIndexes().length})`]];
    $('opt-range').replaceChildren(...options.map(([value, label]) => el('option', { value, textContent: label })));
    $('opt-range').value = options.some(([v]) => v === state.opts.range) ? state.opts.range : 'all';
    $('opt-loop').checked = !!state.opts.loop;
  }

  function showNoWeakLines() {
    renderLineCard({ who: '⚠ 약한 대사', note: '', text: '통과 기준보다 낮게 나온 대사가 없어요. 전체나 장면을 골라 연습해 보세요.', mine: false, hidden: false });
  }

  function setRange(range) {
    stopPlayback();
    update({ opts: { ...state.opts, range } });
    renderRangeOptions();
    const start = PP.startIndex(practicePlan(), state.index);
    if (start < 0) { showNoWeakLines(); return; }
    jumpTo(start, false);
  }

  // ⏭·통과 처리: 범위 안의 다음 항목으로 (범위 끝이면 반복하거나 끝냄)
  function advance(resume) {
    const next = PP.nextIndex(practicePlan(), state.index, state.opts.loop);
    if (next < 0) { stopPlayback(); update({ index: state.items.length }); finish(); return; }
    jumpTo(next, resume);
  }

  function openStats() {
    const stats = state.lineStats || {};
    const weak = weakIndexes().map((i) => ({ who: state.items[i].character, text: speechOf(state.items[i]), last: stats[i].last, tries: stats[i].tries }));
    SV.render($('stats-dialog'), {
      log: LOG,
      weak,
      onPracticeWeak: () => {
        if (!$('view-practice').classList.contains('active')) goPractice();
        setRange('weak');
        play();
      },
    });
  }

  function finish() {
    const scores = Object.values(state.results);
    const avg = scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 100) : 0;
    $('btn-play').textContent = '↺ 처음부터';
    const weak = weakIndexes().length;
    const summary = scores.length ? `수고했어요! 내 대사 ${scores.length}개, 평균 정확도 ${avg}%` : '수고했어요!';
    renderLineCard({ who: '🎬 끝', note: '', text: summary + (weak ? ` · 약한 대사 ${weak}개는 '⚠ 약한 대사만'으로 다시 연습해 보세요` : ''), mine: false, hidden: false });
    setMic('');
  }

  function jumpTo(index, autoplay) {
    stopPlayback();
    update({ index: Math.max(0, Math.min(state.items.length - 1, index)) });
    renderItem(state.items[state.index]);
    if (autoplay) play();
  }

  function nextLineIndex(from, dir) {
    let i = from + dir;
    while (i > 0 && i < state.items.length - 1 && state.items[i].type !== 'line') i += dir;
    return i;
  }

  // ---------- 렌더링 ----------
  function renderItem(item) {
    if (!item) return;
    $('line-diff').textContent = '';
    setRetryButtons(false);
    $('btn-my-take').hidden = !takes[state.index];
    updateStage(item);
    showAvatar(item);
    $('progress-bar').style.width = ((state.index + 1) / state.items.length) * 100 + '%';
    updateCounter();
    markCurrentRow();
    // 지문·장면 줄에서도 카드가 지난 대사에 머물지 않고, 아래 목록에서 강조된 줄과 같은 내용을 보여 줌
    if (item.type === 'scene') return renderLineCard({ who: '🎬 장면', note: '', text: item.text, mine: false, hidden: false });
    if (item.type === 'direction') return renderLineCard({ who: '📜 지문', note: '', text: item.text, mine: false, hidden: false });
    const mine = state.cast[item.character] && state.cast[item.character].mine;
    const mode = state.opts.mode;
    const text = mine && mode === 'hint' ? hintText(item) : shownText(item);
    renderLineCard({ who: item.character + (mine ? ' (나)' : ''), note: item.note, text, mine, hidden: mine && mode === 'hidden' });
  }

  // 상황판 위쪽 "대사 12 / 340": 지문·장면 줄에서는 바로 다음 대사 번호를 보여 줌
  function updateCounter() {
    const total = lineOrdinals.size;
    let i = state.index;
    while (i < state.items.length && !lineOrdinals.has(i)) i++;
    const n = lineOrdinals.get(i) || total;
    $('stage-count').textContent = total ? `대사 ${n} / ${total}` : '';
  }

  function renderLineCard({ who, note, text, mine, hidden }) {
    $('line-who').textContent = who;
    $('line-note').textContent = note || '';
    const emotion = K.detectEmotion(note);
    $('line-note').style.background = emotion ? emotion.color + '33' : '';
    $('line-text').replaceChildren(...(hidden ? maskedParts(text) : [text]));
    $('line-text').classList.toggle('is-hidden', !!hidden);
    $('line-card').classList.toggle('is-mine', !!mine);
  }

  // 숨기기(암기 테스트): 외울 말만 가리고, 대사 속 (괄호 지문)은 그대로 보여 줌
  function maskedParts(text) {
    return K.splitAsides(text).flatMap((p, i) => [
      ...(i ? [' '] : []),
      p.aside ? el('span', { className: 'aside', textContent: `(${p.text})` }) : el('span', { className: 'masked', textContent: p.text }),
    ]);
  }

  function revealLine(item) { $('line-text').textContent = shownText(item); $('line-text').classList.remove('is-hidden'); }

  function showDiff(item, spoken, score) {
    const box = $('line-diff');
    box.textContent = '';
    box.append(el('span', { className: 'score', textContent: Math.round(score * 100) + '%' }));
    K.wordDiff(speechOf(item), spoken).forEach((w) => { box.append(el('span', { className: 'w ' + (w.ok ? 'ok' : 'bad'), textContent: w.word })); box.append(' '); });
  }

  function sceneMood(scene) {
    const sceneText = state.items.filter((i) => i.scene === scene && i.type !== 'line').map((i) => i.text).join(' ');
    return K.detectMood(sceneText || scene);
  }

  function updateStage(item) {
    const mood = sceneMood(item.scene);
    $('stage').style.background = mood ? `linear-gradient(135deg, ${mood.bg[0]}, ${mood.bg[1]})` : '';
    $('stage-emoji').textContent = mood ? mood.emoji : '🎬';
    $('stage-scene').textContent = item.scene || '장면 정보 없음';
    if (item.type === 'direction') $('stage-direction').textContent = item.text;
    if (item.type === 'scene') $('stage-direction').textContent = '';
    updateStageImage(item.scene, mood);
  }

  // ---------- 상대 배역 얼굴 (AI 초상화·만화 아바타) ----------
  const isOtherLine = (item) => !!item && item.type === 'line' && !(state.cast[item.character] && state.cast[item.character].mine);

  // 옵션·배역 분석(성별·나이·영어 외모 묘사)·목소리 성별로 얼굴 그림 주소를 정함. 끄면 null
  // 얼굴 모양 옵션: 끄기 / portrait(사실풍) / anime(지브리풍). 예전의 '만화 아바타'(cartoon)는 지브리풍으로 바꿈
  const avatarStyle = () => (state.opts.avatar === 'cartoon' ? 'anime' : state.opts.avatar || 'off');

  // urgent: 지금 말하는 배역이면 초상화를 먼저 받음
  function avatarFor(name, { urgent = false } = {}) {
    const style = avatarStyle();
    const cfg = state.cast[name];
    if (!cfg || !style || style === 'off') return null;
    const voice = cfg.cloudVoice ? VC.getVoice(cfg.cloudVoice) : null;
    const who = { name, profile: cfg.profile || null, voiceGender: voice ? voice.gender : undefined, lang: scriptLang() };
    const look = AV.cartoonOptions(who);
    const cartoon = { src: AV.cartoonUrl(look, false), openSrc: AV.cartoonUrl(look, true), label: name };
    // AI 초상화(사실풍·애니메이션풍): 받아 둔 게 있으면 그것, 아니면 받는 동안 만화 얼굴로 대신 (입도 움직임)
    const portrait = AV.portraitUrl(AV.portraitPrompt({ ...who, style: style === 'anime' ? 'anime' : 'realistic' }), AV.seedOf(name));
    const ready = PQ.ready(portrait);
    if (ready) return { src: ready, label: name, portrait };
    PQ.request(portrait, { urgent }).catch(() => { /* 못 받으면 만화 얼굴 그대로 */ });
    return { ...cartoon, label: `${name} (초상화 그리는 중…)`, portrait };
  }

  // 초상화를 다 받으면 배역표 미리보기와 무대 얼굴만 그 자리에서 바꿈 (배역표를 다시 그리지 않아 입력 중인 이름이 안 끊김)
  function onPortraitReady(url) {
    document.querySelectorAll('img.cast-face').forEach((img) => { if (img.dataset.portrait === url) img.src = PQ.ready(url); });
    const item = state.items[state.index];
    if (avatarStage && isOtherLine(item)) {
      const face = avatarFor(item.character);
      if (face && face.portrait === url) avatarStage.show(face);
    }
  }

  // 상대 대사면 그 배역 얼굴, 내 대사·지문 동안은 마지막 상대 얼굴을 그대로 (듣는 표정), 장면이 바뀌면 숨김
  function showAvatar(item) {
    if (!avatarStage) return;
    if (isOtherLine(item)) avatarStage.show(avatarFor(item.character, { urgent: true }));
    else if (item.type === 'scene' || avatarStyle() === 'off') avatarStage.hide();
    $('stage').classList.toggle('has-avatar', !$('stage').querySelector('.avatar').hidden);
  }

  // 무료·무키 이미지 생성 서비스(Pollinations). 옵션을 켰을 때만 장면 제목을 전송
  function updateStageImage(scene, mood) {
    const img = $('stage-img');
    if (!state.opts.aiImage || !scene) { img.hidden = true; currentImgScene = null; return; }
    if (scene === currentImgScene) return;
    currentImgScene = scene;
    const prompt = `cinematic film still, ${mood ? mood.key : ''} scene, ${scene.replace(/S\s*#\s*\d+\.?/i, '')}, moody lighting, no text`;
    img.hidden = true;
    img.onload = () => { img.hidden = false; };
    img.onerror = () => { img.hidden = true; };
    // 배역 초상화와 같은 무료 서비스라 같은 받기 줄로 (지금 장면이 먼저)
    const url = 'https://image.pollinations.ai/prompt/' + encodeURIComponent(prompt) + '?width=960&height=420&nologo=true';
    PQ.request(url, { urgent: true }).then((src) => { if (currentImgScene === scene) img.src = src; }, () => {});
  }

  // 연습 목록: 화면 전환 때 한 번만 전체를 만들고, 채점·녹음 뒤에는 그 줄만 바꿈 (긴 대본에서 휴대폰이 멈칫하지 않게)
  // 장면 제목·지문 줄도 넣어서, 위 상황판에 무엇이 나오든 아래 목록의 같은 줄이 강조되게 함
  let transcriptRows = new Map();
  let lineOrdinals = new Map();  // 항목 번호 → 몇 번째 대사인지 (상황판의 "12 / 340")

  function renderTranscript() {
    const rows = new Map();
    const frag = document.createDocumentFragment();
    const ordinals = new Map();
    state.items.forEach((item, index) => {
      if (item.type === 'line') ordinals.set(index, ordinals.size + 1);
      const li = transcriptRow(item, index);
      rows.set(index, li);
      frag.append(li);
    });
    transcriptRows = rows;
    lineOrdinals = ordinals;
    $('transcript').replaceChildren(frag);
    $('transcript').dataset.mode = state.opts.mode;  // 힌트·숨기기면 내가 말하는 동안 목록의 원문을 흐리게
  }

  function refreshTranscriptRow(index) {
    const old = transcriptRows.get(index);
    if (!old) return;
    const li = transcriptRow(state.items[index], index);
    transcriptRows = new Map(transcriptRows).set(index, li);
    old.replaceWith(li);
  }

  function markCurrentRow() {
    const prev = $('transcript').querySelector('li.current');
    if (prev) prev.classList.remove('current', 'speaking', 'listening');
    const cur = transcriptRows.get(state.index);
    if (!cur) return;
    cur.classList.add('current');
    scrollWithinList(cur);
  }

  // 지금 줄이 무엇을 하는 중인지 목록에도 표시: 상대역이 읽는 중(speaking) · 내가 말할 차례(listening)
  function setRowPhase(phase) {
    if (avatarStage) avatarStage.talk(phase === 'speaking' && isOtherLine(state.items[state.index]));
    const cur = transcriptRows.get(state.index);
    if (!cur) return;
    cur.classList.toggle('speaking', phase === 'speaking');
    cur.classList.toggle('listening', phase === 'listening');
  }

  // 지금 줄이 보이도록 목록 상자 안에서만 스크롤함. scrollIntoView는 화면 전체도 움직여서,
  // 목록이 길게 펼쳐지는 휴대폰에서는 대사 카드가 화면 밖으로 밀려나고 매번 긴 페이지를 다시 그렸음
  function scrollWithinList(row) {
    const list = $('transcript');
    if (list.scrollHeight <= list.clientHeight) return;
    const offset = row.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;
    list.scrollTop = offset - (list.clientHeight - row.offsetHeight) / 2;
  }

  function transcriptRow(item, index) {
    if (item.type !== 'line') {
      const li = el('li', { className: item.type === 'scene' ? 'scene-row' : 'dir-row', textContent: item.type === 'scene' ? item.text : `(${item.text})` });
      li.dataset.index = index;
      li.classList.toggle('current', index === state.index);
      li.onclick = () => jumpTo(index, false);
      return li;
    }
    const mine = state.cast[item.character] && state.cast[item.character].mine;
    const li = el('li', { className: mine ? 'mine' : '' });
    li.dataset.index = index;
    li.append(el('b', { textContent: item.character }), el('span', { className: 'row-text', textContent: listText(item) }));
    if (takes[index]) {
      const play = el('button', { className: 'take', textContent: '🎧', title: '내 녹음 듣기' });
      play.onclick = (e) => { e.stopPropagation(); R.play(takes[index]); };
      li.append(play);
    }
    const score = state.results[index];
    if (score !== undefined) {
      const ok = score >= state.opts.threshold / 100;
      li.append(el('span', { className: 'tag', textContent: Math.round(score * 100) + '%', style: `color: var(--${ok ? 'ok' : 'bad'})` }));
    }
    li.classList.toggle('current', index === state.index);
    li.onclick = () => jumpTo(index, false);
    return li;
  }

  // 말하는 동안 보여 주기 (긴 대사에서 원문과 인식 중인 말이 겹쳐 쌓이지 않게)
  // '전체 보기'면 원문에서 이미 말한 낱말을 초록으로 칠하고, 힌트·숨기기면 진행도와 들린 말의 끝부분만 한 줄로
  const INTERIM_TAIL = 24;
  let liveWords = [];

  function prepareLiveLine(item) {
    liveWords = [];
    if (state.opts.mode !== 'full') return;
    const parts = K.splitAsides(shownText(item)).flatMap((p) => (p.aside
      ? [el('span', { className: 'aside', textContent: `(${p.text}) ` })]
      : p.text.split(/\s+/).filter(Boolean).map((w) => {
        const span = el('span', { className: 'word', textContent: w + ' ' });
        liveWords.push(span);
        return span;
      })));
    $('line-text').replaceChildren(...parts);
  }

  // 지금 어디까지 말했는지: 앞에서부터 맞은 낱말을 따라가다 3개 연속으로 안 맞으면 멈춤
  // (뒤쪽의 '다'·'그' 같은 짧은 낱말이 앞에서 한 말과 우연히 맞아 미리 칠해지지 않게)
  const MISSES_TO_STOP = 3;
  function spokenSoFar(diff) {
    let frontier = -1;
    let misses = 0;
    for (let i = 0; i < diff.length && misses < MISSES_TO_STOP; i++) {
      if (diff[i].ok) { frontier = i; misses = 0; } else misses++;
    }
    return diff.map((w, i) => w.ok && i <= frontier);
  }

  function showInterim(item, heard) {
    const said = spokenSoFar(K.wordDiff(speechOf(item), heard));
    const progress = `${said.filter(Boolean).length}/${said.length}`;
    if (!liveWords.length) {
      const tail = heard.length > INTERIM_TAIL ? '…' + heard.slice(-INTERIM_TAIL) : heard;
      setMic(`🎙 (${progress}) ${tail}`, true);
      return;
    }
    liveWords.forEach((span, i) => span.classList.toggle('said', !!said[i]));
    setMic(`🎙 듣는 중 · ${progress}`, true);
    // 긴 대사가 카드 안에서 스크롤될 때 마지막으로 말한 낱말이 보이게
    const last = liveWords.filter((s) => s.classList.contains('said')).pop();
    const box = $('line-text');
    if (last && box.scrollHeight > box.clientHeight) box.scrollTop = last.offsetTop - box.offsetTop - box.clientHeight / 2;
  }

  function setMic(text, listening) {
    $('mic-status').textContent = text;
    $('mic-status').classList.toggle('listening', !!listening);
    setRowPhase(listening ? 'listening' : '');
  }
  function setRetryButtons(show) { ['btn-retry', 'btn-reveal', 'btn-pass'].forEach((id) => { $(id).hidden = !show; }); }

  function el(tag, props) {
    const node = document.createElement(tag);
    Object.entries(props || {}).forEach(([k, v]) => { if (k === 'style') node.setAttribute('style', v); else node[k] = v; });
    return node;
  }

  // ---------- 대본 파일 열기 (txt·PDF·docx·hwp…) ----------
  async function importScriptFile(file) {
    if (file.size > FI.MAX_FILE_BYTES) { setImportStatus(`⚠ 파일이 너무 큽니다(${Math.round(FI.MAX_FILE_BYTES / 1024 / 1024)}MB까지).`, true); return; }
    setImportStatus(`📄 ${file.name} 읽는 중…`);
    try {
      const { text } = await FI.extractScriptText({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
      $('script-input').value = text;
      const detected = K.detectLanguage(text) === 'en' ? ' (영어 대본으로 보여요)' : '';
      setImportStatus(`✅ ${file.name}에서 ${text.split('\n').length}줄을 불러왔어요${detected}. 내용을 확인하고 '대본 분석'을 누르세요.`);
    } catch (err) {
      const message = err instanceof FI.ImportError ? err.message : `파일을 읽지 못했습니다. (${err.message})`;
      setImportStatus('⚠ ' + message, true);
    }
  }

  // 파일 선택 창을 연 시각. 고르는 동안 휴대폰이 메모리 부족으로 앱을 다시 시작하면 다음 실행 때 알아차려 안내함
  const PICKER_KEY = 'acting-practice-picker-opened';
  const PICKER_RESTART_WINDOW_MS = 10 * 60 * 1000;
  const pickerMark = {
    set() { try { sessionStorage.setItem(PICKER_KEY, String(Date.now())); } catch (_) { /* 저장 불가 브라우저 */ } },
    take() {
      try { const t = Number(sessionStorage.getItem(PICKER_KEY)); sessionStorage.removeItem(PICKER_KEY); return t || 0; } catch (_) { return 0; }
    },
  };

  // 파일 종류 제한(accept)은 두지 않음: 안드로이드는 .hwp 같은 확장자의 형식을 몰라, 골라도 앱에 파일을 넘기지 않음.
  // 어떤 파일이든 받아서 fileimport.js가 형식을 직접 판별하고, 대본이 아니면 안내 문구를 보여 줌.
  // 단계마다 상태를 보여 줘서 휴대폰에서 어디서 멈추는지 알 수 있게 함
  function bindFilePicker() {
    const input = $('file-input');
    input.addEventListener('click', () => {
      pickerMark.set();
      setImportStatus('📂 파일을 고르는 중… 고르고 돌아오면 바로 읽어요.');
    });
    input.addEventListener('cancel', () => { pickerMark.take(); setImportStatus('파일 선택을 취소했어요.'); });
    input.onchange = (e) => {
      pickerMark.take();
      const file = e.target.files && e.target.files[0];
      e.target.value = '';  // 같은 파일을 다시 골라도 다시 읽도록
      if (file) importScriptFile(file);
      else setImportStatus('⚠ 고른 파일을 받지 못했습니다. 파일 앱(내 파일)에서 대본 파일을 다시 골라 주세요.', true);
    };
  }

  // 파일을 고르러 간 사이 앱이 다시 시작됐으면(휴대폰이 뒤로 간 화면을 정리) 그 사실을 알려 줌
  function checkPickerRestart() {
    const openedAt = pickerMark.take();
    if (openedAt && Date.now() - openedAt < PICKER_RESTART_WINDOW_MS) {
      setImportStatus('⚠ 파일을 고르는 동안 앱이 다시 시작되어 파일을 받지 못했습니다(휴대폰 메모리 부족 등). 다른 앱을 닫고 다시 시도하거나, 브라우저에서 열어 다시 골라 주세요.', true);
    }
  }

  function setImportStatus(text, isError) {
    const box = $('import-status');
    box.hidden = !text;
    box.textContent = text;
    box.classList.toggle('error', !!isError);
  }

  // ---------- 이벤트 ----------
  function bindEvents() {
    const openView = { practice: goPractice, insight: goInsight };
    document.querySelectorAll('.tab').forEach((t) => { t.onclick = () => (openView[t.dataset.view] || (() => showView(t.dataset.view)))(); });
    $('btn-sample').onclick = () => { $('script-input').value = window.SAMPLE_SCRIPT; showDetectedLanguage(); };
    $('btn-library').onclick = openLibrary;
    $('btn-sample-en').onclick = () => { $('script-input').value = window.SAMPLE_SCRIPT_EN; showDetectedLanguage(); };
    $('opt-lang').onchange = showDetectedLanguage;
    $('script-input').addEventListener('input', showDetectedLanguage);
    bindFilePicker();
    $('btn-parse').onclick = parseAndGo;
    $('btn-to-practice').onclick = goPractice;
    $('btn-auto-voices').onclick = autoAssignVoices;
    $('btn-ai-cast').onclick = analyzeCast;
    $('btn-insight').onclick = runInsight;
    $('btn-insight-png').onclick = () => insightSvg && IV.saveGraphImage(insightSvg).catch((err) => setInsightStatus('⚠ ' + err.message, true));
    $('btn-insight-copy').onclick = copyInsightText;
    $('btn-phone').onclick = () => { $('phone-dialog').showModal(); loadQrLibrary().then(showPhoneQr, () => { /* 못 불러오면 기본 QR 그림을 그대로 둠 */ }); };
    $('btn-play').onclick = () => {
      S.unlock();  // iOS는 첫 음성을 사용자 터치 안에서 내야 이후 낭독이 허용됨
      if (state.index >= state.items.length) { update({ index: 0, results: {} }); renderTranscript(); return play(); }
      const isRunning = $('btn-play').textContent.startsWith('⏸');
      if (isRunning) stopPlayback(); else play();
    };
    $('btn-next').onclick = () => {
      const item = state.items[state.index];
      const resume = waiting || $('btn-play').textContent.startsWith('⏸');
      if (waiting && item && item.type === 'line' && !S.canListen) recordResult(state.index, 1);
      advance(resume);
    };
    $('btn-prev').onclick = () => jumpTo(nextLineIndex(state.index, -1), false);
    $('btn-retry').onclick = () => play();
    $('btn-reveal').onclick = () => revealLine(state.items[state.index]);
    $('btn-my-take').onclick = () => { if (takes[state.index]) R.play(takes[state.index]); };
    resetReplayButton();
    // 소리 크기를 못 재는 휴대폰: 정해진 시간을 다 기다리지 않고 바로 채점
    $('btn-done-speaking').onclick = () => { $('btn-done-speaking').hidden = true; if (listener && listener.finish) listener.finish(); };
    $('btn-pass').onclick = () => {
      recordResult(state.index, 1);
      update({ lineStats: PP.addScore(state.lineStats || {}, state.index, 1) });  // 통과 처리한 대사는 약한 대사에서 빠짐
      renderRangeOptions();
      advance(true);
    };
    $('opt-range').onchange = (e) => setRange(e.target.value);
    $('opt-loop').onchange = (e) => update({ opts: { ...state.opts, loop: e.target.checked } });
    $('btn-stats').onclick = openStats;
    document.addEventListener('keydown', (e) => {
      const typing = ['TEXTAREA', 'INPUT', 'SELECT'].includes(document.activeElement.tagName);
      if (e.code === 'Space' && !typing && $('view-practice').classList.contains('active')) { e.preventDefault(); $('btn-next').click(); }
    });
  }

  // ---------- 휴대폰에서 열기 QR ----------
  // 지금 접속한 주소로 QR을 만듦(어느 주소로 열든 같은 곳으로 연결).
  // PC 로컬 실행(localhost·파일)은 휴대폰이 접속할 수 없으니 기본 이미지(Cloud Run 주소)를 그대로 둠
  const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]', ''];
  let phoneQrUrl = null;
  let qrLibrary = null;

  // QR 라이브러리는 '휴대폰에서 열기'를 누를 때만 받음 (앱 첫 화면을 빨리 띄우려고)
  function loadQrLibrary() {
    if (typeof window.qrcode === 'function') return Promise.resolve();
    qrLibrary = qrLibrary || new Promise((resolve, reject) => {
      const script = el('script', { src: 'vendor/qrcode.js' });
      script.onload = resolve;
      script.onerror = () => { qrLibrary = null; reject(new Error('qrcode.js')); };
      document.head.append(script);
    });
    return qrLibrary;
  }

  function showPhoneQr() {
    if (typeof window.qrcode !== 'function' || LOCAL_HOSTS.includes(location.hostname)) return;
    const url = location.origin + location.pathname.replace(/index\.html$/, '');
    if (url === phoneQrUrl) return;
    const img = $('phone-qr');
    try { img.src = drawQr(url); } catch { return; }  // 주소가 너무 길어 QR에 안 들어가면 기본 이미지를 그대로 둠
    phoneQrUrl = url;
    img.alt = url + ' 로 연결되는 QR 코드';
    $('phone-url').textContent = url.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const icon = new Image();  // 가운데 앱 아이콘은 불러진 뒤 덧그림 (오류 정정 H라 가려져도 인식됨)
    icon.onload = () => { if (phoneQrUrl === url) img.src = drawQr(url, icon); };
    icon.src = 'assets/acting-practice.png';
  }

  function drawQr(text, icon) {
    const qr = window.qrcode(0, 'H');
    qr.addData(text);
    qr.make();
    const cell = 8, margin = 3 * cell, count = qr.getModuleCount();
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = count * cell + margin * 2;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#17130f';
    for (let r = 0; r < count; r++) {
      for (let c = 0; c < count; c++) if (qr.isDark(r, c)) ctx.fillRect(margin + c * cell, margin + r * cell, cell, cell);
    }
    if (icon) {
      const size = Math.round(canvas.width / 5), pad = 8, at = (canvas.width - size) / 2;
      ctx.fillStyle = '#fff';
      ctx.fillRect(at - pad, at - pad, size + pad * 2, size + pad * 2);
      ctx.drawImage(icon, at, at, size, size);
    }
    return canvas.toDataURL('image/png');
  }

  // ---------- 앱 설치 (PWA) ----------
  function setupInstall() {
    if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
    navigator.serviceWorker.register('sw.js').catch(() => { /* 설치 기능만 빠지고 앱은 정상 동작 */ });
    const btn = $('btn-install');
    const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
    if (standalone) return;
    let deferred = null;
    window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; btn.hidden = false; });
    window.addEventListener('appinstalled', () => { btn.hidden = true; });
    const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (isIOS) btn.hidden = false;
    btn.onclick = async () => {
      if (deferred) { deferred.prompt(); await deferred.userChoice; deferred = null; btn.hidden = true; return; }
      alert('iPhone/iPad: Safari 아래쪽의 공유 버튼(□↑)을 누르고 "홈 화면에 추가"를 선택하세요.');
    };
  }

  // ---------- 무료 대본 서재 (공개 저작물 희곡) ----------
  let library = null;
  function openLibrary() {
    library = library || LV.create($('library-dialog'), { onPick: pickLibraryScript, onOpenFile: () => $('file-input').click() });
    library.open();
  }

  // 대본 언어는 '자동 감지'로 둠 (영어 작품을 불러온 뒤 한국어 대본을 넣어도 영어로 굳지 않게)
  function pickLibraryScript({ text, title, custom }) {
    $('script-input').value = text;
    $('opt-lang').value = 'auto';
    showDetectedLanguage();
    setImportStatus(`✅ 「${title}」을(를) 불러왔어요${custom ? '' : ' (공개 저작물)'}. 내용을 확인하고 '대본 분석'을 누르세요.`);
  }

  // '자동 감지'일 때 지금 대본이 어떤 언어로 보이는지 옆에 알려 줌. 직접 고른 언어가 대본과 다르면 알려 줌
  function showDetectedLanguage() {
    const choice = $('opt-lang').value;
    const text = $('script-input').value;
    const detected = text.trim() ? K.detectLanguage(text) : '';
    const label = (lang) => (lang === 'en' ? 'English' : '한국어');
    $('lang-detected').textContent = !detected ? ''
      : choice === 'auto' ? `→ ${label(detected)}`
        : choice !== detected ? `⚠ 대본은 ${label(detected)}로 보여요. '자동 감지'로 바꿔 주세요` : '';
  }

  function init() {
    avatarStage = AV.createStage($('stage'), { getLevel: () => (CT.level ? CT.level() : null) });
    PQ.onReady(onPortraitReady);
    $('script-input').value = state.text || '';
    $('opt-lang').value = state.langChoice || 'auto';
    S.setLanguage(speechLocale());
    showDetectedLanguage();
    $('app-version').textContent = `앱 버전 ${APP_VERSION}`;
    bindEvents();
    checkPickerRestart();
    bindOptions();
    setupInstall();
    window.addEventListener('pagehide', () => R.release());  // 앱을 닫거나 다른 화면으로 가면 마이크를 놓음
    if (RECORD_BLOCKS_SCORING) {
      C.checkAvailable().then((ok) => { cloudReady = ok; if (ok) bindOptions(); });
      // 휴대폰은 터치 안에서만 오디오를 켜게 해 줌. 연습은 ▶ 말고도 여러 경로로 시작되니 화면 어디를 눌러도 켜 둠
      document.addEventListener('pointerdown', () => C.unlock(), { capture: true, passive: true });
    }
    // 휴대폰은 첫 소리를 터치 안에서 내야 Google 목소리 재생이 허용됨
    document.addEventListener('pointerdown', () => CT.unlock(), { capture: true, passive: true });
    let cloudErrorShown = false;
    S.setCloudErrorHandler((err) => {
      if (cloudErrorShown) return;
      cloudErrorShown = true;
      setMic('⚠ Google 목소리를 불러오지 못해 이 기기의 기본 음성으로 읽어요. (' + err.message + ')');
    });
    S.onVoicesReady(() => { if (state.items.length) renderCast(); });
    if (state.items.length) renderCast();
    enableTabs();
  }

  init();
})();
