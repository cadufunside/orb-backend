FROM node:20-alpine

ENV NODE_ENV=production \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_PROGRESS=false \
    NPM_CONFIG_PREFER_ONLINE=true \
    NPM_CONFIG_FETCH_RETRIES=5 \
    NPM_CONFIG_FETCH_RETRY_FACTOR=2 \
    NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=20000 \
    NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=120000

WORKDIR /app
RUN apk add --no-cache tini

# cache de dependências
COPY .npmrc package.json ./

# gera lockfile e instala de forma determinística
RUN npm i --package-lock-only --omit=dev && npm ci --omit=dev

# código
COPY tsconfig.json ./
COPY src ./src

ENV SESSION_DIR=./.sessions
RUN mkdir -p ${SESSION_DIR}

RUN npm run build

USER node
ENTRYPOINT ["/sbin/tini","--"]
CMD ["node","dist/index.js"]
