# ------------------------------------------------------------
# Backend WhatsApp QR – Dockerfile DEFINITIVO (npm)
# Funciona em regiões lentas (timeouts altos, retries, mirror opcional).
# ------------------------------------------------------------
FROM node:20-alpine

ENV NODE_ENV=production     NPM_CONFIG_AUDIT=false     NPM_CONFIG_FUND=false     NPM_CONFIG_PROGRESS=false     NPM_CONFIG_PREFER_ONLINE=true     NPM_CONFIG_FETCH_RETRIES=9     NPM_CONFIG_FETCH_RETRY_FACTOR=2     NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=45000     NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=240000

WORKDIR /app

RUN apk add --no-cache tini

COPY package.json ./

RUN /bin/sh -lc 'cat > .npmrc << "EOF"\naudit=false\nfund=false\nprogress=false\nprefer-online=true\nfetch-retries=9\nfetch-retry-factor=2\nfetch-retry-mintimeout=45000\nfetch-retry-maxtimeout=240000\nfetch-timeout=900000\nregistry=https://registry.npmjs.org\nEOF'

RUN npm config set cache /tmp/.npm-cache --global

RUN npm i --package-lock-only --loglevel=warn  && npm ci --omit=dev --ignore-scripts --foreground-scripts=false --loglevel=warn

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

ENV SESSION_DIR=./.sessions
RUN mkdir -p ${SESSION_DIR}

USER node
ENTRYPOINT ["/sbin/tini","--"]
CMD ["node","dist/index.js"]
