FROM node:20-alpine

# Define o ambiente como produção
ENV NODE_ENV=production

WORKDIR /app

# 1. Instala dependências de sistema para o Chromium e PostgreSQL
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    tini \
    postgresql-client \
    # Dependências de build
    python3 make g++ 

# 2. Configura as variáveis do Puppeteer
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

# 3. Copia o package.json e instala as dependências
COPY package.json package-lock.json* ./

# 🛑 4. CORREÇÃO FINAL DE INSTALAÇÃO: Rápido e anti-travamento
RUN npm install --omit=dev --no-scripts --unsafe-perm

# 5. Copia o código-fonte
COPY . .

# 6. Comando de Início
EXPOSE 3000
USER node
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
