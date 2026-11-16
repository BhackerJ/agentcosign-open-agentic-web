// The HTTP server both sites share: the site's files, its public agent files with CORS, a
// small public config for the page, and the site-funded model relay at POST /llm/v1/chat/completions.
// A site adds its own routes, such as the store's /mcp.

import { appendFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { ModelRelay } from "./model_relay.mjs";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

// Sources and server code that live in a site folder and are not part of the site.
const PRIVATE = /^\/(server|catalog|tools|visits)\.mjs$|\.template(\.json)?$|\.sample\.json$|shopify-fixtures\.json$|\/tests\//;

/**
 * Read a command-line option's value.
 */
export function option(name, fallback) {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : fallback;
}

export async function readBody(request, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error("body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Build the relay from the command line and environment.
 *
 * --relay-upstream, --relay-key-env and --relay-model override MODEL_RELAY_UPSTREAM,
 * MODEL_RELAY_KEY and MODEL_RELAY_MODEL. Without a key the relay is off.
 */
export function relayFromEnvironment() {
  const keyEnv = option("--relay-key-env", "MODEL_RELAY_KEY");
  return new ModelRelay({
    upstream: option("--relay-upstream", process.env.MODEL_RELAY_UPSTREAM || "https://api.otari.ai/api/v1"),
    key: process.env[keyEnv],
    model: option("--relay-model", process.env.MODEL_RELAY_MODEL || "alibaba/qwen3.8-flash"),
    dailyLimit: Number(process.env.MODEL_RELAY_DAILY_LIMIT || 3000),
  });
}

/**
 * Start one site's server.
 *
 * :param site: root (the site folder), port, name, publicFiles (paths other origins may read),
 *     relay, and routes: a function (request, url, send) that returns true when it answered.
 * :return: The http.Server.
 */
export function startSite({ root, port, name, publicFiles, relay, routes }) {
  const logFile = option("--log", "");
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const entry = { path: url.pathname, method: request.method, origin: request.headers.origin || null };
    const send = (status, headers = {}, body = undefined) => {
      response.writeHead(status, { "Cache-Control": "no-store", ...headers });
      response.end(body);
      if (logFile) appendFileSync(logFile, JSON.stringify({ ...entry, status }) + "\n");
    };
    try {
      if (routes && await routes(request, url, send, entry)) return;

      if (url.pathname === "/site-config.json" && request.method === "GET") {
        // What the page needs to know to offer the site-funded model.
        const config = relay.funded ? { funded: true, model_relay: "/llm/v1", model: relay.model } : { funded: false };
        return send(200, { "Content-Type": TYPES[".json"] }, JSON.stringify(config));
      }

      // The runtime's settings panel asks the router which models it has.
      if (url.pathname === "/llm/v1/models" && request.method === "GET") {
        const models = relay.funded ? [{ id: relay.model, object: "model" }] : [];
        return send(200, { "Content-Type": TYPES[".json"] }, JSON.stringify({ object: "list", data: models }));
      }

      if (url.pathname === "/llm/v1/chat/completions") {
        if (request.method !== "POST") return send(405, { Allow: "POST" });
        // Same-origin pages only: the relay sends no CORS headers, and a browser on another
        // origin names itself here.
        const origin = request.headers.origin;
        if (origin && new URL(origin).host !== request.headers.host) return send(403);
        const address = String(request.headers["x-forwarded-for"] || request.socket.remoteAddress || "").split(",")[0].trim();
        let body;
        try { body = await readBody(request); } catch { return send(413); }
        const reply = await relay.handle(body, address);
        if (!reply.stream) return send(reply.status, reply.headers, reply.body);
        response.writeHead(reply.status, { "Cache-Control": "no-store", ...reply.headers });
        for await (const chunk of reply.stream) response.write(chunk);
        response.end();
        if (logFile) appendFileSync(logFile, JSON.stringify({ ...entry, status: reply.status }) + "\n");
        return;
      }

      if (request.method !== "GET") return send(405, { Allow: "GET" });
      const relative = url.pathname.endsWith("/") ? `${url.pathname}index.html` : url.pathname;
      const file = path.join(root, path.normalize(relative));
      if (!file.startsWith(root + path.sep) || PRIVATE.test(relative)) return send(404);
      const body = await readFile(file).catch(() => null);
      if (body === null) return send(404);
      const headers = { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" };
      if (publicFiles.has(relative)) headers["Access-Control-Allow-Origin"] = "*";
      return send(200, headers, body);
    } catch (error) {
      console.error(`${name}: ${request.method} ${url.pathname} failed: ${error.message}`);
      if (!response.headersSent) send(500);
      else response.end();
    }
  });
  // Local by default. A host behind a proxy passes --host 0.0.0.0.
  const host = option("--host", "127.0.0.1");
  server.listen(port, host, () => {
    console.log(`${name} at http://${host}:${port}/ (site-funded model: ${relay.funded ? relay.model : "off"})`);
  });
  return server;
}
