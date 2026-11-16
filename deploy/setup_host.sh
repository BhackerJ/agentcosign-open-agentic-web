#!/usr/bin/env bash
# Sets up a fresh Amazon Linux 2023 host to serve both sites. Run as root. Safe to run again:
# it updates the code, rebuilds the sites for the store's host name and restarts the services.
set -euo pipefail
# First boot runs this with no HOME, and git refuses to run without one.
export HOME="${HOME:-/root}"
repo="${REPO_URL:-https://github.com/BhackerJ/agentcosign-open-agentic-web.git}"
path="${PARAMETER_PATH:-/agentcosign-oaw}"
region="${AWS_REGION:-us-east-1}"
caddy_version=2.11.9

dnf install -y -q nodejs22 git tar
command -v node >/dev/null || alternatives --set node /usr/bin/node-22

if [ ! -x /usr/local/bin/caddy ]; then
  arch="$(uname -m | sed 's/aarch64/arm64/; s/x86_64/amd64/')"
  curl -fsSL "https://github.com/caddyserver/caddy/releases/download/v${caddy_version}/caddy_${caddy_version}_linux_${arch}.tar.gz" \
    | tar -xz -C /usr/local/bin caddy
fi

id oaw >/dev/null 2>&1 || useradd --system --home-dir /opt/agentcosign-oaw --shell /sbin/nologin oaw
# The checkout belongs to the service user, and root updates it.
git config --system --replace-all safe.directory /opt/agentcosign-oaw
if [ -d /opt/agentcosign-oaw/.git ]; then
  git -C /opt/agentcosign-oaw pull -q --ff-only
else
  git clone -q "$repo" /opt/agentcosign-oaw
fi

param() {
  aws ssm get-parameter --name "$path/$1" --region "$region" --query Parameter.Value --output text
}
store_host="$(param store-host)"
buyer_host="$(param buyer-host)"
# "cdn" when a CDN such as CloudFront ends HTTPS and forwards plain HTTP with the visitor's
# Host header; anything else, and Caddy gets the certificates itself.
edge="$(param edge 2>/dev/null || echo caddy)"

cd /opt/agentcosign-oaw
node tools/build_sites.mjs --store-origin "https://${store_host}"
chown -R oaw:oaw /opt/agentcosign-oaw

mkdir -p /etc/caddy /var/lib/caddy
chown oaw:oaw /var/lib/caddy
if [ "$edge" = cdn ]; then
  # Keep the CDN's X-Forwarded-For: its last entry names the visitor, for the rate limits.
  cat > /etc/caddy/Caddyfile <<CADDY
http://${store_host} {
	reverse_proxy 127.0.0.1:8801 {
		header_up X-Forwarded-For {http.request.header.X-Forwarded-For}
	}
}
http://${buyer_host} {
	reverse_proxy 127.0.0.1:8802 {
		header_up X-Forwarded-For {http.request.header.X-Forwarded-For}
	}
}
CADDY
else
  cat > /etc/caddy/Caddyfile <<CADDY
${store_host} {
	reverse_proxy 127.0.0.1:8801
}
${buyer_host} {
	reverse_proxy 127.0.0.1:8802
}
CADDY
fi

for site in store buyer; do
  cat > "/etc/systemd/system/oaw-${site}.service" <<UNIT
[Unit]
Description=AgentCosign demo ${site} site
After=network-online.target
Wants=network-online.target

[Service]
User=oaw
Environment=PARAMETER_PATH=${path} AWS_REGION=${region}
ExecStart=/opt/agentcosign-oaw/deploy/start_site.sh ${site}
StateDirectory=agentcosign-oaw-${site}
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
done

cat > /etc/systemd/system/oaw-caddy.service <<UNIT
[Unit]
Description=Caddy for the AgentCosign demo sites
After=network-online.target
Wants=network-online.target

[Service]
User=oaw
Environment=XDG_DATA_HOME=/var/lib/caddy XDG_CONFIG_HOME=/var/lib/caddy
AmbientCapabilities=CAP_NET_BIND_SERVICE
ExecStart=/usr/local/bin/caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable -q oaw-store oaw-buyer oaw-caddy
systemctl restart oaw-store oaw-buyer oaw-caddy
echo "Serving https://${store_host} and https://${buyer_host}"
