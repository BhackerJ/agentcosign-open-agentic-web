# Hosting both sites on one small Linux host

Both sites are plain Node servers. Run them on one host behind [Caddy](https://caddyserver.com),
which gets the HTTPS certificates and forwards each host name to its server. One host on
purpose: the store keeps quotes and orders in its process memory, so it must be one process.

- `setup_host.sh`: run once as root on a fresh Amazon Linux 2023 host. It installs Node and
  Caddy, clones this repository to `/opt/agentcosign-oaw`, and installs the three services.
- `start_site.sh`: what each site's service runs. It reads the settings from AWS Systems
  Manager Parameter Store, under the path in `PARAMETER_PATH`, then starts the server.
- `provision_aws.sh`: creates the host on AWS with the AWS CLI: a role that can read those
  parameters, a security group open on ports 80 and 443, the instance and a fixed address.
- `.github/workflows/uptime.yml`, at the repository root: checks both public sites every 15
  minutes, the store's product list and the buyer site's `/health`, free on a public
  repository. A failed run mails whoever last changed its schedule. Update its two addresses
  when the sites move.
- `monitor_aws.sh`: a paid alternative. It watches both sites with Route 53 health checks and mails
  `ALERT_EMAIL` when one fails: the store's product list, which reads Shopify, and the buyer
  site's `/health`, which is 503 when the site-funded model cannot answer (no key, today's
  total spent, or the provider failing). Run it again after a host name changes.

## Settings

Each parameter under the path becomes an environment variable: `shopify-domain` becomes
`SHOPIFY_DOMAIN`. Store secrets as `SecureString`.

| Parameter | Used for |
| --- | --- |
| `store-host`, `buyer-host` | The two host names, such as `store.example.com` |
| `edge` | `cdn` when a CDN such as CloudFront ends HTTPS in front of the host and forwards plain HTTP with the visitor's Host header. Leave it unset for Caddy to get certificates itself |
| `shopify-domain`, `shopify-client-id`, `shopify-client-secret`, `shopify-api-version` | The store's catalog. Use an app that can only read products. Without the secret, the store serves `store/catalog.sample.json` |
| `model-relay-key`, `model-relay-upstream`, `model-relay-model`, `model-relay-daily-limit` | The site-funded model. Without the key, visitors bring their own |

After changing a parameter, restart the services: `systemctl restart oaw-store oaw-buyer`.
After changing a host name, also run `/opt/agentcosign-oaw/deploy/setup_host.sh` again: it
rebuilds the sites for the store's address and rewrites the Caddy configuration.

Point both host names at the host's address before Caddy can get certificates.

Behind a CDN, the host needs no certificate and no DNS record of its own: forward all headers,
turn caching off, and let only the CDN reach port 80.
