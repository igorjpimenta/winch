# winch — portable server image. No cloud SDKs, no provider APIs:
# plain Node + SQLite file on a volume. Runs on any VPS / compose / k8s.
#
#   docker build -t winch .
#   docker run -e WINCH_BEARER="$(openssl rand -base64 32)" \
#     -v winch-data:/data -p 38292:38292 winch

FROM node:22-bookworm-slim AS deps
WORKDIR /app
# toolchain for better-sqlite3 prebuild fallback on exotic arches
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
RUN groupadd -r winch && useradd -r -g winch winch \
 && mkdir -p /data && chown winch:winch /data
COPY --from=deps /app/node_modules ./node_modules
COPY bin/ ./bin/
COPY src/ ./src/
COPY .migrations/ ./.migrations/
COPY drizzle.config.js package.json docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh
ENV NODE_ENV=production \
    PORT=38292 \
    WINCH_DB=/data/store.sqlite \
    WINCH_MCP_HTTP_PORT=38292
EXPOSE 38292
VOLUME ["/data"]
USER winch
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||38292)+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
# Bearer comes from the environment at run time (secret, never baked in):
#   -e WINCH_BEARER=...  (refuses to start without it)
ENTRYPOINT ["./docker-entrypoint.sh"]
