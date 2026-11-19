import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StoreTools } from "../tools.mjs";
import { receiptSigner } from "../../server/receipt-signer.mjs";
import { verifyReceipt } from "../../buyer/agentcosign/receipt.js";
import { FileCatalog } from "../catalog.mjs";

test("store confirmation signs exactly one receipt, independently verifiable after restart", async () => {
  const state = mkdtempSync(join(tmpdir(), "store-key-"));
  try {
    const signer = receiptSigner(state);
    const tools = new StoreTools(new FileCatalog(new URL("../catalog.sample.json",import.meta.url)),undefined,signer);
    const quote = await tools.prepare_order({product_id:"OAW-DOCK-04",quantity:1});
    const args = {quote_id:quote.quote_id, confirmed_by_visitor:true};
    const order = await tools.confirm_demo_order(args);
    assert.deepEqual(await tools.confirm_demo_order(args), order);
    const trusted = receiptSigner(state).publicKey;
    assert.equal(await verifyReceipt(order,trusted),"verified");
    assert.equal(await verifyReceipt({...order,total_cents:1},trusted),"invalid");
    assert.equal(await verifyReceipt({...order,shipping:"tomorrow"},trusted),"invalid");
    assert.equal(await verifyReceipt(order,receiptSigner().publicKey),"invalid");
    assert.equal(await verifyReceipt(quote,trusted),"missing");
  } finally { rmSync(state, {recursive:true}); }
});
