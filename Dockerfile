FROM node:18-alpine

WORKDIR /app

# Instala dependências necessárias ao Chromium
RUN apk add --no-cache chromium nss freetype

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

# Copia package.json e package-lock.json explicitamente
COPY package.json package-lock.json ./

# Instala dependências
# Se existir package-lock.json, usa npm ci; caso contrário, usa npm install
RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev; \
    else \
      npm install --omit=dev; \
    fi

# Copia o restante do projeto
COPY . .

# Compila o projeto (NestJS build)
RUN npm run build

EXPOSE 3001

CMD ["node", "dist/main.js"]
