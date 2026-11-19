// The verifier takes a public key supplied by the caller, independently of the receipt.
const fields = ["order_id", "quote_id", "product_id", "title", "quantity", "total_cents", "currency", "placed_at", "note"];
export function receiptBytes(order) {
  if (!order || Object.keys(order).some(k => k !== "signature" && !fields.includes(k)) || !fields.every(k => ["quantity", "total_cents"].includes(k)
    ? Number.isSafeInteger(order[k]) && order[k] >= (k === "quantity" ? 1 : 0)
    : typeof order[k] === "string" && order[k].length > 0)) throw new Error("Invalid demo order");
  return new TextEncoder().encode(JSON.stringify(["agentcosign/demo-order/v1", ...fields.map(k => order[k])]));
}

export async function verifyReceipt(order, publicJwk) {
  if (!order || typeof order !== "object" || !order.signature) return "missing";
  try {
    const key = await crypto.subtle.importKey("jwk", publicJwk, "Ed25519", false, ["verify"]);
    const sig = Uint8Array.from(atob(order.signature), c => c.charCodeAt(0));
    return await crypto.subtle.verify("Ed25519", key, sig, receiptBytes(order)) ? "verified" : "invalid";
  } catch { return "invalid"; }
}
