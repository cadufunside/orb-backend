FROM node:18-alpine

# Define o ambiente como produção
ENV NODE_ENV=production

WORKDIR /app

# 1. Instala TODAS as dependências do sistema Linux necessárias
# Inclui Chromium para Puppeteer e cliente PostgreSQL para compilar 'pg'
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    tini \
    postgresql-client

# 2. Configura as variáveis do Puppeteer
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

# 3. Copia o package.json e instala as dependências
COPY package.json package-lock.json* ./

# 4. Comando de instalação limpo e robusto (sem cache/registry forçado)
RUN npm install --omit=dev

# 5. Copia o código-fonte (server.js, etc.)
COPY . .

# 6. Define a porta de exposição (Node.js)
EXPOSE 3000

# 7. Comando de Início
USER node
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
