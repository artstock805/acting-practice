// 화면 흐름: 대본 입력 → 배역 설정 → 연습(상대역 낭독 + 내 대사 음성 인식)
(function () {
  'use strict';
  const K = window.ScriptKit;
  const S = window.Speech;
  const R = window.Recorder;
  const STORE_KEY = 'acting-practice-v1';
  const V = window.VoiceKit;
  const NARRATOR_VOICE = { voiceURI: '', pitch: 1, rateScale: 0.95 };
  const NARRATOR = '__narrator__';
  const $ = (id) => document.getElementById(id);

  let state = loadState() || { text: '', items: [], cast: {}, opts: { mode: 'hint', threshold: 70, rate: 1, directions: false, aiImage: false, record: true }, index: 0, results: {} };
  let runToken = 0;
  let listener = null;
  let waiting = false;
  let currentImgScene = null;
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
    if (name !== 'practice') stopPlayback();
  }
  function enableTabs() {
    const hasCast = state.items.some((i) => i.type === 'line');
    document.querySelector('[data-view=cast]').disabled = !hasCast;
    document.querySelector('[data-view=practice]').disabled = !hasCast || !myNames().length;
  }

  // ---------- 1. 대본 ----------
  function parseAndGo() {
    const text = $('script-input').value;
    const items = K.parseScript(text);
    const chars = K.listCharacters(items);
    if (!chars.length) { alert('인물 대사를 찾지 못했습니다. "이름: 대사" 형식인지 확인해 주세요.'); return; }
    const cast = {};
    chars.forEach((c, i) => { cast[c.name] = state.cast[c.name] || { mine: i === 0 && !myNames().length, isNew: true }; });
    // 새로 나온 상대 배역에게는 서로 다른 목소리를 자동 배분 (기존 인물 설정은 유지)
    const newOthers = chars.map((c) => c.name).filter((n) => cast[n].isNew && !cast[n].mine);
    const assigned = V.distributeVoices(newOthers, availableVoiceURIs());
    Object.keys(cast).forEach((n) => { const { isNew, ...rest } = cast[n]; cast[n] = { ...rest, ...(assigned[n] || {}) }; });
    update({ text, items, cast, index: 0, results: {} });
    renderCast();
    enableTabs();
    showView('cast');
  }

  // ---------- 2. 배역 ----------
  function myNames() { return Object.keys(state.cast).filter((n) => state.cast[n].mine); }

  function availableVoiceURIs() { return S.getKoreanVoices().map((v) => v.voiceURI); }

  function renderCast() {
    const voices = S.getKoreanVoices();
    const clashes = V.findVoiceClashes(state.cast);
    const body = $('cast-body');
    body.textContent = '';
    K.listCharacters(state.items).forEach(({ name, lines }) => {
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

      const cells = [mine, nameInput, document.createTextNode(String(lines)), voiceControls(name, cfg, voices, clashes.has(name)), preview];
      cells.forEach((n) => { const td = el('td'); td.append(n); tr.append(td); });
      body.append(tr);
    });
    $('voice-count').textContent = voices.length > 1
      ? `이 브라우저의 한국어 음성 ${voices.length}개를 나눠 씁니다.`
      : '이 브라우저에는 한국어 음성이 1개뿐이라 높낮이·속도로 구분합니다. Edge에서 열면 음성이 더 많습니다.';
  }

  // 인물 한 명의 목소리 설정: 성격 프리셋 · 음성 · 높낮이 · 속도
  function voiceControls(name, cfg, voices, isClash) {
    const v = V.resolveVoice(cfg);
    const box = el('div', { className: 'voice-box' });

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
    voice.append(el('option', { value: '', textContent: '기본 음성', selected: !v.voiceURI }));
    voices.forEach((x) => voice.append(el('option', { value: x.voiceURI, textContent: V.shortVoiceName(x.name), selected: v.voiceURI === x.voiceURI })));
    voice.onchange = () => changeVoice(name, { voiceURI: voice.value });

    box.append(preset, voice,
      slider('높낮이', 0.5, 2, 0.05, v.pitch, (val) => changeVoice(name, { pitch: val, persona: 'custom' })),
      slider('속도', 0.6, 1.5, 0.05, v.rateScale, (val) => changeVoice(name, { rateScale: val, persona: 'custom' })));
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

  function autoAssignVoices() {
    const others = K.listCharacters(state.items).map((c) => c.name).filter((n) => !state.cast[n].mine);
    const assigned = V.distributeVoices(others, availableVoiceURIs());
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

  function voiceCfg(name, item) {
    const v = name === NARRATOR ? NARRATOR_VOICE : V.resolveVoice(state.cast[name]);
    const emotion = item ? K.detectEmotion(item.note) : null;
    return { ...v, rate: state.opts.rate, emotionKey: emotion && emotion.key };
  }

  function bindOptions() {
    const o = state.opts;
    $('opt-mode').value = o.mode;
    $('opt-threshold').value = o.threshold;
    $('opt-rate').value = o.rate;
    $('opt-directions').checked = o.directions;
    $('opt-ai-image').checked = o.aiImage;
    $('opt-record').checked = o.record !== false;
    const sync = () => {
      update({ opts: { mode: $('opt-mode').value, threshold: +$('opt-threshold').value, rate: +$('opt-rate').value,
        directions: $('opt-directions').checked, aiImage: $('opt-ai-image').checked, record: $('opt-record').checked } });
      $('opt-threshold-val').textContent = state.opts.threshold + '%';
      $('opt-rate-val').textContent = state.opts.rate.toFixed(1) + '×';
    };
    ['opt-mode', 'opt-threshold', 'opt-rate', 'opt-directions', 'opt-ai-image', 'opt-record'].forEach((id) => { $(id).oninput = sync; $(id).onchange = sync; });
    sync();
  }

  // ---------- 3. 연습 ----------
  function goPractice() {
    if (!myNames().length) { alert('내 역할을 하나 이상 체크해 주세요.'); return; }
    showView('practice');
    renderTranscript();
    renderItem(state.items[state.index] || state.items[0]);
    if (!S.canListen) setMic('⚠ 이 브라우저는 음성 인식을 지원하지 않습니다. Chrome·Edge·Safari를 쓰거나, 대사를 말한 뒤 ⏭를 누르세요.');
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function play() {
    const token = ++runToken;
    waiting = false;
    setRetryButtons(false);
    $('btn-play').textContent = '⏸ 일시정지';
    while (token === runToken && state.index < state.items.length) {
      const outcome = await step(state.items[state.index], token);
      if (token !== runToken) return;
      if (outcome === 'wait') { waiting = true; $('btn-play').textContent = '▶ 계속'; return; }
      update({ index: state.index + 1 });
    }
    if (token === runToken) finish();
  }

  function stopPlayback() {
    runToken++;
    waiting = false;
    S.stopSpeaking();
    R.discard();
    R.stopPlaying();
    resetReplayButton();
    if (listener) { listener.stop(); listener = null; }
    setMic('');
    $('btn-play').textContent = '▶ 시작';
  }

  async function step(item, token) {
    renderItem(item);
    if (item.type === 'scene') { await sleep(900); return 'next'; }
    if (item.type === 'direction') {
      if (state.opts.directions) await S.speak(item.text, voiceCfg(NARRATOR)); else await sleep(700);
      return 'next';
    }
    if (!state.cast[item.character].mine) { await S.speak(item.text, voiceCfg(item.character, item)); return 'next'; }
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
    const recording = await startRecording();
    if (token !== runToken) { R.discard(); return 'wait'; }
    setMic((recording ? '⏺ 녹음 중 · ' : '') + '듣고 있어요… 대사를 말해 주세요.', true);
    listener = S.listen({
      onInterim: (t) => setMic('🎙 ' + t, true),
      shouldStopEarly: (t) => K.similarity(item.text, t) >= Math.max(threshold, 0.9),
    });
    let spoken = '';
    try { spoken = await listener.promise; } catch (err) {
      R.discard();
      if (token !== runToken) return 'wait';
      setMic(micErrorMessage(err.message));
      return 'wait';
    }
    listener = null;
    if (token !== runToken) { R.discard(); return 'wait'; }
    if (recording) saveTake(state.index, await R.stop());
    const score = K.similarity(item.text, spoken);
    recordResult(state.index, score);
    showDiff(item, spoken, score);
    if (score >= threshold) { setMic('👏 좋아요!'); await sleep(700); return 'next'; }
    setMic(spoken ? '조금 달라요. 다시 말하거나 통과 처리할 수 있어요.' : '소리가 들리지 않았어요. 마이크를 확인해 주세요.');
    revealLine(item);
    setRetryButtons(true);
    return 'wait';
  }

  async function startRecording() {
    if (state.opts.record === false || !R.canRecord) return false;
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
    renderTranscript();
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
        await S.speak(item.text, voiceCfg(item.character, item));
      }
    }
    if (token === runToken) { setMic('장면 재생 끝'); resetReplayButton(); }
  }

  function resetReplayButton() {
    $('btn-replay-scene').textContent = '🎬 장면 다시 듣기';
    $('btn-replay-scene').onclick = replayScene;
  }

  function micErrorMessage(code) {
    if (code === 'audio-capture') return NO_MIC_MESSAGE;
    if (code === 'not-allowed' || code === 'service-not-allowed') return permissionMessage();
    if (code === 'network') return '🌐 음성 인식 서버에 연결하지 못했습니다. 인터넷 연결을 확인하세요.';
    return '음성 인식 오류: ' + code;
  }

  function recordResult(index, score) { update({ results: { ...state.results, [index]: score } }); renderTranscript(); }

  function finish() {
    const scores = Object.values(state.results);
    const avg = scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 100) : 0;
    $('btn-play').textContent = '↺ 처음부터';
    renderLineCard({ who: '🎬 끝', note: '', text: scores.length ? `수고했어요! 내 대사 ${scores.length}개, 평균 정확도 ${avg}%` : '수고했어요!', mine: false, hidden: false });
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
    $('progress-bar').style.width = ((state.index + 1) / state.items.length) * 100 + '%';
    document.querySelectorAll('.transcript li').forEach((li) => li.classList.toggle('current', +li.dataset.index === state.index));
    const cur = document.querySelector('.transcript li.current');
    if (cur) cur.scrollIntoView({ block: 'nearest' });
    if (item.type !== 'line') return;
    const mine = state.cast[item.character] && state.cast[item.character].mine;
    const mode = state.opts.mode;
    const text = mine && mode === 'hint' ? K.firstLetterHint(item.text) : item.text;
    renderLineCard({ who: item.character + (mine ? ' (나)' : ''), note: item.note, text, mine, hidden: mine && mode === 'hidden' });
  }

  function renderLineCard({ who, note, text, mine, hidden }) {
    $('line-who').textContent = who;
    $('line-note').textContent = note || '';
    const emotion = K.detectEmotion(note);
    $('line-note').style.background = emotion ? emotion.color + '33' : '';
    $('line-text').textContent = text;
    $('line-text').classList.toggle('is-hidden', !!hidden);
    $('line-card').classList.toggle('is-mine', !!mine);
  }

  function revealLine(item) { $('line-text').textContent = item.text; $('line-text').classList.remove('is-hidden'); }

  function showDiff(item, spoken, score) {
    const box = $('line-diff');
    box.textContent = '';
    box.append(el('span', { className: 'score', textContent: Math.round(score * 100) + '%' }));
    K.wordDiff(item.text, spoken).forEach((w) => { box.append(el('span', { className: 'w ' + (w.ok ? 'ok' : 'bad'), textContent: w.word })); box.append(' '); });
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
    img.src = 'https://image.pollinations.ai/prompt/' + encodeURIComponent(prompt) + '?width=960&height=420&nologo=true';
  }

  function renderTranscript() {
    const list = $('transcript');
    list.textContent = '';
    state.items.forEach((item, index) => {
      if (item.type !== 'line') return;
      const mine = state.cast[item.character] && state.cast[item.character].mine;
      const li = el('li', { className: mine ? 'mine' : '' });
      li.dataset.index = index;
      li.append(el('b', { textContent: item.character }), item.text);
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
      list.append(li);
    });
  }

  function setMic(text, listening) { $('mic-status').textContent = text; $('mic-status').classList.toggle('listening', !!listening); }
  function setRetryButtons(show) { ['btn-retry', 'btn-reveal', 'btn-pass'].forEach((id) => { $(id).hidden = !show; }); }

  function el(tag, props) {
    const node = document.createElement(tag);
    Object.entries(props || {}).forEach(([k, v]) => { if (k === 'style') node.setAttribute('style', v); else node[k] = v; });
    return node;
  }

  // ---------- 이벤트 ----------
  function bindEvents() {
    document.querySelectorAll('.tab').forEach((t) => { t.onclick = () => (t.dataset.view === 'practice' ? goPractice() : showView(t.dataset.view)); });
    $('btn-sample').onclick = () => { $('script-input').value = window.SAMPLE_SCRIPT; };
    $('file-input').onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try { $('script-input').value = await file.text(); } catch (err) { alert('파일을 읽지 못했습니다: ' + err.message); }
    };
    $('btn-parse').onclick = parseAndGo;
    $('btn-to-practice').onclick = goPractice;
    $('btn-auto-voices').onclick = autoAssignVoices;
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
      jumpTo(state.index + 1, resume);
    };
    $('btn-prev').onclick = () => jumpTo(nextLineIndex(state.index, -1), false);
    $('btn-retry').onclick = () => play();
    $('btn-reveal').onclick = () => revealLine(state.items[state.index]);
    $('btn-my-take').onclick = () => { if (takes[state.index]) R.play(takes[state.index]); };
    resetReplayButton();
    $('btn-pass').onclick = () => { recordResult(state.index, 1); jumpTo(state.index + 1, true); };
    document.addEventListener('keydown', (e) => {
      const typing = ['TEXTAREA', 'INPUT', 'SELECT'].includes(document.activeElement.tagName);
      if (e.code === 'Space' && !typing && $('view-practice').classList.contains('active')) { e.preventDefault(); $('btn-next').click(); }
    });
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

  function init() {
    $('script-input').value = state.text || '';
    bindEvents();
    bindOptions();
    setupInstall();
    S.onVoicesReady(() => { if (state.items.length) renderCast(); });
    if (state.items.length) renderCast();
    enableTabs();
  }

  init();
})();
