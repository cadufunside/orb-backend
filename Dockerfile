# ========= STAGE 1: build =========
FROM node:18-alpine AS builder
WORKDIR /app

# Dependências pro Chromium (whatsapp-web.js)
RUN apk add --no-cache chromium nss freetype harfbuzz ca-certificates ttf-freefont

# Evita baixar chromium no puppeteer
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

COPY package.json ./
# instala tudo (inclui dev) para compilar
RUN if [ -f package-lock.json ]; then \
      npm ci --legacy-peer-deps; \
    else \
      npm install --legacy-peer-deps; \
    fi

COPY . .
RUN npx nest build

# ========= STAGE 2: run =========
FROM node:18-alpine AS runner
WORKDIR /app

RUN apk add --no-cache chromium nss freetype harfbuzz ca-certificates ttf-freefont
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
ENV NODE_ENV=production

# Copia node_modules do builder e remove devDeps
COPY --from=builder /app/node_modules ./node_modules
RUN npm prune --omit=dev

# Copia dist + package.json para runtime
COPY --from=builder /app/dist ./dist
COPY package.json .

# Porta (Railway injeta PORT; usamos default 3001)
EXPOSE 3001
CMD ["node", "dist/main.js"]
