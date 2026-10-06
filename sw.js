// 오프라인 실행 + 앱 설치용 서비스 워커. 네트워크 우선이라 업데이트가 바로 반영되고, 오프라인이면 캐시로 열림
const CACHE = 'acting-practice-v1';
const SHELL = ['./', 'index.html', 'style.css', 'parser.js', 'sample.js', 'speech.js', 'recorder.js', 'app.js',
  'manifest.webmanifest', 'assets/acting-practice.png', 'assets/icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;  // AI 이미지 등 외부 요청은 건드리지 않음
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match('index.html')))
  );
});
