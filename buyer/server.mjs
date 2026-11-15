// Serves the buyer site: its files, with CORS on the public agent files so other agent
// sites can call this network.
//
// Usage:
//   node buyer/server.mjs [--port 8802] [--host 127.0.0.1] [--log requests.jsonl]
//        [--relay-upstream <url>] [--relay-key-env <NAME>] [--relay-model <model>]

import path from "node:path";
import { fileURLToPath } from "node:url";
import { option, relayFromEnvironment, startSite } from "../server/site_server.mjs";

const PUBLIC_FILES = new Set([
  "/agent-manifest.json",
  "/buyer_desk.network.json",
  "/links.json",
  "/agent-mcp.json",
  "/.well-known/nsdeploy.json",
  "/.well-known/nsdeploy-agent.json",
]);

startSite({
  root: path.dirname(fileURLToPath(import.meta.url)), port: Number(option("--port", "8802")), name: "Buyer desk",
  publicFiles: PUBLIC_FILES, relay: relayFromEnvironment(),
});
