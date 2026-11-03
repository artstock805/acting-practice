// 내 대사 녹음 (MediaRecorder). 마이크 스트림은 한 번만 열어 재사용해 권한 창이 반복되지 않게 함
(function (root) {
  'use strict';

  const canRecord = !!(root.MediaRecorder && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  const CHUNK_MS = 250;
  let stream = null;
  let recorder = null;
  let chunks = [];
  let player = null;

  async function ensureStream() {
    if (stream && stream.getAudioTracks().some((t) => t.readyState === 'live')) return stream;
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    return stream;
  }

  async function start() {
    if (!canRecord) throw new Error('unsupported');
    discard();
    const s = await ensureStream();
    chunks = [];
    recorder = new MediaRecorder(s);
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.start(CHUNK_MS);   // 조각으로 받아 두면 녹음 중에도 지금까지의 소리를 꺼내 소리 크기를 잴 수 있음
  }

  // 녹음 중 지금까지 녹음된 소리 (휴대폰에서 실시간 소리 크기가 0으로만 읽힐 때, 이걸 풀어 소리 크기를 잼)
  function snapshot() {
    return recorder && chunks.length ? new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }) : null;
  }

  // 녹음을 끝내고 Blob 반환 (녹음 중이 아니면 null)
  function stop() {
    return new Promise((resolve) => {
      if (!recorder || recorder.state === 'inactive') { recorder = null; return resolve(null); }
      const r = recorder;
      recorder = null;
      r.onstop = () => resolve(chunks.length ? new Blob(chunks, { type: r.mimeType || 'audio/webm' }) : null);
      r.stop();
    });
  }

  function discard() {
    if (recorder && recorder.state !== 'inactive') { recorder.onstop = null; recorder.stop(); }
    recorder = null;
    chunks = [];
  }

  // 재생이 끝나면(또는 실패하면) resolve
  function play(url) {
    stopPlaying();
    return new Promise((resolve) => {
      player = new Audio(url);
      player.onended = () => resolve();
      player.onerror = () => resolve();
      player.play().catch(() => resolve());
    });
  }

  function stopPlaying() {
    if (!player) return;
    player.pause();
    if (player.onended) player.onended();
    player = null;
  }

  // 녹음을 버리고 마이크까지 닫음. 열어 둔 채로 두면 휴대폰에서 음성 인식이 소리를 못 받음
  function release() {
    discard();
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }

  // 녹음 중인 마이크 스트림 (서버 음성 인식의 무음 감지용)
  function getStream() { return stream; }

  // 녹음용으로 연 마이크가 아직 열려 있는지 (진단 표시용)
  function isMicOpen() { return !!(stream && stream.getAudioTracks().some((t) => t.readyState === 'live')); }

  root.Recorder = { canRecord, start, stop, discard, release, play, stopPlaying, getStream, isMicOpen, snapshot };
})(window);
