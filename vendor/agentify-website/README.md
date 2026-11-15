# Vendored build tools

`scripts/build_network.mjs`, `scripts/check_partner.mjs` and `templates/network.hocon` are
copied unchanged from `skills/agentify-website` in
[cognizant-ai-labs/agentic-web](https://github.com/cognizant-ai-labs/agentic-web) at commit
`63a956cf4653f610b1c238c70946f4d7647d17a8`, under the Apache License 2.0 (`LICENSE`).

`build_network.mjs` turns a site's `.hocon` network into the published `.network.json` and
checks it against the manifest. `check_partner.mjs` reads another site's public files the way
a calling site does. `tools/build_sites.mjs` in this repository runs the build for both sites.
