FROM node:24-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates zip \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY server ./server
COPY shared ./shared
COPY extension ./extension
COPY scripts/package.mjs ./scripts/package.mjs
COPY web ./web

# Only public origin/identity values are build inputs. OAuth secrets stay at runtime.
ARG BASE_URL
ARG EXTENSION_PUBLIC_KEY
RUN APP_MODE=production BASE_URL="$BASE_URL" EXTENSION_PUBLIC_KEY="$EXTENSION_PUBLIC_KEY" node scripts/package.mjs \
    && rm -rf web/fixtures \
    && mkdir -p /var/lib/annotated \
    && chown node:node /var/lib/annotated

ENV NODE_ENV=production APP_MODE=production HOST=0.0.0.0 PORT=4317 DATA_DIR=/var/lib/annotated
USER node
EXPOSE 4317
VOLUME ["/var/lib/annotated"]
STOPSIGNAL SIGTERM
CMD ["node", "server/index.mjs"]
