// Builds both sites for one pair of origins: copies the runtime in, fills the store's origin
// into the network sources and manifests, and runs the vendored network build for each site.
// The store also gets a copy of the replay view, to show the runs visitors share with it.
//
// Usage:
//   node tools/build_sites.mjs [--store-origin http://127.0.0.1:8801] [--buyer-origin http://localhost:8802]
//
// The buyer's network names the store's network URL, and each manifest lists the store's
// origin as an allowed peer, so the sites must be rebuilt when the store's address changes.
// Everything this writes is generated and ignored by git.

import { execFileSync } from "node:child_process";
import { cp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VENDOR = path.join(ROOT, "vendor", "agentify-website");
const SITES = [
  { folder: "store", network: "dock_store" },
  { folder: "buyer", network: "buyer_desk" },
];

function originOption(name, fallback) {
  const at = process.argv.indexOf(name);
  const origin = (at >= 0 ? process.argv[at + 1] : fallback).replace(/\/$/, "");
  if (new URL(origin).origin !== origin) {
    console.error(`${name} must be an origin such as https://store.example, not ${origin}`);
    process.exit(1);
  }
  return origin;
}
const storeOrigin = originOption("--store-origin", "http://127.0.0.1:8801");
const buyerOrigin = originOption("--buyer-origin", "http://localhost:8802");

async function fill(template, out) {
  const text = await readFile(template, "utf8");
  await writeFile(out, text.replaceAll("{{STORE_ORIGIN}}", storeOrigin));
}

for (const { folder, network } of SITES) {
  const site = path.join(ROOT, folder);
  await rm(path.join(site, "runtime"), { recursive: true, force: true });
  await cp(path.join(VENDOR, "runtime"), path.join(site, "runtime"), { recursive: true });
  await fill(path.join(site, `${network}.hocon.template`), path.join(site, `${network}.hocon`));
  await fill(path.join(site, "agent-manifest.template.json"), path.join(site, "agent-manifest.json"));
  execFileSync(process.execPath, [
    path.join(VENDOR, "scripts", "build_network.mjs"), path.join(site, `${network}.hocon`),
    "--manifest", path.join(site, "agent-manifest.json"), "--runtime", path.join(site, "runtime"),
  ], { stdio: "inherit" });
  // Each page's guide links to the other site.
  await writeFile(path.join(site, "demo-links.json"), JSON.stringify({ store: storeOrigin, buyer: buyerOrigin }) + "\n");
}
const replayCopy = path.join(ROOT, "store", "agentcosign");
await rm(replayCopy, { recursive: true, force: true });
for (const file of ["receipt.js", "judge.js", "replay-view.js", "replay.css"]) {
  await cp(path.join(ROOT, "buyer", "agentcosign", file), path.join(replayCopy, file), { recursive: true });
}
console.log(`Built both sites for the store at ${storeOrigin} and the buyer at ${buyerOrigin}.`);
