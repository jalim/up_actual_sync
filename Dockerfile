FROM node:24-alpine

ENV NODE_ENV=production
WORKDIR /home/node/app

COPY package.json package-lock.json ./
# better-sqlite3 ships prebuilt binaries (incl. musl); no install scripts needed.
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY index.js ./
COPY src ./src
COPY views ./views
COPY public ./public

# The app writes config.json (via the web UI) and a scratch budgets/ dir.
RUN mkdir -p budgets config && chown -R node:node /home/node/app
USER node

EXPOSE 3000
CMD ["node", "index.js"]
