# Cloud Run용: 정적 앱 + 휴대폰 녹음 음성 인식 API(server.js). 의존성 없이 Node 내장 모듈만 사용
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production STATIC_ROOT=/app/public
COPY server.js ./
COPY index.html style.css manifest.webmanifest sw.js \
     parser.js sample.js fileimport.js voices.js speech.js recorder.js audiokit.js cloudstt.js app.js \
     public/
COPY assets/*.png assets/*.ico public/assets/
COPY vendor/qrcode.js public/vendor/
COPY vendor/pdfjs public/vendor/pdfjs

USER node
EXPOSE 8080
CMD ["node", "server.js"]
