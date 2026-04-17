#!/usr/bin/env bash
set -euo pipefail

mkdir -p /root/.openclaw /root/.ssh /workspace
chmod 700 /root/.ssh

if [ "${OPENCLAW_SSH_MODE:-generated}" = "host" ] && [ -d /ssh-host ]; then
  shopt -s nullglob
  copied_any=false
  for source_path in /ssh-host/*; do
    base_name="$(basename "$source_path")"
    target_path="/root/.ssh/$base_name"
    if [ ! -e "$target_path" ]; then
      cp -a "$source_path" "$target_path"
      copied_any=true
    fi
  done
  shopt -u nullglob
  chmod 700 /root/.ssh
  find /root/.ssh -type f \( -name 'id_*' -o -name 'known_hosts' -o -name 'config' \) -exec chmod 600 {} \; 2>/dev/null || true
  find /root/.ssh -type f -name '*.pub' -exec chmod 644 {} \; 2>/dev/null || true
  if [ "$copied_any" = true ]; then
    echo "Copied SSH material from host mount into /root/.ssh"
  else
    echo "Host SSH mode enabled, existing /root/.ssh preserved"
  fi
fi

if [ ! -f /root/.ssh/id_ed25519 ]; then
  ssh-keygen -t ed25519 -N "" -f /root/.ssh/id_ed25519 -C "openclaw-container-$(hostname)" >/dev/null
  echo "Generated SSH public key for this container:"
  cat /root/.ssh/id_ed25519.pub
fi

if [ ! -f /root/.openclaw/openclaw.json ]; then
  envsubst < /etc/openclaw/openclaw.template.json > /root/.openclaw/openclaw.json
  echo "Created persistent config at /root/.openclaw/openclaw.json"
else
  echo "Keeping existing persistent config at /root/.openclaw/openclaw.json"
fi

exec "$@"
