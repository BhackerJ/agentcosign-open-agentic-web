// node check/verify_receipt.mjs <order.json> <trusted-store-public-key.json>
import { readFileSync } from "node:fs";
import { verifyReceipt } from "../buyer/agentcosign/receipt.js";
try {
  const [orderFile, keyFile] = process.argv.slice(2);
  const read = file => JSON.parse(readFileSync(file, "utf8"));
  const result = await verifyReceipt(read(orderFile), read(keyFile));
  console.log(result);
  process.exitCode = result === "verified" ? 0 : 1;
} catch {
  console.error("Provide an order JSON file and an independently obtained store public JWK.");
  process.exitCode = 2;
}
