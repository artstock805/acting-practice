// 오프라인 실행 + 앱 설치용 서비스 워커. 네트워크 우선이라 업데이트가 바로 반영되고, 오프라인이면 캐시로 열림
const CACHE = 'acting-practice-v13';
const SHELL = ['./', 'index.html', 'style.css', 'parser.js', 'sample.js', 'fileimport.js', 'voices.js', 'speech.js', 'recorder.js', 'audiokit.js', 'cloudstt.js', 'vendor/qrcode.js', 'app.js',
  'manifest.webmanifest', 'assets/acting-practice.png', 'assets/icon-192.png', 'assets/qr-mobile.png'];

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
  if (url.pathname.includes('/api/')) return;  // 서버 음성 인식 상태는 캐시하면 안 됨 (오프라인인데 '사용 가능'으로 보임)
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match('index.html')))
  );
});
