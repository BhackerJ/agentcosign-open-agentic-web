// Tests for the store's book of shared runs. No network is used.
// Run from the repository root: node --test "store/tests/*.test.mjs"
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { StoreTools, TOOL_DEFINITIONS } from "../tools.mjs";
import { RejectedVisit, VisitBook, agentText } from "../visits.mjs";

const SAMPLE = JSON.parse(readFileSync(new URL("../catalog.sample.json", import.meta.url), "utf8")).products;
const TOOL_NAMES = TOOL_DEFINITIONS.map((tool) => tool.name);
const ASK = { product_id: "OAW-DOCK-04", laptop_port: "USB-C (DisplayPort Alt Mode)", displays_at_4k60: 2 };

function book(options = {}) {
  return new VisitBook({ toolNames: TOOL_NAMES, ...options });
}

// Call the store's tools as its MCP server would, note each answer as served, and build the
// run a visitor's recorder would export from the same answers.
async function servedRun(visits, runId, calls = [["check_compatibility", ASK]]) {
  const tools = new StoreTools({ listProducts: async () => structuredClone(SAMPLE) });
  const events = [{ seq: 0, type: "user_message", text: "Buy a dock." }];
  for (const [index, [name, args]] of calls.entries()) {
    const result = await tools.call(name, args);
    visits.recordServed(result);
    const id = `call-${index + 1}`;
    events.push({ seq: events.length, type: "tool_call", call_id: id, tool: name, arguments: args });
    events.push({ seq: events.length, type: "tool_result", call_id: id, tool: name, is_error: Boolean(result.isError), text: agentText(result) });
  }
  events.push({ seq: events.length, type: "agent_text", text: "The store lacks a spec." });
  return { format: "agentcosign-tool-trajectory/1", run_id: runId, page_origin: "https://buyer.example", model: { model: "m" }, task: null, events };
}

test("a run made of answers the store served is cosigned and its missing spec is counted", async () => {
  const visits = book();
  const visit = visits.accept(await servedRun(visits, "run-1"), "1.1.1.1");
  assert.equal(visit.outcome, "stopped_missing_information");
  assert.deepEqual({ ...visit.cosign, claimed: visit.cosign.claimed.length }, { matched: 1, total: 1, cosigned: true, claimed: 1 });
  const { visits: listed, missing_specs } = visits.summary();
  assert.equal(listed[0].trajectory, undefined);
  assert.deepEqual(missing_specs.map(({ product_id, field, visits: n, without_order, listed_now }) => ({ product_id, field, n, without_order, listed_now })),
    [{ product_id: "OAW-DOCK-04", field: "max_displays_4k60", n: 1, without_order: 1, listed_now: null }]);
});

test("a missing spec the store has filled in since is marked as listed now", async () => {
  const visits = book();
  visits.accept(await servedRun(visits, "run-1"), "1.1.1.1");
  const products = structuredClone(SAMPLE);
  assert.equal(visits.summary(products).missing_specs[0].listed_now, false);
  products.find((p) => p.id === "OAW-DOCK-04").specs.max_displays_4k60 = 2;
  assert.equal(visits.summary(products).missing_specs[0].listed_now, true);
});

test("a run with an answer the store never gave is kept but not cosigned or counted", async () => {
  const visits = book();
  const run = await servedRun(visits, "run-1");
  run.events[2].text = run.events[2].text.replace("unknown", "compatible");
  const visit = visits.accept(run, "1.1.1.1");
  assert.deepEqual({ matched: visit.cosign.matched, cosigned: visit.cosign.cosigned }, { matched: 0, cosigned: false });
  assert.deepEqual(visits.summary().missing_specs, []);
});

test("each served answer backs only one shared run", async () => {
  const visits = book();
  const run = await servedRun(visits, "run-1");
  assert.equal(visits.accept(run, "1.1.1.1").cosign.cosigned, true);
  assert.equal(visits.accept({ ...run, run_id: "run-copy" }, "1.1.1.1").cosign.cosigned, false);
  // Served again, the same answer can back one more run.
  assert.equal(visits.accept(await servedRun(visits, "run-2"), "1.1.1.1").cosign.cosigned, true);
});

test("malformed, repeated and too frequent shares are refused", async () => {
  const visits = book({ perHour: 2 });
  const statusOf = (fn) => { try { fn(); return null; } catch (error) { assert.ok(error instanceof RejectedVisit); return error.status; } };
  assert.equal(statusOf(() => visits.accept({ format: "other", events: [] }, "1.1.1.1")), 400);
  const run = await servedRun(visits, "run-1");
  visits.accept(run, "1.1.1.1");
  assert.equal(statusOf(() => visits.accept(run, "2.2.2.2")), 409);
  visits.accept(await servedRun(visits, "run-2"), "1.1.1.1");
  assert.equal(statusOf(() => visits.accept({ ...run, run_id: "run-3" }, "1.1.1.1")), 429);
});

test("a data folder keeps visits and claims across a restart", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "visits-"));
  const first = book({ dataDir });
  const run = await servedRun(first, "run-1");
  const visit = first.accept(run, "1.1.1.1");
  const second = book({ dataDir });
  assert.equal(second.find(visit.visit_id).run_id, "run-1");
  assert.equal(second.summary().missing_specs[0].visits, 1);
  assert.equal(second.accept({ ...run, run_id: "run-copy" }, "1.1.1.1").cosign.cosigned, false);
});
