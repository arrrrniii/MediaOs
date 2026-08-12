FROM node:20-alpine

# ffmpeg/ffprobe for the video pipeline; wget (busybox) for the healthcheck.
RUN apk add --no-cache ffmpeg

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY . .

# Remove global npm (not needed at runtime) to eliminate base image CVEs
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /opt/yarn* /usr/local/bin/yarn /usr/local/bin/yarnpkg

# Run as a non-root user. node:alpine ships a 'node' user (uid 1000); own the
# app dir so the process can read it. Video temp files go to /tmp (world-
# writable), so no extra writable mounts are needed.
RUN chown -R node:node /app
USER node

EXPOSE 3000

# Liveness for orchestrators. Uses the /health endpoint the worker exposes.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health >/dev/null 2>&1 || exit 1

CMD ["node", "src/index.js"]
