# 🎭 대사 연습 파트너

대본을 넣으면 **상대 배역을 읽어 주고**, 내 대사는 **음성 인식으로 채점**하고, **녹음해서 다시 들려주는** 연기 연습 앱입니다.
설치할 프로그램도 API 키도 필요 없고, 무료입니다.

## 바로 쓰기 (PC · 휴대폰 공통, 설치 없음)

👉 **https://acting-practice-160629403411.asia-northeast3.run.app/**

Chrome, Edge, Safari에서 열고 마이크를 허용하면 됩니다.

📖 **처음이라면 → [화면으로 보는 사용법](readme/README.md)** (대본 넣기부터 채점·녹음 다시 듣기, 휴대폰 사용까지)

<img src="assets/qr-mobile.png" alt="휴대폰으로 열기 QR 코드" width="180">

휴대폰 카메라로 QR 코드를 찍으면 바로 열립니다. PC 앱에서는 위쪽 **📱 휴대폰에서 열기** 버튼으로도 볼 수 있습니다.

### 휴대폰에 앱으로 설치
| 기기 | 방법 |
|---|---|
| Android | Chrome으로 열기 → 위쪽의 **📲 앱으로 설치** 버튼, 또는 메뉴(⋮) → **홈 화면에 추가 / 앱 설치** |
| iPhone · iPad | **Safari**로 열기 → 아래쪽 공유 버튼(□↑) → **홈 화면에 추가** |
| PC | Chrome/Edge 주소창 오른쪽의 설치 아이콘(⊕), 또는 **📲 앱으로 설치** 버튼 |

한 번 설치하면 홈 화면 아이콘으로 열리고, 인터넷이 없어도 화면은 열립니다(음성 인식은 인터넷이 필요할 수 있음).

## Windows에 내려받아 쓰기 (오프라인 · 추가 설치 불필요)
1. 이 페이지 위쪽 **Code → Download ZIP**으로 받아 원하는 곳에 압축을 풉니다. (또는 `git clone`)
2. 폴더 안의 **`install.bat`**을 더블클릭합니다. 바탕화면과 시작 메뉴에 🎭 아이콘이 생깁니다.
3. 아이콘을 누르면 앱 창으로 열립니다. 창을 닫으면 뒤에서 돌던 로컬 서버도 같이 꺼집니다.

- Windows 10/11 기본 PowerShell만 사용합니다(Python·Node 불필요). Edge → Chrome → 기본 브라우저 순으로 찾습니다.
- 아이콘 없이 실행: `start.bat` · 아이콘 지우기: `powershell -ExecutionPolicy Bypass -File install.ps1 -Uninstall`
- 폴더를 옮겼다면 `install.bat`을 다시 실행하세요.

## macOS · Linux에서 내려받아 쓰기
```sh
sh start.sh
```
(Python 3 필요. 없으면 위의 웹 주소를 쓰세요.)

## 기능
- **대본 파일 열기**: txt(옛 한글 EUC-KR 포함) · PDF · Word(.docx) · 한글(.hwp · .hwpx, 한글 97 .hwp 포함) · .odt · .rtf. 모두 브라우저 안에서 읽음(서버 전송 없음). PDF는 자동 줄바꿈된 줄을 다시 이어 붙임
- **대본 자동 인식**: `이름: 대사`, `이름(지문): 대사`, 이름 한 줄 + 대사 한 줄(시나리오식), `이름 대사`(희곡식, 쌍점 없음), `[이름] 대사`. `S#1`, `#1`, `씬 1`, `INT.`은 장면 제목, 괄호 줄은 지문
- **영어 대본**: 대본 언어 자동 판별(또는 선택). `NAME: line`, 시나리오(대문자 이름 줄·여러 줄 대사·`(beat)`·`(V.O.)`·`CUT TO:`), 희곡 `NAME. line`. 음성 인식·Google 목소리·채점(축약형 I'm=I am, 숫자 20=twenty)·첫 글자 힌트·AI 분석(설명은 한국어, 근거 대사는 영어 원문)이 영어에 맞게 동작
- **📚 무료 대본 서재**: 저작권이 끝난 공개 저작물 희곡을 바로 불러오기 — 셰익스피어 5편(햄릿·로미오와 줄리엣·맥베스·한여름 밤의 꿈·오셀로), 와일드 「진지함의 중요성」, 입센 「인형의 집」·「헤다 가블러」(번역가도 사망 70년 경과), 한국 신극 「규한」(이광수)·「병자삼인」(조중환)·「제석」(홍사용). 서버가 Project Gutenberg·위키문헌 원문을 받아 앱 대본 형식으로 바꿔 줌(막별로 골라 불러오기 가능). **➕ 다른 작품 찾아서 불러오기**: Gutenberg 희곡 목록·위키문헌 희곡 목록을 열어 작품 주소를 복사해 붙여 넣으면 바로 불러옴(Gutenberg는 책 번호만 넣어도 됨, 희곡이 아니면 알려 줌). **📁 공유마당 만료 희곡 84편 목록**(작가별, 작품 페이지 바로가기)과 이용 조건(만료·CC·기증) 확인 안내, 받은 파일은 서재 안의 📄 받은 파일 열기로. Internet Archive는 파일로 받아 📄 대본 파일 열기
- **배역**: 내 역할만 체크하면 나머지는 앱이 낭독. 이름을 고쳐 인물 합치기, **이름 오타(서희→소희, 학→상학, 배영민→영민) 합치기 제안**
- **인물별 목소리**: Google 음성 합성(Chirp 3 HD) 한국어 남녀 목소리 29가지 + 이 기기의 음성. 상대 배역이 여러 명이면 서로 다른 목소리를 자동 배분. 인물마다 목소리·속도(이 기기 음성은 높낮이·성격 프리셋도) 조절, 바꾸면 바로 들려줌. 목소리가 겹치면 ⚠ 표시
- **AI 배역 분석**: 버튼을 누르면 대본을 Claude에게 보내 인물별 성별·나이대·성격·말투를 읽고 어울리는 Google 목소리와 말 속도를 추천·적용
- **작품 분석 (4. 분석 탭)**: 작품 전체 초목표·주제·관통행동, 배역별 초목표·관통행동·장애물·근거 대사, 인물 관계도(색깔 선·화살표, 중심 인물은 가운데). AI 초안을 직접 고치면 브라우저에 저장, 관계도는 PNG로 저장, 내용은 텍스트로 복사
- **감정 반영**: `(화가 나서)`, `(속삭이며)`, `(울먹이며)` 같은 지문에 맞춰 낭독 톤과 속도 조절
- **음성 채점**: 내 대사를 말하면 정확도(%)와 틀린 단어 표시. 표시 방식은 전체 / 첫 글자 힌트 / 숨기기(암기 테스트)
- **녹음해서 다시 듣기**: 대사별 내 녹음 듣기, **🎬 장면 다시 듣기**(상대역 음성 + 내 녹음을 이어서 재생)
- **장면 표시**: 장면 제목과 지문에서 밤·비·카페·병원 등을 찾아 무대 배경 표시. 원하면 AI 장면 이미지 생성(옵션)

## 대본 형식 예
```
S#1. 카페 / 밤          ← 장면 제목
(비가 내린다)            ← 지문
민수: 늦었네.            ← 이름: 대사
지연(화가 나서): 왜?     ← 이름(지문): 대사 → 낭독 톤에 반영
지연                     ← 시나리오식: 이름 한 줄
그만해.                  ←           대사 한 줄
```

## 브라우저 지원
| | 상대역 낭독 | 음성 채점 | 녹음 |
|---|---|---|---|
| Chrome / Edge (PC) | ✅ | ✅ | ✅ |
| Chrome · 삼성 인터넷 (Android) | ✅ | ✅ | ✅ 서버 채점 (아래 참고) |
| Safari (Mac) | ✅ | ✅ (설정에서 Siri가 켜져 있어야 함) | ✅ |
| Safari (iPhone, iOS 14.5+) | ✅ | ✅ (설정에서 Siri가 켜져 있어야 함) | ✅ 서버 채점 (아래 참고, 실기기 확인 전) |
| Firefox | ✅ | ❌ → 대사를 말한 뒤 ⏭ 누르기 | ✅ |

- 휴대폰 브라우저는 녹음이 마이크를 잡고 있으면 음성 인식에 소리가 들어가지 않습니다.
  - 그래서 휴대폰은 녹음을 서버로 보내 Google Speech-to-Text로 채점합니다. 녹음과 채점이 둘 다 됩니다(말을 마치면 1~2초 뒤 결과).
  - 서버가 없는 곳(PC에서 `start.bat` 등으로 로컬 실행)에서 휴대폰으로 열면: 채점을 우선하고 녹음은 하지 않습니다.

- 음성 인식은 브라우저 제조사의 음성 서비스(구글·애플·MS)를 거치므로 인터넷이 필요할 수 있습니다.
- iPhone에서는 처음 ▶ 시작을 눌러야 소리가 납니다. 마이크 권한 오류가 나면 🔁 다시 말하기를 한 번 눌러 주세요.
- 인물마다 다른 목소리를 원하면 한국어 음성이 여러 개 있는 Edge(SunHi·InJoon 등)를 추천합니다.

## 개인정보 · 저작권
- 대본은 **내 브라우저 안에만 저장**됩니다. 녹음은 창을 닫으면 사라집니다.
- **Google 목소리**로 읽을 때는 읽을 대사가 서버를 거쳐 Google Text-to-Speech로 전송됩니다. 서버는 합성한 소리를 잠시 메모리에만 두고(같은 대사 재사용) 저장하지 않습니다.
- **🤖 AI로 배역 분석** 또는 **🤖 AI로 초목표·관계도 그리기**를 눌렀을 때만 대본 전체가 서버를 거쳐 Claude(Anthropic)로 전송됩니다. 서버는 대본을 저장하지 않습니다.
- Cloud Run 판을 휴대폰에서 녹음을 켜고 쓰면, 내 대사 녹음이 채점을 위해 서버를 거쳐 Google Speech-to-Text로 전송됩니다. 서버는 녹음을 저장하지 않습니다. (PC와 휴대폰 내장 음성 인식도 원래 구글·애플·MS 음성 서비스로 소리를 보냅니다.)
- **AI 장면 이미지** 옵션을 켰을 때만 장면 제목이 외부 이미지 서비스(Pollinations)로 전송됩니다(기본 꺼짐).
- 기성 대본을 개인 연습용으로 쓰는 것은 사적 이용 범위지만, **대본을 앱에 넣어 배포하거나 공유하지 마세요.** 들어 있는 예시 대본은 이 앱을 위해 새로 쓴 것입니다.

## 개발
- 빌드 없는 정적 웹앱(HTML/CSS/JS). 테스트: `node --test`
- `fileimport.js` 대본 파일 읽기(txt 인코딩·PDF·docx·hwp·한글 97·hwpx·odt·rtf) · `vendor/fflate.js` 압축 해제([fflate](https://github.com/101arrowz/fflate) 0.8.2, MIT) · `vendor/pdfjs/` PDF 읽기 엔진([pdf.js](https://github.com/mozilla/pdf.js) 4.10.38, Apache-2.0, PDF를 열 때만 불러옴)
- `parser.js` 대본 해석·채점·분위기 추정 · `voices.js` 인물별 목소리 배분 · `speech.js` 음성 합성/인식 · `recorder.js` 녹음 · `app.js` 화면 흐름
- `sw.js` + `manifest.webmanifest` 앱 설치(PWA) · `serve.ps1` / `launch.ps1` / `install.ps1` Windows 실행기
- 아이콘 다시 만들기: `python assets/make_icon.py` (Pillow 필요)
- `vendor/qrcode.js` 📱 휴대폰에서 열기 QR을 지금 접속한 주소로 만드는 라이브러리([qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) 1.4.4, MIT). PC 로컬 실행에서는 `assets/qr-mobile.png`(Cloud Run 주소)를 보여 줌

### 배포 (Google Cloud Build → Cloud Run)
`server.js`(Node, 의존성 없음)가 정적 파일과 휴대폰 음성 인식 API(`POST /api/stt`)를 맡습니다. 배포는 `cloudbuild.yaml`이 **테스트 → 이미지 빌드 → Artifact Registry → Cloud Run** 순서로 합니다(테스트가 실패하면 배포 안 함). 내 PC에 Docker가 없어도 됩니다.
- **자동**: `main` 브랜치에 푸시(병합)하면 Cloud Build 트리거가 배포
- **수동**:
```sh
gcloud builds submit --config cloudbuild.yaml --project=acting-practice --region=asia-northeast3 .
```
- 서비스 계정: 빌드 `acting-practice-build`(Cloud Run 배포·이미지 업로드·로그만), 실행 `acting-practice-run`(Speech 사용량만)
- 비용: GCP 예산 알림 월 5,000원(50·90·100%에서 메일) + 월 10,000원(넘었거나 넘을 것으로 예상되면 메일). Claude API 비용은 Anthropic Console에서 따로 한도·알림 설정
- 음성 합성: `tts.js` (`POST /api/tts`, Chirp 3 HD MP3). 목록(`voicecatalog.js`)에 있는 목소리만, 대사 400자까지, 인스턴스당 하루 8만 자·사람(IP)당 하루 4만 자, 같은 대사는 메모리 캐시(20MB)
- AI 배역 분석: `analyze.js` (`POST /api/analyze`, `claude-opus-5-5`, 구조화된 출력). 대본 15만 자·배역 40명까지, IP당 10분에 5회·하루 10회, 인스턴스당 시간당 10회·하루 20회·동시 2건. 키는 Secret Manager `anthropic-api-key` → 환경 변수 `ANTHROPIC_API_KEY` (키가 없으면 '설정 안 됨' 안내만)
- 음성 인식은 서비스 계정 권한으로 Google Speech-to-Text를 부르므로 **API 키가 필요 없습니다** (`speech.googleapis.com` 사용 설정 필요).
- 남용 방지: 녹음 20초·1MB까지, IP당 분당 30회, 인스턴스 최대 3개
- 로컬에서 서버까지 실행: `GCP_ACCESS_TOKEN=$(gcloud auth print-access-token) GCP_PROJECT=acting-practice node server.js` → http://localhost:8080
- `audiokit.js` 무음 감지·WAV 변환 · `cloudstt.js` 휴대폰 녹음 → 서버 채점 흐름

MIT License
