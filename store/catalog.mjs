// Where the store's products come from: a Shopify store's Admin API, or a JSON file.
//
// Both return the same product shape, with prices in US cents and the four dock specs.
// A spec the merchant has not filled in is null.

import { readFile } from "node:fs/promises";

export const SPEC_KEYS = ["host_port", "video_outputs", "max_displays_4k60", "power_delivery_w"];
const INTEGER_SPECS = new Set(["video_outputs", "max_displays_4k60", "power_delivery_w"]);

const COLLECTION_QUERY = `query($handle: String!) {
  collectionByHandle(handle: $handle) {
    products(first: 50) { nodes {
      title
      variants(first: 1) { nodes { sku price } }
      metafields(first: 20, namespace: "dock") { nodes { key value } }
    } }
  }
}`;

/**
 * Reads one collection's products from a Shopify store on every call, so an edit in the
 * Shopify admin shows up in the next tool call.
 */
export class ShopifyCatalog {
  /**
   * :param config: domain, clientId, clientSecret, apiVersion and the collection handle.
   * :param fetchImpl: The fetch to use, replaced in tests.
   */
  constructor({ domain, clientId, clientSecret, apiVersion, collection }, fetchImpl = fetch) {
    this.domain = domain;
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.apiVersion = apiVersion;
    this.collection = collection;
    this.fetch = fetchImpl;
    this.token = null;
  }

  async accessToken() {
    if (this.token) return this.token;
    const response = await this.fetch(`https://${this.domain}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials", client_id: this.clientId, client_secret: this.clientSecret,
      }),
    });
    if (!response.ok) throw new Error(`Shopify token request failed with HTTP ${response.status}`);
    this.token = (await response.json()).access_token;
    return this.token;
  }

  async query(retry = true) {
    const response = await this.fetch(`https://${this.domain}/admin/api/${this.apiVersion}/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": await this.accessToken() },
      body: JSON.stringify({ query: COLLECTION_QUERY, variables: { handle: this.collection } }),
    });
    // A token expires after a day: ask for a new one once.
    if (response.status === 401 && retry) {
      this.token = null;
      return this.query(false);
    }
    if (!response.ok) throw new Error(`Shopify catalog request failed with HTTP ${response.status}`);
    const body = await response.json();
    if (body.errors) throw new Error(`Shopify catalog request failed: ${JSON.stringify(body.errors)}`);
    return body.data;
  }

  /**
   * :return: The collection's products, in SKU order.
   */
  async listProducts() {
    const data = await this.query();
    if (!data.collectionByHandle) throw new Error(`Shopify has no collection with the handle ${this.collection}`);
    const products = data.collectionByHandle.products.nodes.map((node) => {
      const variant = node.variants.nodes[0];
      const found = Object.fromEntries(node.metafields.nodes.map((m) => [m.key, m.value]));
      const specs = {};
      for (const key of SPEC_KEYS) {
        const value = found[key];
        specs[key] = value === undefined || value === "" ? null : INTEGER_SPECS.has(key) ? Number(value) : value;
      }
      return { id: variant.sku, title: node.title, price_cents: Math.round(Number(variant.price) * 100), currency: "USD", specs };
    });
    return products.sort((a, b) => a.id.localeCompare(b.id));
  }
}

/**
 * Reads the products from a JSON file on every call. For runs without a Shopify store.
 */
export class FileCatalog {
  constructor(file) {
    this.file = file;
  }

  async listProducts() {
    return JSON.parse(await readFile(this.file, "utf8")).products;
  }
}
