// Serves the demo store: its site files, an MCP server at POST /mcp, and the product list
// the store page shows.
//
// Usage:
//   node store/server.mjs [--port 8801] [--host 127.0.0.1] [--no-cors] [--log requests.jsonl]
//        [--catalog <file.json> | --store-prefix STORE1]
//        [--relay-upstream <url>] [--relay-key-env <NAME>] [--relay-model <model>]
//        [--visits-dir <folder>]
//
// Products come from a Shopify store's Admin API, read on every tool call. The server reads
// <PREFIX>_DOMAIN, <PREFIX>_CLIENT_ID, <PREFIX>_CLIENT_SECRET and SHOPIFY_API_VERSION from the
// environment (default prefix SHOPIFY); pass them with node --env-file. --catalog reads the
// products from a JSON file instead, such as store/catalog.sample.json.
//
// The public agent files and /mcp send CORS headers, so a browser on another origin can
// read the store's network and call its tools. --no-cors leaves those headers off /mcp,
// to check what a caller sees when a store forgets them.
//
// A visitor on another site can share their agent's run with the store at POST /agent-visits,
// announced in /.well-known/agentcosign.json. The store cosigns it against the answers it
// served (visits.mjs) and lists shared runs at /agent-visits.json for its page. --visits-dir
// keeps both on disk; without it they are lost on restart.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { option, readBody, relayFromEnvironment, startSite } from "../server/site_server.mjs";
import { FileCatalog, ShopifyCatalog } from "./catalog.mjs";
import { StoreTools, TOOL_DEFINITIONS } from "./tools.mjs";
import { RejectedVisit, VisitBook } from "./visits.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PROTOCOL_VERSION = "2025-06-18";
const JSON_TYPE = "application/json; charset=utf-8";

// The Shopify collection that holds the demo products.
const COLLECTION = "oaw-docks-demo";

// Files another agent site reads to run this store's network.
const PUBLIC_FILES = new Set([
  "/agent-manifest.json",
  "/dock_store.network.json",
  "/links.json",
  "/agent-mcp.json",
  "/.well-known/nsdeploy.json",
  "/.well-known/nsdeploy-agent.json",
]);

const CATALOG_DOWN = "The store could not read its catalog. Try again later.";

const mcpCors = !process.argv.includes("--no-cors");
const catalogFile = option("--catalog", "");
const prefix = option("--store-prefix", "SHOPIFY");

function shopifyCatalog() {
  const config = {
    domain: process.env[`${prefix}_DOMAIN`],
    clientId: process.env[`${prefix}_CLIENT_ID`],
    clientSecret: process.env[`${prefix}_CLIENT_SECRET`],
    apiVersion: process.env.SHOPIFY_API_VERSION,
    collection: COLLECTION,
  };
  const missing = Object.entries(config).filter(([, value]) => !value).map(([key]) => key);
  if (missing.length) {
    console.error(`Missing Shopify settings: ${missing.join(", ")}. Set them in the environment or pass --catalog <file>.`);
    process.exit(1);
  }
  return new ShopifyCatalog(config);
}

const catalog = catalogFile ? new FileCatalog(catalogFile) : shopifyCatalog();
const tools = new StoreTools(catalog);
const book = new VisitBook({ dataDir: option("--visits-dir", ""), toolNames: TOOL_DEFINITIONS.map((tool) => tool.name) });

// A shared run holds every answer the store gave in full; a few dozen calls fit well inside this.
const SHARED_RUN_LIMIT = 2_000_000;

async function rpcResult(message) {
  const { id, method, params } = message;
  if (method === "initialize") {
    return { jsonrpc: "2.0", id, result: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: "demo-dock-store", version: "0.1.0" },
    } };
  }
  if (method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: TOOL_DEFINITIONS } };
  if (method === "tools/call") {
    try {
      const result = await tools.call(params?.name, params?.arguments);
      if (!result) return { jsonrpc: "2.0", id, error: { code: -32602, message: `unknown tool: ${params?.name}` } };
      book.recordServed(result);
      return { jsonrpc: "2.0", id, result };
    } catch (error) {
      // The catalog could not be read. Say so without passing on upstream details.
      console.error("tool failed:", error.message);
      const result = { isError: true, content: [{ type: "text", text: CATALOG_DOWN }] };
      book.recordServed(result);
      return { jsonrpc: "2.0", id, result };
    }
  }
  return { jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } };
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept, MCP-Protocol-Version, Mcp-Session-Id",
    "Access-Control-Expose-Headers": "Mcp-Session-Id",
  };
}

const SHARE_CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" };

const json = (send, status, body, headers = {}) => send(status, { ...headers, "Content-Type": JSON_TYPE }, JSON.stringify(body));

async function visitRoutes(request, url, send) {
  // Paths are relative to the store's origin: behind a CDN this server does not see the scheme.
  if (url.pathname === "/.well-known/agentcosign.json" && request.method === "GET") {
    return json(send, 200, { protocol: "agentcosign-visit-share/1", accepts: "agentcosign-tool-trajectory/1", share_url: "/agent-visits", visits_page: "/#agent-visits" },
      { "Access-Control-Allow-Origin": "*" }), true;
  }
  if (url.pathname === "/agent-visits") {
    if (request.method === "OPTIONS") return send(204, SHARE_CORS), true;
    if (request.method !== "POST") return send(405, { ...SHARE_CORS, Allow: "POST, OPTIONS" }), true;
    const address = String(request.headers["x-forwarded-for"] || request.socket.remoteAddress || "").split(",")[0].trim();
    let trajectory;
    try {
      trajectory = JSON.parse(await readBody(request, SHARED_RUN_LIMIT));
    } catch {
      return json(send, 400, { error: "The run could not be read." }, SHARE_CORS), true;
    }
    try {
      const visit = book.accept(trajectory, address);
      const { matched, total, cosigned } = visit.cosign;
      return json(send, 201, { visit_id: visit.visit_id, outcome: visit.outcome, cosign: { matched, total, cosigned }, visits_page: "/#agent-visits" }, SHARE_CORS), true;
    } catch (error) {
      if (error instanceof RejectedVisit) return json(send, error.status, { error: error.message }, SHARE_CORS), true;
      throw error;
    }
  }
  if (url.pathname === "/agent-visits.json" && request.method === "GET") {
    const products = await catalog.listProducts().catch(() => null);
    return json(send, 200, book.summary(products)), true;
  }
  const one = url.pathname.match(/^\/agent-visits\/([0-9a-f-]{36})\.json$/);
  if (one && request.method === "GET") {
    const visit = book.find(one[1]);
    return (visit ? json(send, 200, visit.trajectory) : send(404)), true;
  }
  return false;
}

async function routes(request, url, send, entry) {
  if (await visitRoutes(request, url, send)) return true;
  if (url.pathname === "/mcp") {
    const cors = mcpCors ? corsHeaders() : {};
    if (request.method === "OPTIONS") return send(204, cors), true;
    if (request.method !== "POST") return send(405, { ...cors, Allow: "POST, OPTIONS" }), true;
    let message;
    try {
      message = JSON.parse(await readBody(request));
    } catch {
      const error = { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } };
      return send(400, { ...cors, "Content-Type": JSON_TYPE }, JSON.stringify(error)), true;
    }
    entry.rpc = message.method;
    entry.tool = message.params?.name || null;
    // A notification has no id and gets no body.
    if (message.id === undefined) return send(202, cors), true;
    return send(200, { ...cors, "Content-Type": JSON_TYPE }, JSON.stringify(await rpcResult(message))), true;
  }
  // The store page's own product list, from the same catalog the tools read.
  if (url.pathname === "/products.json" && request.method === "GET") {
    try {
      return send(200, { "Content-Type": JSON_TYPE }, JSON.stringify({ products: await catalog.listProducts() })), true;
    } catch (error) {
      console.error("product list failed:", error.message);
      return send(503, { "Content-Type": JSON_TYPE }, JSON.stringify({ error: CATALOG_DOWN })), true;
    }
  }
  return false;
}

startSite({
  root: ROOT, port: Number(option("--port", "8801")), name: `Demo dock store (catalog: ${catalogFile ? `file ${catalogFile}` : `Shopify collection ${COLLECTION}`})`,
  publicFiles: PUBLIC_FILES, relay: relayFromEnvironment(), routes,
});
