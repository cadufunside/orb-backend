FROM node:18-alpine

WORKDIR /app

# Chromium para puppeteer/whatsapp-web.js
RUN apk add --no-cache chromium nss freetype

# Puppeteer usando o Chromium do sistema
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

# Copia manifestos primeiro (cache de deps)
COPY package.json ./

# ⚠️ NÃO defina NODE_ENV=production antes do build!
# Instala TODAS as deps (inclui dev) para poder compilar com Nest/TypeScript
RUN npm install --legacy-peer-deps

# Copia o restante do projeto
COPY . .

# Compila (usa o @nestjs/cli instalado nas devDeps)
RUN npx nest build

# Agora sim: modo produção e remove devDeps
ENV NODE_ENV=production
RUN npm prune --omit=dev

EXPOSE 3001
CMD ["node", "dist/main.js"]
