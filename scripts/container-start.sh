#!/bin/sh
set -eu
# Railway mounts new volumes as root. Prepare ownership, then run all app/agent
# processes as the normal node user, including when RAILWAY_RUN_UID=0 is set.
if [ "$(id -u)" = "0" ]; then
  mkdir -p /data
  find /data -xdev -uid 0 -exec chown --no-dereference node:node {} +
  exec gosu node "$0" "$@"
fi
mkdir -p /data/home /data/home/.codex /data/home/.claude /data/tools/bin
export PA_TOOLS_PREFIX=/data/tools
export NPM_CONFIG_PREFIX=/data/tools
export PATH="/data/tools/bin:/data/home/.local/bin:/data/home/.railway/bin:/data/home/.cargo/bin:/data/home/.bun/bin:$PATH"
if [ -n "${GH_TOKEN:-}" ]; then gh auth setup-git >/dev/null 2>&1; fi
exec "$@"
