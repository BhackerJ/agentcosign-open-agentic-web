// Tests for the store's tools and its Shopify catalog reader. No network is used.
// Run from the repository root: node --test "store/tests/*.test.mjs"
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { ShopifyCatalog } from "../catalog.mjs";
import { StoreTools, compatibility } from "../tools.mjs";

const SAMPLE = JSON.parse(await readFile(new URL("../catalog.sample.json", import.meta.url), "utf8")).products;
const NEED = { laptop_port: "USB-C (DisplayPort Alt Mode)", displays_at_4k60: 2 };

function storeTools(products = SAMPLE) {
  return new StoreTools({ listProducts: async () => structuredClone(products) }, () => new Date("2026-11-15T00:00:00Z"));
}

async function run(tools, name, args) {
  const result = await tools.call(name, args);
  return { isError: result.isError === true, body: result.isError ? result.content[0].text : JSON.parse(result.content[0].text) };
}

function filled() {
  const products = structuredClone(SAMPLE);
  products.find((p) => p.id === "OAW-DOCK-04").specs.max_displays_4k60 = 2;
  return products;
}

test("search lists products within the price and names missing specs", async () => {
  const { body } = await run(storeTools(), "search_products", { query: "dock", max_price_cents: 15000 });
  assert.deepEqual(body.products.map((p) => p.id), ["OAW-DOCK-01", "OAW-DOCK-02", "OAW-DOCK-03", "OAW-DOCK-04"]);
  assert.deepEqual(body.products.find((p) => p.id === "OAW-DOCK-04").missing_specs, ["max_displays_4k60"]);
  assert.deepEqual(body.products.find((p) => p.id === "OAW-DOCK-03").missing_specs, []);
});

test("search refuses an empty query", async () => {
  const { isError, body } = await run(storeTools(), "search_products", { query: " " });
  assert.equal(isError, true);
  assert.match(body, /query is required/);
});

test("a missing spec gives unknown and names the field", async () => {
  const { body } = await run(storeTools(), "check_compatibility", { product_id: "OAW-DOCK-04", ...NEED });
  assert.equal(body.result, "unknown");
  assert.deepEqual(body.missing_fields, ["max_displays_4k60"]);
  assert.equal(body.checks.find((c) => c.spec === "max_displays_4k60").actual, null);
});

test("the same product is compatible once the spec is filled in", async () => {
  const { body } = await run(storeTools(filled()), "check_compatibility", { product_id: "OAW-DOCK-04", ...NEED });
  assert.equal(body.result, "compatible");
  assert.deepEqual(body.missing_fields, []);
});

test("too few displays is incompatible, with the failing check", async () => {
  const { body } = await run(storeTools(), "check_compatibility", { product_id: "OAW-DOCK-03", ...NEED });
  assert.equal(body.result, "incompatible");
  assert.deepEqual(body.checks.filter((c) => c.result === "fail").map((c) => c.spec), ["max_displays_4k60"]);
});

test("a Thunderbolt dock fails on a plain USB-C port and passes on Thunderbolt", () => {
  const dock = SAMPLE.find((p) => p.id === "OAW-DOCK-05");
  assert.equal(compatibility(dock, NEED).result, "incompatible");
  assert.equal(compatibility(dock, { ...NEED, laptop_port: "Thunderbolt 4" }).result, "compatible");
});

test("a failed check outranks a missing spec", () => {
  const dock = structuredClone(SAMPLE.find((p) => p.id === "OAW-DOCK-04"));
  assert.equal(compatibility(dock, { ...NEED, min_power_delivery_w: 100 }).result, "incompatible");
});

test("check_compatibility refuses an unknown product and a bad port", async () => {
  const tools = storeTools();
  assert.match((await run(tools, "check_compatibility", { product_id: "nope", ...NEED })).body, /no product with the id nope/);
  assert.match((await run(tools, "check_compatibility", { product_id: "OAW-DOCK-04", ...NEED, laptop_port: "HDMI" })).body, /laptop_port must be one of/);
});

test("prepare_order quotes at the current price and places nothing", async () => {
  const tools = storeTools();
  const { body } = await run(tools, "prepare_order", { product_id: "OAW-DOCK-04", quantity: 2 });
  assert.equal(body.total_cents, 25800);
  assert.deepEqual(body.missing_specs, ["max_displays_4k60"]);
  assert.equal(tools.orders.size, 0);
});

test("confirm_demo_order needs a known quote and the visitor's confirmation", async () => {
  const tools = storeTools(filled());
  const quote = (await run(tools, "prepare_order", { product_id: "OAW-DOCK-04", quantity: 1 })).body;
  assert.match((await run(tools, "confirm_demo_order", { quote_id: "Q-9999", confirmed_by_visitor: true })).body, /no quote/);
  const refused = await run(tools, "confirm_demo_order", { quote_id: quote.quote_id, confirmed_by_visitor: false });
  assert.equal(refused.isError, true);
  assert.equal(tools.orders.size, 0);
});

test("a confirmed quote places one order, and confirming again returns it", async () => {
  const tools = storeTools(filled());
  const quote = (await run(tools, "prepare_order", { product_id: "OAW-DOCK-04", quantity: 1 })).body;
  const first = (await run(tools, "confirm_demo_order", { quote_id: quote.quote_id, confirmed_by_visitor: true })).body;
  const second = (await run(tools, "confirm_demo_order", { quote_id: quote.quote_id, confirmed_by_visitor: true })).body;
  assert.equal(first.total_cents, 12900);
  assert.equal(first.product_id, "OAW-DOCK-04");
  assert.deepEqual(second, first);
  assert.equal(tools.orders.size, 1);
});

test("an unknown tool name gives no result", async () => {
  assert.equal(await storeTools().call("delete_everything", {}), null);
});

test("the Shopify reader maps metafields to specs and renews an expired token once", async () => {
  const calls = [];
  let tokens = 0;
  const fetchStub = async (url, init) => {
    calls.push(url);
    if (url.endsWith("/admin/oauth/access_token")) {
      tokens += 1;
      return Response.json({ access_token: `token-${tokens}` });
    }
    if (init.headers["X-Shopify-Access-Token"] === "token-1") return new Response("", { status: 401 });
    return Response.json({ data: { collectionByHandle: { products: { nodes: [
      { title: "Demo Dock Duo", variants: { nodes: [{ sku: "OAW-DOCK-04", price: "129.00" }] },
        metafields: { nodes: [{ key: "host_port", value: "Thunderbolt 4" }, { key: "video_outputs", value: "2" }] } },
    ] } } } });
  };
  const catalog = new ShopifyCatalog(
    { domain: "example.myshopify.com", clientId: "id", clientSecret: "secret", apiVersion: "2026-07", collection: "docks" }, fetchStub);
  const products = await catalog.listProducts();
  assert.deepEqual(products, [{
    id: "OAW-DOCK-04", title: "Demo Dock Duo", price_cents: 12900, currency: "USD",
    specs: { host_port: "Thunderbolt 4", video_outputs: 2, max_displays_4k60: null, power_delivery_w: null },
  }]);
  assert.equal(tokens, 2);
});
