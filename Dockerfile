FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
# better-sqlite3 is optional (macOS Chrome extraction only); skip it
RUN npm ci --omit=optional
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

FROM node:22-alpine
ENV NODE_ENV=production MCP_TRANSPORT=http HOST=0.0.0.0 PORT=3939 \
    FB_STORAGE_DIR=/data FB_CH_PLATFORM=Windows
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --omit=optional && npm cache clean --force
COPY --from=build /app/dist ./dist
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3939
HEALTHCHECK CMD wget -qO- http://127.0.0.1:3939/healthz || exit 1
CMD ["node", "dist/index.js"]
