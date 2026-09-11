#!/usr/bin/env bash
# One-time setup for the ZendeskSanitizing VM (Ubuntu 24.04). Review before running.
set -euo pipefail

sudo apt-get update && sudo apt-get install -y ca-certificates curl git ufw
# Docker Engine + compose plugin (official repo)
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo tee /etc/apt/keyrings/docker.asc >/dev/null
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
sudo apt-get update && sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
sudo usermod -aG docker "$USER"

# Firewall: SSH + HTTPS only
sudo ufw allow OpenSSH && sudo ufw allow 443/tcp && sudo ufw --force enable

sudo mkdir -p /opt/zsan && sudo chown "$USER" /opt/zsan
cat <<'EOF'
Next steps (manual):
  1. git clone the repo, e.g. into /opt/zsan/app
  2. Create /opt/zsan/.env with ZSAN_ZENDESK_*, ZSAN_CLIENT_TOKENS (name:token per developer), ZSAN_PASS2=required
  3. export ZSAN_DOMAIN=<your-dns-name>   (or leave unset for self-signed localhost testing)
  4. cd /opt/zsan/app && docker compose --env-file deploy/versions.env -f deploy/docker-compose.yml --profile vm up -d --build
  5. Verify: curl -k https://localhost/healthz
EOF
