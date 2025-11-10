# ------------------------------------------------------------
# Backend WhatsApp QR – build rápido e estável com PNPM (apk)
# ------------------------------------------------------------
FROM node:20-alpine

ENV NODE_ENV=production \
    # (essas variáveis ajudam também em libs que consultam configs do npm)
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_PROGRESS=false \
    NPM_CONFIG_PREFER_ONLINE=true \
    NPM_CONFIG_FETCH_RETRIES=7 \
    NPM_CONFIG_FETCH_RETRY_FACTOR=2 \
    NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=30000 \
    NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=180000

WORKDIR /app

# 0) Tini + PNPM direto do Alpine (evita corepack baixar tarball da npm)
RUN apk add --no-cache tini pnpm

# 1) Copia apenas o manifesto para permitir cache de dependências
COPY package.json ./

# 2) Cria .npmrc dentro da imagem (mirror rápido + timeouts)
#    -> Se o npmmirror não for bom para você, troque para https://registry.npmjs.org
RUN /bin/sh -lc 'cat > .npmrc << "EOF"\n\
registry=https://registry.npmmirror.com\n\
fetch-retries=7\n\
fetch-retry-factor=2\n\
fetch-retry-mintimeout=30000\n\
fetch-retry-maxtimeout=180000\n\
fetch-timeout=600000\n\
prefer-online=true\n\
EOF'

# 3) Gera o lockfile do pnpm (resolve versões, sem instalar ainda)
RUN pnpm install --lockfile-only --reporter=silent

# 4) Prefetch das deps de produção (baixa para o store/cache do pnpm)
#    -> Deixa a próxima instalação "offline" e bem mais rápida
RUN pnpm fetch --prod --reporter=silent --fetch-timeout=600000

# 5) Copia o restante do código
COPY tsconfig.json ./
COPY src ./src

# 6) Instala somente produção usando o que já foi baixado (offline)
RUN pnpm install --prod --offline --frozen-lockfile --reporter=silent

# 7) Compila TypeScript
RUN pnpm build

# 8) Runtime
ENV SESSION_DIR=./.sessions
RUN mkdir -p ${SESSION_DIR}

USER node
ENTRYPOINT ["/sbin/tini","--"]
CMD ["node","dist/index.js"]
