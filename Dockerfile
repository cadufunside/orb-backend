FROM node:18-alpine

WORKDIR /app

# Chromium para puppeteer/whatsapp-web.js
RUN apk add --no-cache chromium nss freetype

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
ENV NODE_ENV=production
# Evita conflitos de peer deps em ambientes CI
ENV NPM_CONFIG_LEGACY_PEER_DEPS=true

# Copia manifestos primeiro p/ cache de dependências
COPY package.json ./

# Instala TODAS deps (inclui dev) para conseguir rodar o build do Nest
RUN npm install

# Copia o restante do projeto
COPY . .

# Compila
RUN npm run build

# Remove devDependencies para deixar a imagem leve
RUN npm prune --omit=dev

EXPOSE 3001
CMD ["node", "dist/main.js"]
