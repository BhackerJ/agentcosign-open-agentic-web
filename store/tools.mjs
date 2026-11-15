// The store's four MCP tools and the rules behind them.
//
// The tools never decide for the buyer. check_compatibility reports "unknown" when the store
// lacks a spec, and prepare_order still quotes that product: whether to go on is the buying
// agent's call, and the recorded run shows what it did.

import { SPEC_KEYS } from "./catalog.mjs";

const HOST_PORTS = ["USB-C (DisplayPort Alt Mode)", "Thunderbolt 4"];

export const TOOL_DEFINITIONS = [
  {
    name: "search_products",
    description: "List the store's docking stations with price in US cents and specs. A spec the store has not filled in is null and is named in missing_specs.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What the shopper is looking for, in plain language." },
        max_price_cents: { type: "integer", description: "Highest price to include, in US cents." },
      },
      required: ["query"],
    },
  },
  {
    name: "check_compatibility",
    description: "Check one docking station against the shopper's laptop and displays. Returns compatible, incompatible or unknown, with one line per check and the specs the store is missing.",
    inputSchema: {
      type: "object",
      properties: {
        product_id: { type: "string", description: "A product id from search_products." },
        laptop_port: { type: "string", enum: HOST_PORTS, description: "The laptop port the dock plugs into." },
        displays_at_4k60: { type: "integer", minimum: 1, description: "How many external displays must run at 4K 60 Hz at the same time." },
        min_power_delivery_w: { type: "integer", minimum: 1, description: "Watts the laptop needs from the dock, if it charges through it." },
      },
      required: ["product_id", "laptop_port", "displays_at_4k60"],
    },
  },
  {
    name: "prepare_order",
    description: "Quote a demo order for one product at the current price. Places nothing. Show the quote to the visitor and ask them to confirm before confirm_demo_order.",
    inputSchema: {
      type: "object",
      properties: {
        product_id: { type: "string", description: "A product id from search_products." },
        quantity: { type: "integer", minimum: 1, maximum: 10 },
      },
      required: ["product_id", "quantity"],
    },
  },
  {
    name: "confirm_demo_order",
    description: "Place the simulated order for a quote, only after the visitor has seen the quote and confirmed it. Nothing is charged or shipped.",
    inputSchema: {
      type: "object",
      properties: {
        quote_id: { type: "string", description: "The quote_id from prepare_order." },
        confirmed_by_visitor: { type: "boolean", description: "True only when the visitor confirmed this quote in the conversation." },
      },
      required: ["quote_id", "confirmed_by_visitor"],
    },
  },
];

class ToolInputError extends Error {}

function requireInteger(value, name, min, max = Infinity) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ToolInputError(`${name} must be a whole number${max === Infinity ? ` of at least ${min}` : ` from ${min} to ${max}`}`);
  }
}

function missingSpecs(product) {
  return SPEC_KEYS.filter((key) => product.specs[key] === null);
}

/**
 * Judge one dock against a need, one line per check.
 *
 * :param product: A catalog product.
 * :param need: laptop_port, displays_at_4k60 and optionally min_power_delivery_w.
 * :return: The overall result, the checks, and the specs the store is missing for them.
 */
export function compatibility(product, need) {
  const checks = [];
  const add = (check, spec, required, passes) => {
    const actual = product.specs[spec];
    const result = actual === null ? "unknown" : passes(actual) ? "pass" : "fail";
    checks.push({ check, spec, required, actual, result });
  };
  // A Thunderbolt dock needs a Thunderbolt port; a USB-C DisplayPort dock works on either.
  add("host port", "host_port", need.laptop_port,
    (port) => port === "USB-C (DisplayPort Alt Mode)" || port === need.laptop_port);
  add("displays at 4K 60 Hz", "max_displays_4k60", need.displays_at_4k60, (count) => count >= need.displays_at_4k60);
  if (need.min_power_delivery_w !== undefined) {
    add("power delivery", "power_delivery_w", need.min_power_delivery_w, (watts) => watts >= need.min_power_delivery_w);
  }
  const result = checks.some((c) => c.result === "fail") ? "incompatible"
    : checks.some((c) => c.result === "unknown") ? "unknown" : "compatible";
  return { result, checks, missing_fields: checks.filter((c) => c.result === "unknown").map((c) => c.spec) };
}

/**
 * Runs the store's tools over a catalog. Quotes and orders live in memory.
 */
export class StoreTools {
  /**
   * :param catalog: An object with listProducts().
   * :param now: Returns the current time, replaced in tests.
   */
  constructor(catalog, now = () => new Date()) {
    this.catalog = catalog;
    this.now = now;
    this.quotes = new Map();
    this.orders = new Map();
  }

  async product(id) {
    if (typeof id !== "string" || !id) throw new ToolInputError("product_id is required");
    const product = (await this.catalog.listProducts()).find((p) => p.id === id);
    if (!product) throw new ToolInputError(`no product with the id ${id}; use an id from search_products`);
    return product;
  }

  async search_products(args) {
    if (typeof args.query !== "string" || !args.query.trim()) throw new ToolInputError("query is required");
    if (args.max_price_cents !== undefined) requireInteger(args.max_price_cents, "max_price_cents", 0);
    const cap = args.max_price_cents ?? Infinity;
    const products = (await this.catalog.listProducts())
      .filter((p) => p.price_cents <= cap)
      .map((p) => ({ ...p, missing_specs: missingSpecs(p) }));
    return { products, note: "This store sells only docking stations; the list is its whole range within the price given." };
  }

  async check_compatibility(args) {
    const product = await this.product(args.product_id);
    if (!HOST_PORTS.includes(args.laptop_port)) throw new ToolInputError(`laptop_port must be one of: ${HOST_PORTS.join("; ")}`);
    requireInteger(args.displays_at_4k60, "displays_at_4k60", 1);
    if (args.min_power_delivery_w !== undefined) requireInteger(args.min_power_delivery_w, "min_power_delivery_w", 1);
    return { product_id: product.id, title: product.title, ...compatibility(product, args) };
  }

  async prepare_order(args) {
    const product = await this.product(args.product_id);
    requireInteger(args.quantity, "quantity", 1, 10);
    const quote = {
      quote_id: `Q-${String(this.quotes.size + 1).padStart(4, "0")}`,
      product_id: product.id,
      title: product.title,
      quantity: args.quantity,
      unit_price_cents: product.price_cents,
      total_cents: product.price_cents * args.quantity,
      currency: product.currency,
      missing_specs: missingSpecs(product),
      prepared_at: this.now().toISOString(),
    };
    this.quotes.set(quote.quote_id, quote);
    return { ...quote, next: "Show this quote to the visitor. Call confirm_demo_order only after they confirm it." };
  }

  async confirm_demo_order(args) {
    const quote = this.quotes.get(args.quote_id);
    if (!quote) throw new ToolInputError(`no quote with the id ${args.quote_id}; call prepare_order first`);
    if (args.confirmed_by_visitor !== true) {
      throw new ToolInputError("confirmed_by_visitor must be true: show the quote to the visitor and ask them first");
    }
    // A quote places one order; confirming it again returns that order.
    if (!this.orders.has(quote.quote_id)) {
      this.orders.set(quote.quote_id, {
        order_id: `DEMO-${String(this.orders.size + 1).padStart(4, "0")}`,
        quote_id: quote.quote_id,
        product_id: quote.product_id,
        title: quote.title,
        quantity: quote.quantity,
        total_cents: quote.total_cents,
        currency: quote.currency,
        placed_at: this.now().toISOString(),
        note: "Simulated order. Nothing was charged or shipped.",
      });
    }
    return this.orders.get(quote.quote_id);
  }

  /**
   * Run one tool and wrap its result as an MCP tools/call result.
   *
   * :param name: The tool name.
   * :param args: The tool arguments.
   * :return: An MCP result; a refused input comes back with isError true.
   */
  async call(name, args) {
    if (!TOOL_DEFINITIONS.some((tool) => tool.name === name)) return null;
    try {
      const result = await this[name](args && typeof args === "object" ? args : {});
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      if (!(error instanceof ToolInputError)) throw error;
      return { isError: true, content: [{ type: "text", text: error.message }] };
    }
  }
}
