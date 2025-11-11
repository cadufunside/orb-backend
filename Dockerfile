# === STAGE 1: BUILDER (Instala Node Modules) ===
FROM node:18-alpine AS builder

# Instala dependências de build (para PostgreSQL/nativo)
RUN apk update && apk add --no-cache python3 make g++

WORKDIR /app

# Copia apenas os manifestos
COPY package.json package-lock.json* ./

# Instala dependências (com tolerância máxima para evitar travamento)
RUN npm install --omit=dev --unsafe-perm

# === STAGE 2: FINAL (Ambiente de Execução Leve) ===
FROM node:18-alpine

# Instala dependências de sistema (Chromium, Tini, PG Client)
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    tini \
    postgresql-client

# Configura as variáveis do Puppeteer
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

WORKDIR /app

# Copia node_modules do estágio de build (Otimização crítica!)
COPY --from=builder /app/node_modules ./node_modules

# Copia o código-fonte (server.js, etc.)
COPY . .

# Comando de Início
EXPOSE 3000
USER node
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
