# Docker

Winch is cloud-agnostic: the portable build is the container - plain Node +
a SQLite file on a volume, no cloud SDKs or provider APIs.

    docker build -t winch .
    docker run -d --name winch --restart unless-stopped \
      -e WINCH_BEARER="$(openssl rand -base64 32)" \
      -v winch-data:/data -p 38292:38292 winch

The container listens on WINCH_MCP_HTTP_PORT (default 38292). GET /health is
unauthenticated. Terminate TLS in front. Back up the volume like any stateful
file.
