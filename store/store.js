// Shows the store's range on the page, from the same catalog the store's tools read.
// A spec the store has not filled in is shown as "Not listed".

const SPECS = [
  ["host_port", "Connects to", (value) => value],
  ["video_outputs", "Video outputs", (value) => String(value)],
  ["max_displays_4k60", "Displays at 4K 60 Hz", (value) => String(value)],
  ["power_delivery_w", "Power delivery", (value) => `${value} W`],
];

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function productCard(product) {
  const item = element("li", "product");
  const head = element("div", "head");
  head.append(element("h3", "", product.title), element("span", "price", `$${(product.price_cents / 100).toFixed(2)}`));
  const specs = element("dl", "specs");
  for (const [key, label, format] of SPECS) {
    const value = product.specs[key];
    specs.append(element("dt", "", label), element("dd", value === null ? "missing" : "", value === null ? "Not listed" : format(value)));
  }
  item.append(head, element("span", "sku", product.id), specs);
  return item;
}

document.querySelector("#network-url").textContent = `${location.origin}/dock_store`;
document.querySelector("#mcp-url").textContent = `${location.origin}/mcp`;

const status = document.querySelector("#range-status");
try {
  const response = await fetch("products.json");
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const { products } = await response.json();
  document.querySelector("#products").replaceChildren(...products.map(productCard));
  status.hidden = true;
} catch {
  status.textContent = "The store could not load its products. Try again later.";
}
