# Cloud Run용 정적 웹 서버. 빌드 단계 없이 앱 파일을 nginx로 그대로 서빙
FROM nginx:1.27-alpine

# nginx 공식 이미지는 templates/*.template의 ${PORT}를 시작할 때 채워 넣음 (Cloud Run이 PORT를 넘겨 줌)
ENV PORT=8080
COPY nginx.conf.template /etc/nginx/templates/default.conf.template

COPY index.html style.css manifest.webmanifest sw.js \
     parser.js sample.js voices.js speech.js recorder.js app.js \
     /usr/share/nginx/html/
COPY assets/*.png assets/*.ico /usr/share/nginx/html/assets/
COPY vendor/qrcode.js /usr/share/nginx/html/vendor/

EXPOSE 8080
