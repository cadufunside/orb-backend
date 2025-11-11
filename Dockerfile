# === STAGE 1: BUILDER (Instala Node Modules) ===
FROM node:18-alpine AS builder

# Instala ferramentas de build (para compilar 'pg' e outras dependências nativas)
RUN apk update && apk add --no-cache python3 make g++

WORKDIR /app

# Copia apenas os manifestos
COPY package.json package-lock.json* ./

# Instala TODAS as dependências (com tolerância máxima para evitar travamento)
RUN npm install --omit=dev --unsafe-perm

# === STAGE 2: FINAL (Ambiente de Execução Leve) ===
FROM node:18-alpine

# Define o ambiente como produção
ENV NODE_ENV=production

WORKDIR /app

# 1. Instala dependências de sistema (Chromium, Tini, e cliente PG)
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    tini \
    postgresql-client

# 2. Configura as variáveis do Puppeteer
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

# 3. Copia node_modules PRONTOS do estágio de build (Otimização crítica!)
COPY --from=builder /app/node_modules ./node_modules

# 4. Copia o código-fonte (server.js, etc.)
COPY . .

# 5. Comando de Início
EXPOSE 3000
USER node
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
