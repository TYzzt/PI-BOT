#!/usr/bin/env bash
# Run as root from a copy of this directory on the target Ubuntu host.
set -euo pipefail
if [[ $EUID -ne 0 ]]; then echo 'Run with sudo or as root' >&2; exit 1; fi
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source /etc/os-release
if [[ "$ID" != ubuntu ]]; then echo 'This installer supports Ubuntu only' >&2; exit 1; fi
export DEBIAN_FRONTEND=noninteractive
if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  apt-get update
  apt-get install -y --no-install-recommends ca-certificates curl python3 openssl
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  cat > /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: ${UBUNTU_CODENAME:-$VERSION_CODENAME}
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
  apt-get update
  apt-get install -y --no-install-recommends docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
systemctl enable --now docker
install -d -m 0700 /opt/pi-bot
install -m 0600 "$source_dir/compose.yml" /opt/pi-bot/compose.yml
install -m 0700 "$source_dir/deploy.sh" /opt/pi-bot/deploy.sh
python3 "$source_dir/init-env.py" /opt/pi-bot
install -m 0644 "$source_dir/pi-bot-update.service" /etc/systemd/system/pi-bot-update.service
install -m 0644 "$source_dir/pi-bot-update.timer" /etc/systemd/system/pi-bot-update.timer
systemctl daemon-reload
docker compose --env-file /opt/pi-bot/.env -f /opt/pi-bot/compose.yml config --quiet
docker version --format '{{.Server.Version}}'
docker compose version
echo 'Docker and configuration ready. Log into Aliyun, then run /opt/pi-bot/deploy.sh.'
echo 'After the first healthy deployment: systemctl enable --now pi-bot-update.timer'
