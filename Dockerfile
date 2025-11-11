# Base estável e leve
FROM node:20-alpine

# Hardening e Configurações de Rede do NPM (Mantendo as suas regras robustas)
ENV NODE_ENV=production \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_PROGRESS=false \
    NPM_CONFIG_PREFER_ONLINE=true \
    NPM_CONFIG_FETCH_RETRIES=9 \
    NPM_CONFIG_FETCH_RETRY_FACTOR=2 \
    NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=45000 \
    NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=240000 \
    NPM_CONFIG_FETCH_TIMEOUT=900000

WORKDIR /app

# 🛑 1. ADICIONAR DEPENDÊNCIAS CRÍTICAS DE SISTEMA (Chromium + PG)
# Estas são as bibliotecas que faltavam para o npm install e para o WhatsApp
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    tini \
    postgresql-client \
    # Adicionais para garantir a compilação de bibliotecas nativas como 'pg'
    python3 make g++

# Configura o Puppeteer para usar o Chromium do APK (evita download)
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

# Copia os manifests
COPY package.json package-lock.json* ./

# 🛑 2. INSTALAÇÃO (Mantendo sua lógica robusta)
# O comando abaixo é a sua lógica que tenta usar 'npm ci' e faz fallback.
RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev --ignore-scripts --loglevel=warn ; \
    else \
      npm i --package-lock-only --loglevel=warn && \
      npm ci --omit=dev --ignore-scripts --loglevel=warn ; \
    fi

# 🛑 3. CORREÇÃO DE PERMISSÃO EM RUNTIME (Evita EACCES)
# Movemos a criação de pastas para o Dockerfile para o usuário 'root' criar, 
# e o Node.js pode usar o /tmp, que é sempre gravável.
ENV SESSION_DIR=/tmp/wwebjs-sessions
RUN mkdir -p ${SESSION_DIR} && chown -R node:node ${SESSION_DIR}

# Copia o restante do código
COPY . .

# Permissão para o usuário node (evita EACCES em /app)
# É seguro mudar para o usuário 'node' porque a pasta de sessão agora está em /tmp
RUN chown -R node:node /app
USER node

# 6) Porta e usuário
ENV PORT=8080
EXPOSE 8080

ENTRYPOINT ["/sbin/tini","--"]

# 7) Start do app
CMD ["node", "server.js"]
