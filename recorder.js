// 내 대사 녹음 (MediaRecorder). 마이크 스트림은 한 번만 열어 재사용해 권한 창이 반복되지 않게 함
(function (root) {
  'use strict';

  const canRecord = !!(root.MediaRecorder && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
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
    recorder.start();
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

  root.Recorder = { canRecord, start, stop, discard, play, stopPlaying };
})(window);
