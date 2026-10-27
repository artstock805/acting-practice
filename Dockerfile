# Cloud Run용: 정적 앱 + 음성 인식·합성 API + AI 배역 분석(server.js). 외부 패키지는 Anthropic SDK 하나
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production STATIC_ROOT=/app/public
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY server.js tts.js analyze.js insight.js library.js voicecatalog.js ./
COPY index.html android.html style.css manifest.webmanifest sw.js \
     parser.js sample.js fileimport.js voicecatalog.js voices.js cloudtts.js speech.js recorder.js audiokit.js cloudstt.js insightview.js libraryview.js practiceplan.js practicelog.js statsview.js app.js \
     public/
COPY assets/*.png assets/*.ico public/assets/
COPY vendor/qrcode.js vendor/fflate.js public/vendor/
COPY vendor/pdfjs public/vendor/pdfjs
# 안드로이드 앱: 앱 인증 파일(주소창 없이 열리게)과 설치 파일
COPY .well-known/assetlinks.json public/.well-known/
COPY download/acting-practice.apk public/download/

USER node
EXPOSE 8080
CMD ["node", "server.js"]
