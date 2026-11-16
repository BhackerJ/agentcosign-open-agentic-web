// Tests for the store's book of shared runs. No network is used.
// Run from the repository root: node --test "store/tests/*.test.mjs"
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { StoreTools, TOOL_DEFINITIONS } from "../tools.mjs";
import { RejectedVisit, VisitBook, agentText } from "../visits.mjs";

const HOST = "store.example";

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
  const events = [{ seq: 0, type: "user_message", text: "Buy a dock." },
    { seq: 1, type: "consent", kind: "network", phase: "call", peer_label: "Store", peer_origin: HOST, request_text: "Check a dock.", decision: "allow" }];
  for (const [index, [name, args]] of calls.entries()) {
    const result = await tools.call(name, args);
    visits.recordServed(name, args, result);
    const id = `call-${index + 1}`;
    events.push({ seq: events.length, type: "tool_call", call_id: id, url: `https://${HOST}/mcp`, origin: `https://${HOST}`, tool: name, arguments: args });
    events.push({ seq: events.length, type: "tool_result", call_id: id, tool: name, is_error: Boolean(result.isError), text: agentText(result) });
  }
  events.push({ seq: events.length, type: "agent_text", text: "The store lacks a spec." });
  return { format: "agentcosign-tool-trajectory/1", run_id: runId, page_origin: "https://buyer.example", model: { model: "m" }, task: null, events };
}

test("a run made of answers the store served is cosigned and its missing spec is counted", async () => {
  const visits = book();
  const visit = visits.accept(await servedRun(visits, "run-1"), "1.1.1.1", HOST);
  assert.equal(visit.outcome, "stopped_missing_information");
  assert.deepEqual({ ...visit.cosign, claimed: visit.cosign.claimed.length }, { matched: 1, total: 1, cosigned: true, claimed: 1 });
  const { visits: listed, missing_specs } = visits.summary();
  assert.equal(listed[0].trajectory, undefined);
  assert.deepEqual(missing_specs.map(({ product_id, field, visits: n, without_order, listed_now }) => ({ product_id, field, n, without_order, listed_now })),
    [{ product_id: "OAW-DOCK-04", field: "max_displays_4k60", n: 1, without_order: 1, listed_now: null }]);
});

test("a missing spec the store has filled in since is marked as listed now", async () => {
  const visits = book();
  visits.accept(await servedRun(visits, "run-1"), "1.1.1.1", HOST);
  const products = structuredClone(SAMPLE);
  assert.equal(visits.summary(products).missing_specs[0].listed_now, false);
  products.find((p) => p.id === "OAW-DOCK-04").specs.max_displays_4k60 = 2;
  assert.equal(visits.summary(products).missing_specs[0].listed_now, true);
});

test("a run with an answer the store never gave is kept but not cosigned or counted", async () => {
  const visits = book();
  const run = await servedRun(visits, "run-1");
  const answer = run.events.find((event) => event.type === "tool_result");
  answer.text = answer.text.replace("unknown", "compatible");
  const visit = visits.accept(run, "1.1.1.1", HOST);
  assert.deepEqual({ matched: visit.cosign.matched, cosigned: visit.cosign.cosigned }, { matched: 0, cosigned: false });
  assert.deepEqual(visits.summary().missing_specs, []);
  assert.deepEqual({ listed: visits.summary().visits.length, uncounted: visits.summary().uncounted }, { listed: 0, uncounted: 1 });
  assert.equal(visits.find(visit.visit_id).run_id, "run-1");
});

test("each served answer backs only one shared run", async () => {
  const visits = book();
  const run = await servedRun(visits, "run-1");
  assert.equal(visits.accept(run, "1.1.1.1", HOST).cosign.cosigned, true);
  assert.equal(visits.accept({ ...run, run_id: "run-copy" }, "1.1.1.1", HOST).cosign.cosigned, false);
  // Served again, the same answer can back one more run.
  assert.equal(visits.accept(await servedRun(visits, "run-2"), "1.1.1.1", HOST).cosign.cosigned, true);
});

test("malformed, repeated and too frequent shares are refused", async () => {
  const visits = book({ perHour: 2 });
  const statusOf = (fn) => { try { fn(); return null; } catch (error) { assert.ok(error instanceof RejectedVisit); return error.status; } };
  assert.equal(statusOf(() => visits.accept({ format: "other", events: [] }, "1.1.1.1", HOST)), 400);
  const run = await servedRun(visits, "run-1");
  visits.accept(run, "1.1.1.1", HOST);
  assert.equal(statusOf(() => visits.accept(run, "2.2.2.2", HOST)), 409);
  visits.accept(await servedRun(visits, "run-2"), "1.1.1.1", HOST);
  assert.equal(statusOf(() => visits.accept({ ...run, run_id: "run-3" }, "1.1.1.1", HOST)), 429);
});

test("a data folder keeps visits and claims across a restart", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "visits-"));
  const first = book({ dataDir });
  const run = await servedRun(first, "run-1");
  const visit = first.accept(run, "1.1.1.1", HOST);
  const second = book({ dataDir });
  assert.equal(second.find(visit.visit_id).run_id, "run-1");
  assert.equal(second.summary().missing_specs[0].visits, 1);
  assert.equal(second.accept({ ...run, run_id: "run-copy" }, "1.1.1.1", HOST).cosign.cosigned, false);
});

test("a run the judge cannot read is refused, and only a web origin is kept as its sender", async () => {
  const visits = book();
  const broken = await servedRun(visits, "run-1");
  broken.events.find((event) => event.type === "tool_result").text = JSON.stringify({ product_id: "OAW-DOCK-04", title: "Demo Dock Duo", result: "unknown", missing_fields: "max_displays_4k60" });
  assert.throws(() => visits.accept(broken, "1.1.1.1", HOST), (error) => error instanceof RejectedVisit && error.status === 400);
  const odd = await servedRun(visits, "run-2");
  odd.page_origin = "javascript:alert(1)";
  assert.equal(visits.accept(odd, "1.1.1.1", HOST).page_origin, null);
});

test("shares from all addresses together are capped per hour", async () => {
  const visits = book({ totalPerHour: 2 });
  visits.accept(await servedRun(visits, "run-1"), "1.1.1.1", HOST);
  visits.accept(await servedRun(visits, "run-2"), "2.2.2.2", HOST);
  assert.throws(() => visits.accept({ format: "agentcosign-tool-trajectory/1", run_id: "run-3", events: [] }, "3.3.3.3", HOST),
    (error) => error.status === 429);
});

test("the visits file is rewritten to the kept visits when it grows past twice the limit", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "visits-"));
  const visits = book({ dataDir, keep: 2 });
  for (const id of ["run-1", "run-2", "run-3", "run-4", "run-5"]) visits.accept(await servedRun(visits, id), id, HOST);
  const lines = readFileSync(path.join(dataDir, "visits.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line).run_id);
  assert.deepEqual(lines, ["run-4", "run-5"]);
  assert.deepEqual(book({ dataDir, keep: 2 }).summary().visits.map((v) => v.run_id), ["run-5", "run-4"]);
});

test("over the limit, runs that are not counted are dropped before counted ones", async () => {
  const visits = book({ keep: 2 });
  visits.accept(await servedRun(visits, "real"), "1.1.1.1", HOST);
  for (const id of ["junk-1", "junk-2"]) visits.accept({ format: "agentcosign-tool-trajectory/1", run_id: id, events: [] }, id, HOST);
  assert.deepEqual(visits.visits.map((v) => v.run_id), ["real", "junk-2"]);
});

test("only this store's calls are kept, without the model trace", async () => {
  const visits = book();
  const run = await servedRun(visits, "run-1");
  run.runtime_trace = [{ prompt: "secret prompt" }];
  run.events.splice(4, 0,
    { seq: 2.5, type: "tool_call", call_id: "other", url: "https://other.example/mcp", origin: "https://other.example", tool: "check_compatibility", arguments: {} });
  run.events.forEach((event, index) => { event.seq = index; });
  run.events.splice(5, 0, { seq: 3.5, type: "tool_result", call_id: "other", tool: "check_compatibility", is_error: false, text: "{}" });
  run.events.forEach((event, index) => { event.seq = index; });
  const visit = visits.accept(run, "1.1.1.1", HOST);
  assert.equal(visit.trajectory.runtime_trace, undefined);
  assert.equal(visit.trajectory.events.filter((event) => event.type === "consent").length, 1);
  assert.ok(visit.trajectory.events.every((event) => event.call_id !== "other"));
  assert.deepEqual({ matched: visit.cosign.matched, total: visit.cosign.total, cosigned: visit.cosign.cosigned }, { matched: 1, total: 1, cosigned: true });
});

test("a result's own tool name cannot hide an answer from the check", async () => {
  const visits = book();
  const run = await servedRun(visits, "run-1");
  const order = { order_id: "FAKE", quote_id: "Q-9", product_id: "OAW-DOCK-04", title: "Demo Dock Duo", quantity: 1, total_cents: 12900 };
  const at = run.events.length - 1;
  run.events.splice(at, 0,
    { seq: 0, type: "tool_call", call_id: "x", url: `https://${HOST}/mcp`, origin: `https://${HOST}`, tool: "confirm_demo_order", arguments: { quote_id: "Q-9" } },
    { seq: 0, type: "tool_result", call_id: "x", tool: "zzz", is_error: false, text: JSON.stringify(order) });
  run.events.forEach((event, index) => { event.seq = index; });
  const visit = visits.accept(run, "1.1.1.1", HOST);
  assert.deepEqual({ matched: visit.cosign.matched, total: visit.cosign.total, cosigned: visit.cosign.cosigned }, { matched: 1, total: 2, cosigned: false });
});

test("an answer served for other arguments does not back a call", async () => {
  const visits = book();
  const run = await servedRun(visits, "run-1");
  const call = run.events.find((event) => event.type === "tool_call");
  call.arguments = { ...call.arguments, displays_at_4k60: 3 };
  assert.equal(visits.accept(run, "1.1.1.1", HOST).cosign.cosigned, false);
});

test("calls that share an id, or a result with no call, are refused", async () => {
  const visits = book();
  const twice = await servedRun(visits, "run-1");
  twice.events.splice(4, 0, { ...twice.events.find((event) => event.type === "tool_call") });
  twice.events.forEach((event, index) => { event.seq = index; });
  assert.throws(() => visits.accept(twice, "1.1.1.1", HOST), (error) => error.status === 400);
  const orphan = await servedRun(visits, "run-2");
  orphan.events.find((event) => event.type === "tool_result").call_id = "nobody";
  assert.throws(() => visits.accept(orphan, "1.1.1.1", HOST), (error) => error.status === 400);
});

test("a call that never reached the store does not count against the run", async () => {
  const visits = book();
  const run = await servedRun(visits, "run-1");
  const at = run.events.length - 1;
  run.events.splice(at, 0,
    { seq: 0, type: "tool_call", call_id: "lost", url: `https://${HOST}/mcp`, origin: `https://${HOST}`, tool: "search_products", arguments: {} },
    { seq: 0, type: "tool_result", call_id: "lost", tool: "search_products", is_error: true, transport_error: "Failed to fetch", text: "" });
  run.events.forEach((event, index) => { event.seq = index; });
  const visit = visits.accept(run, "1.1.1.1", HOST);
  assert.deepEqual({ total: visit.cosign.total, cosigned: visit.cosign.cosigned }, { total: 1, cosigned: true });
});

test("a damaged line in a data file is skipped at start", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "visits-"));
  const first = book({ dataDir });
  first.accept(await servedRun(first, "run-1"), "1.1.1.1", HOST);
  appendFileSync(path.join(dataDir, "visits.jsonl"), '{"visit_id": "cut sh');
  appendFileSync(path.join(dataDir, "served.jsonl"), '{"hash": "ab');
  assert.equal(book({ dataDir }).summary().visits.length, 1);
});
