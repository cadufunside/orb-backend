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

# 1) Habilita PNPM via Corepack
RUN corepack enable

# 2) Copia só o manifesto (melhor cache)
COPY package.json ./

# 3) Cria .npmrc dentro da imagem (mirror + timeouts)
RUN /bin/sh -lc 'cat > .npmrc << "EOF"\n\
registry=https://registry.npmmirror.com\n\
fetch-retries=7\n\
fetch-retry-factor=2\n\
fetch-retry-mintimeout=30000\n\
fetch-retry-maxtimeout=180000\n\
fetch-timeout=600000\n\
prefer-online=true\n\
EOF'

# 4) Gera lockfile do pnpm (sem instalar nada ainda)
#    (resolve versões e grava pnpm-lock.yaml)
RUN pnpm install --lockfile-only --reporter=silent

# 5) Instala somente prod com lockfile (rápido e determinístico)
RUN pnpm install --frozen-lockfile --prod --reporter=silent --network-concurrency=8 --fetch-timeout=600000

# 6) Copia o resto do código
COPY tsconfig.json ./
COPY src ./src

# 7) Build TS
RUN pnpm build

# 8) Runtime
ENV SESSION_DIR=./.sessions
RUN mkdir -p ${SESSION_DIR}

USER node
ENTRYPOINT ["/sbin/tini","--"]
CMD ["node","dist/index.js"]
