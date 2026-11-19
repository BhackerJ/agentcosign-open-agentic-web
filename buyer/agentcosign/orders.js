import { judge, toolCalls } from "./judge.js";
import { verifyReceipt } from "./receipt.js";

const get = async url => {
  const response = await fetch(url);
  if (!response.ok) throw new Error("Unavailable");
  return response.json();
};
const make = (tag, text) => Object.assign(document.createElement(tag), {textContent:text});
async function card(file) {
  const path = "sweep/mistralai-mistral-small-4/" + file + ".json";
  const run = await get("../runs/" + path);
  const result = judge(run);
  const order = toolCalls(run).find(c => c.tool === "confirm_demo_order" && c.data?.order_id)?.data;
  const quote = toolCalls(run).find(c => c.tool === "prepare_order" && c.data?.quote_id)?.data;
  const article = document.createElement("article");
  article.className = result.verdict;
  const link = make("a","Open the full trace");
  link.href = "replay.html?run=" + encodeURIComponent(path);
  article.append(make("h2",order ? "Store recorded the order" : "Order claim without a receipt"),
    make("strong","What the buyer read"), make("blockquote",run.events.filter(e=>e.type==="agent_text").at(-1).text),
    make("strong","What the store returned"), make("p",order
      ? `${order.order_id} · ${order.title} · $${(order.total_cents/100).toFixed(2)}. This archived reply predates signing.`
      : `Quote ${quote.quote_id} only. No call to place the order appears in this visit.`),link);
  return article;
}

const cases = document.querySelector("#cases");
Promise.all(["filled-05","filled-06"].map(card)).then(cards=>cases.replaceChildren(...cards))
  .catch(()=>cases.textContent="The archived runs could not be loaded.");
const status = document.querySelector("#result");
const details = document.querySelector("#input");
const buttons = Array.from(document.querySelectorAll("[data-case]"));
let revision = 0;
async function show(mode, file) {
  const current = ++revision;
  buttons.forEach(b=>b.setAttribute("aria-pressed",String(b.dataset.case === mode)));
  status.textContent = "Checking…";
  details.textContent = "";
  try {
    let key, order;
    if (file) {
      order = JSON.parse(await file.text());
      const {store} = await get("../demo-links.json");
      key = await get(new URL("/.well-known/agentcosign-receipt-key.json",store));
    } else {
      [order,key] = await Promise.all([get("example-order.json"), get("example-store-key.json")]);
      if (mode === "changed") order.total_cents += 100;
      if (mode === "missing") order = {message:"Your order #D17294 has been placed."};
    }
    const result = await verifyReceipt(order,key);
    if (current !== revision) return;
    details.textContent = JSON.stringify(order,null,2);
    status.textContent = {verified:`Signature verified · ${order.order_id} · ${order.currency} ${(order.total_cents/100).toFixed(2)}`,
      invalid:"Invalid signature. The supplied order does not verify with this store key.",
      missing:"Missing store receipt. An agent message alone cannot confirm an order."}[result];
  } catch { if (current === revision) status.textContent="Could not read the receipt or obtain the store key."; }
}
buttons.forEach(b=>b.onclick=()=>show(b.dataset.case));
document.querySelector("#file").onchange=e=>{ if(e.target.files[0]) show("file",e.target.files[0]); };
show("original");
