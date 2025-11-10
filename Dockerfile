FROM node:20-alpine
WORKDIR /app
RUN apk add --no-cache tini
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm i; fi
COPY tsconfig.json .
COPY src ./src
ENV NODE_ENV=production
ENV SESSION_DIR=./.sessions
RUN mkdir -p ${SESSION_DIR}
RUN npm run build
USER node
ENTRYPOINT ["/sbin/tini","--"]
CMD ["node","dist/index.js"]
