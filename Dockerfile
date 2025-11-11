FROM node:18-alpine

ENV NODE_ENV=production

WORKDIR /app

RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    tini \
    postgresql-client

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

COPY package.json package-lock.json* ./

# 🛑 CORREÇÃO FINAL: Usamos 'npm install' simples para evitar travamento de cache
RUN npm install --omit=dev

COPY . .

EXPOSE 3000
USER node
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
