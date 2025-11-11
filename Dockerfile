FROM node:18-alpine AS builder

RUN apk update && apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json package-lock.json* ./

RUN npm install --omit=dev --unsafe-perm

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

COPY --from=builder /app/node_modules ./node_modules

COPY . .

EXPOSE 3000
USER node
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
