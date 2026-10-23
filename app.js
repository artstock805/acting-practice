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
  const NARRATOR_VOICE = { voiceURI: '', pitch: 1, rateScale: 0.95 };
  const NARRATOR = '__narrator__';
  const APP_VERSION = 'v21';  // 화면 아래에 표시 (휴대폰이 새 버전을 받았는지 확인용). sw.js의 CACHE 번호와 같이 올림
  const POST_SPEECH_GAP_MS = 350;  // 상대 대사가 끝나고 내 대사를 듣기 시작하기까지 쉬는 시간
  const $ = (id) => document.getElementById(id);
  const PHONE_OS = phoneOS();
  // 휴대폰은 녹음이 마이크를 잡으면 음성 인식에 무음만 들어감 → 인식이 되는 휴대폰에선 채점을 우선하고 녹음은 하지 않음
  const RECORD_BLOCKS_SCORING = !!PHONE_OS && S.canListen;
  // 서버(Cloud Run)가 있으면 휴대폰도 녹음 파일을 서버로 보내 채점 → 녹음과 채점을 둘 다 할 수 있음
  let cloudReady = false;
  const NOTE_PHONE_LOCAL = '📱 휴대폰에서는 음성 채점과 녹음을 동시에 할 수 없어, 채점을 우선하고 녹음은 하지 않습니다. 녹음해서 다시 들으려면 PC에서 연습하세요.';
  const NOTE_PHONE_CLOUD = '📱 휴대폰에서는 녹음을 서버로 보내 채점합니다. 말을 마치면 1~2초 뒤에 결과가 나와요. 녹음을 끄면 휴대폰 내장 인식으로 바로 채점합니다.';

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
    document.body.classList.toggle('practice-mode', name === 'practice');  // 연습 화면: 위쪽 고정, 대본 목록만 스크롤
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
    update({ text, items, cast, index: 0, results: {}, mergeDismissed: [] });
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

  // 대사 속 괄호 지문: 화면에는 항상 보이고, '지문도 읽어 주기'를 켰을 때만 해설 목소리로 읽음.
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
    const parts = state.opts.directions ? K.splitAsides(withNote(item)) : [{ text: speechOf(item), aside: false }];
    for (const part of parts) {
      if (token !== runToken || !part.text) continue;
      await S.speak(part.text, part.aside ? voiceCfg(NARRATOR) : voiceCfg(item.character, item));
    }
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
    const recordLocked = RECORD_BLOCKS_SCORING && !cloudReady;
    $('opt-record').checked = o.record !== false && !recordLocked;
    $('opt-record').disabled = recordLocked;
    $('opt-record-note').hidden = !RECORD_BLOCKS_SCORING;
    $('opt-record-note').textContent = cloudReady ? NOTE_PHONE_CLOUD : NOTE_PHONE_LOCAL;
    const sync = () => {
      update({ opts: { mode: $('opt-mode').value, threshold: +$('opt-threshold').value, rate: +$('opt-rate').value,
        directions: $('opt-directions').checked, aiImage: $('opt-ai-image').checked,
        record: recordLocked ? o.record : $('opt-record').checked } });  // 휴대폰에서 강제로 끈 건 저장하지 않음
      $('opt-threshold-val').textContent = state.opts.threshold + '%';
      $('opt-rate-val').textContent = state.opts.rate.toFixed(1) + '×';
      if (!$('opt-record').checked) R.release();  // 녹음을 끄면 열어 둔 마이크도 바로 놓아 줌
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
    R.release();  // 연습을 멈추면 마이크를 놓아 다른 앱·음성 인식이 쓸 수 있게 함
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
      if (state.opts.directions) { setRowPhase('speaking'); await S.speak(item.text, voiceCfg(NARRATOR)); setRowPhase(''); } else await sleep(700);
      return 'next';
    }
    if (!state.cast[item.character].mine) {
      setRowPhase('speaking');
      await speakLine(item, token);
      setRowPhase('');
      return 'next';
    }
    if (!speechOf(item)) { await sleep(700); return 'next'; }   // 내 대사가 지문뿐이면 말할 게 없음
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
    listener = S.listen({
      onInterim: (t) => setMic('🎙 ' + t, true),
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
      hint: speechOf(item),
      silenceMs: K.silenceForLine(speechOf(item)),
      onPhase: (phase, ms) => {
        if (token !== runToken) return;
        if (phase === 'timed') setMic(`⏺ 녹음 중 · 대사를 말해 주세요 (${ms / 1000}초 동안 녹음)`, true);
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
    showDiff(item, spoken, score);
    if (score >= threshold) { setMic('👏 좋아요!'); await sleep(700); return 'next'; }
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
    $('line-text').textContent = text;
    $('line-text').classList.toggle('is-hidden', !!hidden);
    $('line-card').classList.toggle('is-mine', !!mine);
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
    li.append(el('b', { textContent: item.character }), listText(item));
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
      setImportStatus(`✅ ${file.name}에서 ${text.split('\n').length}줄을 불러왔어요. 내용을 확인하고 '대본 분석'을 누르세요.`);
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
    document.querySelectorAll('.tab').forEach((t) => { t.onclick = () => (t.dataset.view === 'practice' ? goPractice() : showView(t.dataset.view)); });
    $('btn-sample').onclick = () => { $('script-input').value = window.SAMPLE_SCRIPT; };
    bindFilePicker();
    $('btn-parse').onclick = parseAndGo;
    $('btn-to-practice').onclick = goPractice;
    $('btn-auto-voices').onclick = autoAssignVoices;
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

  function init() {
    $('script-input').value = state.text || '';
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
    S.onVoicesReady(() => { if (state.items.length) renderCast(); });
    if (state.items.length) renderCast();
    enableTabs();
  }

  init();
})();
