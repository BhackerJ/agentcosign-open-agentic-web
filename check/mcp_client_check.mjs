// Checks a store's MCP server as an outside client would, with no browser and none of this
// repository's code: initialize, list the tools, and call two of them.
//
// Usage:
//   node check/mcp_client_check.mjs <mcp url> [--origin https://some-caller.example]
//
// With --origin it also sends a CORS preflight as a browser on that origin would, and fails
// when the answer would stop that browser.

const url = process.argv[2];
const at = process.argv.indexOf("--origin");
const origin = at >= 0 ? process.argv[at + 1] : null;
if (!url) {
  console.error("Usage: node check/mcp_client_check.mjs <mcp url> [--origin <origin>]");
  process.exit(2);
}

let failures = 0;
function check(label, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `: ${detail}` : ""}`);
  if (!ok) failures += 1;
}

let id = 0;
async function rpc(method, params = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18", ...(origin ? { Origin: origin } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  return { status: response.status, allow: response.headers.get("access-control-allow-origin"), body: await response.json() };
}

if (origin) {
  const preflight = await fetch(url, { method: "OPTIONS", headers: {
    Origin: origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type,mcp-protocol-version",
  } });
  const allow = preflight.headers.get("access-control-allow-origin");
  const headers = (preflight.headers.get("access-control-allow-headers") || "").toLowerCase();
  check("preflight allows the caller's origin", preflight.ok && (allow === "*" || allow === origin), `HTTP ${preflight.status}, allow-origin ${allow}`);
  check("preflight allows the MCP headers", headers.includes("content-type") && headers.includes("mcp-protocol-version"), headers);
}

const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mcp-client-check", version: "0.1.0" } });
check("initialize answers", init.status === 200 && Boolean(init.body.result?.serverInfo), JSON.stringify(init.body.result?.serverInfo));
if (origin) check("the answer carries the CORS header", init.allow === "*" || init.allow === origin, String(init.allow));

const listed = await rpc("tools/list");
const tools = listed.body.result?.tools || [];
const names = tools.map((tool) => tool.name);
check("tools/list names the four store tools",
  ["search_products", "check_compatibility", "prepare_order", "confirm_demo_order"].every((name) => names.includes(name)), names.join(", "));
check("every tool has a description and an input schema", tools.every((tool) => tool.description && tool.inputSchema?.type === "object"));

const search = await rpc("tools/call", { name: "search_products", arguments: { query: "dock" } });
const products = JSON.parse(search.body.result?.content?.[0]?.text || "{}").products || [];
check("search_products returns products", products.length > 0, `${products.length} products`);

const refused = await rpc("tools/call", { name: "check_compatibility", arguments: { product_id: "no-such-product", laptop_port: "Thunderbolt 4", displays_at_4k60: 1 } });
check("a bad product id is refused as a tool error", refused.body.result?.isError === true, refused.body.result?.content?.[0]?.text);

const unknown = await rpc("tools/call", { name: "no_such_tool", arguments: {} });
check("an unknown tool is a JSON-RPC error", Boolean(unknown.body.error), unknown.body.error?.message);

console.log(failures ? `${failures} check(s) failed.` : "All checks passed.");
process.exit(failures ? 1 : 0);
