// Shows the store's range on the page, from the same catalog the store's tools read, and what
// buying agents ran into here, from the runs visitors shared with the store.
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

const SPEC_LABELS = Object.fromEntries(SPECS.map(([key, label]) => [key, label]));

const OUTCOMES = {
  ordered: "Ordered",
  quoted: "Quoted, no order",
  stopped_missing_information: "Stopped: a spec was missing",
  stopped_nothing_compatible: "Stopped: nothing fit",
  no_purchase_attempt: "Did not try to buy",
};

function productCard(product) {
  const item = element("li", "product");
  item.dataset.productId = product.id;
  const head = element("div", "head");
  head.append(element("h3", "", product.title), element("span", "price", `$${(product.price_cents / 100).toFixed(2)}`));
  const specs = element("dl", "specs");
  for (const [key, label, format] of SPECS) {
    const value = product.specs[key];
    specs.append(element("dt", "", label), element("dd", value === null ? "missing" : "", value === null ? "Not listed" : format(value)));
  }
  item.append(head, element("span", "sku", product.id), specs, element("p", "agent-note"));
  return item;
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function showMissingSpecs(gaps) {
  const box = document.querySelector("#missing-specs");
  for (const note of document.querySelectorAll(".product .agent-note")) note.textContent = "";
  if (!gaps.length) {
    box.replaceChildren();
    return;
  }
  const list = element("ul", "gaps");
  for (const gap of gaps) {
    const label = SPEC_LABELS[gap.field] || gap.field;
    const item = element("li", gap.listed_now ? "gap fixed" : "gap");
    const counts = `${plural(gap.visits, "shared run")} needed it; ${gap.without_order} ended without an order.`;
    item.append(
      element("strong", "", gap.listed_now ? `${gap.title}: “${label}” is listed now.` : `${gap.title}: “${label}” is not listed.`),
      element("span", "", gap.listed_now ? ` Before it was, ${counts}` : ` ${counts}`),
    );
    list.append(item);
    const note = document.querySelector(`.product[data-product-id="${CSS.escape(gap.product_id)}"] .agent-note`);
    if (note) {
      note.textContent = gap.listed_now ? `Listed after ${plural(gap.visits, "agent")} could not confirm it.` : `${plural(gap.visits, "agent")} could not confirm “${label}”.`;
      note.classList.toggle("fixed", Boolean(gap.listed_now));
    }
  }
  box.replaceChildren(element("h3", "", "Missing specs that stopped agents"), list);
}

function visitItem(visit) {
  const item = element("li", "visit");
  const when = new Date(visit.received_at).toLocaleString();
  const from = visit.page_origin ? new URL(visit.page_origin).host : "another site";
  const head = element("div", "visit-head");
  head.append(element("span", "outcome", OUTCOMES[visit.outcome] || visit.outcome), element("span", "meta", `${when} · from ${from}${visit.model ? ` · ${visit.model}` : ""}`));
  const cosign = `The store gave all ${visit.cosign.total} tool answers in this run.`;
  const link = element("a", "", "Replay");
  link.href = `visit.html?id=${encodeURIComponent(visit.visit_id)}`;
  item.append(head, element("p", "", visit.summary), element("p", "cosign", cosign), link);
  return item;
}

async function showVisits() {
  const status = document.querySelector("#visits-status");
  try {
    const response = await fetch("agent-visits.json");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const { visits, uncounted, missing_specs } = await response.json();
    showMissingSpecs(missing_specs);
    document.querySelector("#visit-list").replaceChildren(...visits.slice(0, 10).map(visitItem));
    const notCounted = uncounted ? ` ${plural(uncounted, "other shared run")} did not match the store's answers and ${uncounted === 1 ? "is" : "are"} not shown.` : "";
    status.textContent = (visits.length ? "" : "No agent run has been shared with the store yet.") + notCounted;
    status.hidden = !status.textContent;
  } catch {
    status.textContent = "The store could not load its shared runs.";
    status.hidden = false;
  }
}

document.querySelector("#network-url").textContent = `${location.origin}/dock_store`;
document.querySelector("#mcp-url").textContent = `${location.origin}/mcp`;

// The guide links to the buyer site, whose address the build writes; without it the guide stays hidden.
fetch("demo-links.json").then((response) => response.ok ? response.json() : Promise.reject()).then((links) => {
  for (const link of document.querySelectorAll("[data-demo-link]")) link.href = `${links[link.dataset.demoLink]}/${link.dataset.path || ""}`;
  document.querySelector(".guide").hidden = false;
}).catch(() => {});

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
await showVisits();
setInterval(showVisits, 10_000);
