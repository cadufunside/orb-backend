FROM node:20-alpine

ENV NODE_ENV=production \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_PROGRESS=false \
    NPM_CONFIG_PREFER_ONLINE=true \
    NPM_CONFIG_FETCH_RETRIES=9 \
    NPM_CONFIG_FETCH_RETRY_FACTOR=2 \
    NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=45000 \
    NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=240000

WORKDIR /app
RUN apk add --no-cache tini

# manifesto
COPY package.json ./

# .npmrc dentro da imagem (mirror + timeouts)
RUN /bin/sh -lc 'cat > .npmrc << "EOF"\n\
audit=false\n\
fund=false\n\
progress=false\n\
prefer-online=true\n\
fetch-retries=9\n\
fetch-retry-factor=2\n\
fetch-retry-mintimeout=45000\n\
fetch-retry-maxtimeout=240000\n\
fetch-timeout=900000\n\
registry=https://registry.npmmirror.com\n\
EOF'

# cache local do npm
RUN npm config set cache /tmp/.npm-cache --global

# lockfile + install tolerante (sem postinstall)
RUN npm i --package-lock-only --loglevel=warn \
 && npm ci --omit=dev --ignore-scripts --foreground-scripts=false --loglevel=warn

# código
COPY tsconfig.json ./
COPY src ./src

# build TS
RUN npm run build

ENV SESSION_DIR=/data/sessions
RUN mkdir -p ${SESSION_DIR}

USER node
ENTRYPOINT ["/sbin/tini","--"]
CMD ["node","dist/index.js"]
