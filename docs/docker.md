# Docker

Winch is cloud-agnostic: the portable build is the container - plain Node +
a SQLite file on a volume, no cloud SDKs or provider APIs.

    docker build -t winch .
    docker run -d --name winch --restart unless-stopped \
      -e WINCH_BEARER="$(openssl rand -base64 32)" \
      -v winch-data:/data -p 38292:38292 winch

The default entrypoint runs the shared MCP HTTP daemon on
`WINCH_MCP_HTTP_PORT` (default 38292). `GET /health` is unauthenticated.
Terminate TLS in front. Back up the volume like any stateful file.

The dispatch server is a separate process and is not started by the default
entrypoint. Run it against the same volume with an explicit command, publish
its port, and set the management token because the bind is not loopback:

    docker run -d --name winch-dispatch --restart unless-stopped \
      -e WINCH_DISPATCH_TOKEN="$(openssl rand -base64 32)" \
      -e WINCH_DB=/data/store.sqlite \
      -v winch-data:/data -p 38293:38293 winch \
      webhook serve --host 0.0.0.0 --port 38293

Use one dispatch process per database; it owns retries, offer expiry, and
handing an attempt to another consumer. Keep the MCP and dispatch containers on the same SQLite
volume, and do not run two dispatch replicas against it. Set the same
`WINCH_DISPATCH_URL` and `WINCH_DISPATCH_TOKEN` on the MCP/CLI side so enqueue
notifications reach this server.
