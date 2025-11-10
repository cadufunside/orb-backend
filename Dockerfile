FROM node:20-alpine

ENV NODE_ENV=production \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_PROGRESS=false \
    NPM_CONFIG_PREFER_ONLINE=true \
    NPM_CONFIG_FETCH_RETRIES=7 \
    NPM_CONFIG_FETCH_RETRY_FACTOR=2 \
    NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=30000 \
    NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=180000

WORKDIR /app
RUN apk add --no-cache tini

# 1) Copia só o manifesto p/ cache de deps
COPY package.json ./

# 2) Cria .npmrc dentro da imagem (mirror e timeouts)
RUN /bin/sh -lc 'cat > .npmrc << "EOF"\n\
audit=false\n\
fund=false\n\
progress=false\n\
prefer-online=true\n\
fetch-retries=7\n\
fetch-retry-factor=2\n\
fetch-retry-mintimeout=30000\n\
fetch-retry-maxtimeout=180000\n\
fetch-timeout=600000\n\
registry=https://registry.npmmirror.com\n\
EOF'

# 3) Cache local do npm (evita re-download total em builds seguidos)
RUN npm config set cache /tmp/.npm-cache --global

# 4) Gera lockfile e instala de forma determinística (tolerante)
RUN npm i --package-lock-only --omit=dev --loglevel=warn \
 && npm ci --omit=dev --ignore-scripts --foreground-scripts=false --loglevel=warn

# 5) Copia o resto do código
COPY tsconfig.json ./
COPY src ./src

# 6) Build TS
RUN npm run build

# 7) Prepara runtime
ENV SESSION_DIR=./.sessions
RUN mkdir -p ${SESSION_DIR}

USER node
ENTRYPOINT ["/sbin/tini","--"]
CMD ["node","dist/index.js"]
