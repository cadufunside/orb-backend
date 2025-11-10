FROM node:20-alpine

ENV NODE_ENV=production     NPM_CONFIG_AUDIT=false     NPM_CONFIG_FUND=false     NPM_CONFIG_PROGRESS=false     NPM_CONFIG_PREFER_ONLINE=true     NPM_CONFIG_FETCH_RETRIES=5     NPM_CONFIG_FETCH_RETRY_FACTOR=2     NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=20000     NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=120000

WORKDIR /app
RUN apk add --no-cache tini

# cache de dependências
COPY package.json ./

# cria .npmrc dentro da imagem
RUN printf "audit=false\nfund=false\nprogress=false\nprefer-online=true\nfetch-retries=5\nfetch-retry-factor=2\nfetch-retry-mintimeout=20000\nfetch-retry-maxtimeout=120000\n" > .npmrc

# gera lockfile e instala de forma determinística
RUN npm config set registry https://registry.npmmirror.com \
 && npm config set fetch-retries 7 \
 && npm config set fetch-retry-factor 2 \
 && npm config set fetch-retry-mintimeout 30000 \
 && npm config set fetch-retry-maxtimeout 180000 \
 && npm config set fetch-timeout 600000 \
 && npm i --package-lock-only --omit=dev --loglevel=warn \
 && npm ci --omit=dev --ignore-scripts --foreground-scripts=false --loglevel=warn
# copia o código
COPY tsconfig.json ./
COPY src ./src

ENV SESSION_DIR=./.sessions
RUN mkdir -p ${SESSION_DIR}

RUN npm run build

USER node
ENTRYPOINT ["/sbin/tini","--"]
CMD ["node","dist/index.js"]
