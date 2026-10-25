#!/bin/sh
# Default to the shared HTTP daemon on $PORT; any explicit args replace it
# (e.g. `watch`, `serve --ws ...`). WINCH_BEARER must come from the
# environment — the server refuses to start without it.
set -e
if [ "$#" -eq 0 ]; then
  set -- serve --mcp http --host 0.0.0.0 --port "${PORT:-38292}"
fi
exec node bin/winch.js "$@"
