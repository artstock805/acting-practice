// AI 초상화 받기 줄: 무료 그림 서비스(Pollinations)는 한 기기(IP)당 45초에 1장만 그려 줘서,
// 한 장씩 차례로 받고(지금 말하는 배역 먼저), '한도 초과'면 알려 준 시간만큼 기다렸다 다시 받음.
// 받은 그림은 이 기기의 Cache Storage에 저장해 다음부터는 바로 보여 줌
(function (root) {
  'use strict';

  const CACHE_NAME = 'portraits-v1';
  const MIN_GAP_MS = 46_000;          // 서비스 한도(45초에 1장)보다 조금 넉넉히
  const DEFAULT_RETRY_S = 45;
  const LIMIT_STATUSES = [402, 429];   // 무료 한도 초과

  function createPortraitQueue({
    fetchImpl = (url) => root.fetch(url),
    openCache = () => (root.caches ? root.caches.open(CACHE_NAME) : Promise.resolve(null)),
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    now = () => Date.now(),
    makeUrl = (blob) => URL.createObjectURL(blob),
    minGapMs = MIN_GAP_MS,
  } = {}) {
    const readyUrls = new Map();   // 그림 주소 → 이 기기에서 볼 주소(blob:)
    const pending = new Map();     // 그림 주소 → { promise, resolve, reject }
    const waiting = [];            // 아직 받지 못한 그림 주소 (앞에서부터 받음)
    const listeners = [];
    let lastFetchAt = -Infinity;
    let working = false;

    // 쓸 때마다 이름으로 다시 엶 (앱 업데이트 중에 저장소가 바뀌어도 옛 것에 쓰지 않게)
    const cache = () => openCache().catch(() => null);

    function finish(url, blobUrl) {
      readyUrls.set(url, blobUrl);
      const job = pending.get(url);
      pending.delete(url);
      if (job) job.resolve(blobUrl);
      listeners.forEach((fn) => fn(url));
    }

    function fail(url, err) {
      const job = pending.get(url);
      pending.delete(url);
      if (job) job.reject(err);
    }

    // 서비스에서 한 장 받기: 한도 초과면 기다렸다 다시, 받으면 저장
    async function download(url) {
      for (;;) {
        const gap = lastFetchAt + minGapMs - now();
        if (gap > 0) await sleep(gap);
        lastFetchAt = now();
        const res = await fetchImpl(url);
        if (LIMIT_STATUSES.includes(res.status)) {
          const seconds = Number(res.headers.get('Retry-After')) || DEFAULT_RETRY_S;
          await sleep(seconds * 1000 + 1000);
          lastFetchAt = -Infinity;   // 기다린 만큼으로 충분
          continue;
        }
        if (!res.ok) throw new Error(`그림을 받지 못했어요 (${res.status})`);
        const blob = await res.blob();
        const store = await cache();
        if (store) await store.put(url, new Response(blob, { headers: { 'Content-Type': blob.type || 'image/jpeg' } })).catch(() => {});
        return blob;
      }
    }

    async function work() {
      if (working) return;
      working = true;
      try {
        while (waiting.length) {
          const url = waiting.shift();
          try { finish(url, makeUrl(await download(url))); } catch (err) { fail(url, err); }
        }
      } finally {
        working = false;
      }
    }

    // 그림 주소 → 볼 수 있는 주소. urgent면 줄 맨 앞으로 (지금 말하는 배역)
    function request(url, { urgent = false } = {}) {
      if (readyUrls.has(url)) return Promise.resolve(readyUrls.get(url));
      if (pending.has(url)) {
        const job = pending.get(url);
        if (urgent) job.urgent = true;   // 아직 저장소를 확인하는 중이면 줄에 설 때 맨 앞으로
        if (urgent && waiting.includes(url)) { waiting.splice(waiting.indexOf(url), 1); waiting.unshift(url); }
        return job.promise;
      }
      let resolve;
      let reject;
      const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
      const job = { promise, resolve, reject, urgent };
      pending.set(url, job);
      // 저장된 그림이 있으면 줄을 서지 않고 바로
      cache()
        .then((store) => (store ? store.match(url) : undefined))
        .then(async (hit) => {
          if (hit) { finish(url, makeUrl(await hit.blob())); return; }
          if (job.urgent) waiting.unshift(url); else waiting.push(url);
          work();
        })
        .catch((err) => fail(url, err));
      return promise;
    }

    return {
      request,
      ready: (url) => readyUrls.get(url) || null,
      onReady: (fn) => { listeners.push(fn); },
    };
  }

  const api = { createPortraitQueue, CACHE_NAME };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PortraitQueue = api;
})(this);
