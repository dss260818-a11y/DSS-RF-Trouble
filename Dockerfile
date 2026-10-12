# RF 기술이슈 관리 시스템 — 컨테이너 이미지
# 외부 패키지가 없어서 npm install 단계가 없다. 코드만 넣는다.
# 설정(config.json)·데이터(data/)·공유폴더는 이미지에 넣지 않고 실행할 때 연결(마운트)한다.
FROM node:24-alpine

# TZ 가 먹으려면 tzdata 가 있어야 한다 (주간보고·백업 날짜가 한국 시각 기준)
RUN apk add --no-cache tzdata

ENV NODE_ENV=production \
    TZ=Asia/Seoul \
    HOST=0.0.0.0 \
    PORT=7331 \
    WORKLOG=off

WORKDIR /app
COPY server.js ./
COPY tools ./tools
COPY public ./public
RUN mkdir -p /app/data /backup && chown node:node /app/data /backup

USER node
EXPOSE 7331

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:7331/api/health >/dev/null || exit 1

CMD ["node", "server.js"]
