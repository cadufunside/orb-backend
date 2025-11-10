FROM node:18-alpine

# Define o ambiente como produção
ENV NODE_ENV=production

WORKDIR /app

# 1. Instala TODAS as dependências do sistema
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    tini \
    # **CORREÇÃO CRÍTICA**: Adiciona o cliente PostgreSQL para compilar a dependência 'pg'
    postgresql-client 

# 2. Configura as variáveis do Puppeteer
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

# 3. Copia o package.json e instala as dependências
COPY package.json package-lock.json* ./

# 4. **CORREÇÃO DE INSTALAÇÃO**: Usa um comando mais simples para evitar travamentos
RUN npm install --omit=dev

# 5. Copia o código-fonte
COPY . .

# 6. Comando de Início
EXPOSE 3000
USER node
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
