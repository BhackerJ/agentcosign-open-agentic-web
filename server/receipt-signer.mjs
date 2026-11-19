import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { receiptBytes } from "../buyer/agentcosign/receipt.js";

export function receiptSigner(stateDirectory) {
  const file = stateDirectory && join(stateDirectory, "receipt-ed25519.pem");
  let key;
  if (file && existsSync(file)) {
    key = createPrivateKey(readFileSync(file));
  } else {
    key = generateKeyPairSync("ed25519").privateKey;
    if (file) writeFileSync(file, key.export({format:"pem", type:"pkcs8"}), {flag:"wx", mode:0o600});
  }
  return {
    publicKey: createPublicKey(key).export({format:"jwk"}),
    signOrder(order) { return sign(null, receiptBytes(order), key).toString("base64"); },
  };
}
