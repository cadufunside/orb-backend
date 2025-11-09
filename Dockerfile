# ---------- STAGE 1: build ----------
FROM node:18-alpine AS builder

WORKDIR /app

# Dependências para chromium / whatsapp-web.js
RUN apk add --no-cache chromium nss freetype harfbuzz ca-certificates ttf-freefont

# Evita baixar Chromium via npm
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

COPY package.json ./

# Instala dependências (usa ci se existir lockfile)
RUN if [ -f package-lock.json ]; then \
      npm ci --legacy-peer-deps; \
    else \
      npm install --legacy-peer-deps; \
    fi

COPY . .
RUN npx nest build
RUN npm prune --omit=dev

# ---------- STAGE 2: runtime ----------
FROM node:18-alpine AS runtime
WORKDIR /app

RUN apk add --no-cache chromium nss freetype harfbuzz ca-certificates ttf-freefont

ENV NODE_ENV=production
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/dist ./dist

EXPOSE 8080
CMD ["node", "dist/main.js"]
