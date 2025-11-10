FROM node:20-alpine

ENV NODE_ENV=production \
    # acelera e deixa o npm mais resiliente
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_PROGRESS=false \
    NPM_CONFIG_FETCH_RETRIES=5 \
    NPM_CONFIG_FETCH_RETRY_FACTOR=2 \
    NPM_CONFIG_FETCH_TIMEOUT=120000

WORKDIR /app

RUN apk add --no-cache tini

# 1) cache de dependências
COPY package*.json ./
# sempre use npm ci (com lockfile); sem lockfile, rode local e suba-o
RUN npm ci --omit=dev

# 2) agora copie o resto (não invalida cache das deps)
COPY tsconfig.json ./
COPY src ./src

ENV SESSION_DIR=./.sessions
RUN mkdir -p ${SESSION_DIR}

RUN npm run build

USER node
ENTRYPOINT ["/sbin/tini","--"]
CMD ["node","dist/index.js"]
