FROM node:18-alpine

# Define o ambiente como produção
ENV NODE_ENV=production

WORKDIR /app

# 1. Instala dependências do sistema Linux necessárias para o Puppeteer (Chromium)
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    tini

# 2. Configura as variáveis do Puppeteer para usar o Chromium instalado
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

# 3. Copia o package.json e instala as dependências
COPY package.json package-lock.json* ./

# 4. Instala as dependências de forma robusta
# Usando 'npm install' em vez de 'npm ci' para maior compatibilidade.
RUN npm install --omit=dev

# 5. Copia o código-fonte
COPY . .

# 6. Define a porta de exposição (Node.js)
EXPOSE 3000

# 7. Comando de Início (usando tini para gerenciar o processo Node)
USER node
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
