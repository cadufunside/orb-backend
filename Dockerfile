# ---------- STAGE 1: build ----------
FROM node:18-alpine AS builder

WORKDIR /app

# Dependências do chromium para whatsapp-web.js / puppeteer
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont

# Ponte para o chromium do sistema (não baixar no build)
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

# Instala dependências (inclui dev) para compilar Nest/TS
COPY package.json ./
# se tiver package-lock.json, usa ci; se não, usa install
RUN if [ -f package-lock.json ]; then \
      npm ci --legacy-peer-deps; \
    else \
      npm install --legacy-peer-deps; \
    fi

# Copia código e compila
COPY . .
# garante que o CLI existe via npx
RUN npx nest build

# Remove devDependencies para runtime
RUN npm prune --omit=dev

# ---------- STAGE 2: runtime ----------
FROM node:18-alpine AS runtime

WORKDIR /app

# Mesmo set de libs necessárias no runtime
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont

ENV NODE_ENV=production
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

# Copia artefatos do build
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/dist ./dist

# Cloud Run usa 8080; Railway injeta PORT automaticamente.
EXPOSE 8080

CMD ["node", "dist/main.js"]
