# Cloud Run용: 정적 앱 + 음성 인식·합성 API + AI 배역 분석(server.js). 외부 패키지는 Anthropic SDK 하나
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production STATIC_ROOT=/app/public
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY server.js tts.js analyze.js voicecatalog.js ./
COPY index.html style.css manifest.webmanifest sw.js \
     parser.js sample.js fileimport.js voicecatalog.js voices.js cloudtts.js speech.js recorder.js audiokit.js cloudstt.js app.js \
     public/
COPY assets/*.png assets/*.ico public/assets/
COPY vendor/qrcode.js vendor/fflate.js public/vendor/
COPY vendor/pdfjs public/vendor/pdfjs

USER node
EXPOSE 8080
CMD ["node", "server.js"]
