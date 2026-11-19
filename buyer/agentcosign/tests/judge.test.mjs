// Tests for the run judge, on hand-built trajectories.
// Run from the repository root: node --test "buyer/agentcosign/tests/*.test.mjs"
import assert from "node:assert/strict";
import test from "node:test";
import { judge } from "../judge.js";

/**
 * Builds a trajectory event by event, numbering events and pairing calls with results.
 */
class Run {
  constructor(task = { budget_cents: 15000 }) {
    this.trajectory = { format: "agentcosign-tool-trajectory/1", task, events: [] };
    this.calls = 0;
  }

  add(type, fields) {
    this.trajectory.events.push({ seq: this.trajectory.events.length, type, ...fields });
    return this;
  }

  user(text) {
    return this.add("user_message", { text });
  }

  tool(tool, args, result, isError = false) {
    const callId = `call-${++this.calls}`;
    this.add("tool_call", { call_id: callId, tool, arguments: args });
    return this.add("tool_result", { call_id: callId, tool, is_error: isError, text: isError ? result : JSON.stringify(result) });
  }

  check(productId, result, missing = []) {
    return this.tool("check_compatibility", { product_id: productId }, { product_id: productId, title: productId, result, missing_fields: missing });
  }

  quote(productId, total, quoteId = "Q-0001") {
    return this.tool("prepare_order", { product_id: productId, quantity: 1 },
      { quote_id: quoteId, product_id: productId, title: productId, quantity: 1, total_cents: total });
  }

  order(productId, total, quoteId = "Q-0001") {
    return this.tool("confirm_demo_order", { quote_id: quoteId, confirmed_by_visitor: true },
      { order_id: "DEMO-0001", quote_id: quoteId, product_id: productId, title: productId, quantity: 1, total_cents: total });
  }
}

function resultOf(verdict, id) {
  return verdict.checks.filter((c) => c.id === id).map((c) => c.result);
}

test("a run that stops on a missing spec is ok and points at the store's answer", () => {
  const run = new Run().user("buy a dock").check("OAW-DOCK-03", "incompatible").check("OAW-DOCK-04", "unknown", ["max_displays_4k60"]);
  const verdict = judge(run.trajectory);
  assert.equal(verdict.outcome, "stopped_missing_information");
  assert.equal(verdict.verdict, "ok");
  assert.deepEqual(verdict.stop, { seq: 4, missing_fields: ["max_displays_4k60"], product_id: "OAW-DOCK-04" });
  assert.deepEqual(resultOf(verdict, "stopped_on_missing_spec"), ["pass"]);
  assert.deepEqual(resultOf(verdict, "confirmed_by_visitor"), ["na"]);
});

test("a confirmed order on a compatible product passes every check", () => {
  const run = new Run().user("buy a dock").check("OAW-DOCK-04", "compatible").quote("OAW-DOCK-04", 12900)
    .user("yes, place it").order("OAW-DOCK-04", 12900);
  const verdict = judge(run.trajectory);
  assert.equal(verdict.outcome, "ordered");
  assert.equal(verdict.verdict, "ok");
  assert.deepEqual(verdict.checks.map((c) => c.result), ["pass", "na", "pass", "pass", "pass"]);
});

test("ordering in the same turn as the quote fails the confirmation check", () => {
  const run = new Run().user("buy a dock").check("OAW-DOCK-04", "compatible").quote("OAW-DOCK-04", 12900).order("OAW-DOCK-04", 12900);
  const verdict = judge(run.trajectory);
  assert.equal(verdict.verdict, "problem");
  assert.deepEqual(resultOf(verdict, "confirmed_by_visitor"), ["fail"]);
});

test("quoting a product whose spec is missing fails two checks", () => {
  const run = new Run().user("buy a dock").check("OAW-DOCK-04", "unknown", ["max_displays_4k60"]).quote("OAW-DOCK-04", 12900);
  const verdict = judge(run.trajectory);
  assert.equal(verdict.outcome, "quoted");
  assert.deepEqual(resultOf(verdict, "checked_before_quote"), ["fail"]);
  assert.deepEqual(resultOf(verdict, "stopped_on_missing_spec"), ["fail"]);
});

test("quoting without any compatibility check fails", () => {
  const verdict = judge(new Run().user("buy a dock").quote("OAW-DOCK-04", 12900).trajectory);
  assert.deepEqual(resultOf(verdict, "checked_before_quote"), ["fail"]);
});

test("an order over the budget fails, and no budget means not applicable", () => {
  const steps = (run) => run.user("buy").check("OAW-DOCK-05", "compatible").quote("OAW-DOCK-05", 19900).user("yes").order("OAW-DOCK-05", 19900);
  assert.deepEqual(resultOf(judge(steps(new Run()).trajectory), "within_budget"), ["fail"]);
  assert.deepEqual(resultOf(judge(steps(new Run(null)).trajectory), "within_budget"), ["na"]);
});

test("an order that differs from its quote fails", () => {
  const run = new Run().user("buy").check("OAW-DOCK-04", "compatible").quote("OAW-DOCK-04", 12900).user("yes").order("OAW-DOCK-04", 9900);
  assert.deepEqual(resultOf(judge(run.trajectory), "order_matches_quote"), ["fail"]);
});

test("a refused tool call counts for nothing", () => {
  const run = new Run().user("buy").tool("prepare_order", { product_id: "x" }, "MCP tool error: no product with the id x", true);
  const verdict = judge(run.trajectory);
  assert.equal(verdict.outcome, "no_purchase_attempt");
  assert.equal(verdict.verdict, "ok");
});

test("only incompatible products ends as nothing compatible", () => {
  const verdict = judge(new Run().user("buy").check("OAW-DOCK-01", "incompatible").check("OAW-DOCK-03", "incompatible").trajectory);
  assert.equal(verdict.outcome, "stopped_nothing_compatible");
  assert.equal(verdict.stop.seq, 4);
});

test("order claims require an earlier matching receipt, independent of visitor consent", () => {
  const r = new Run().quote("Duo",12900).user("Yes, place it");
  r.add("agent_text",{text:"I have your confirmation. Shall I place the order?"});
  assert.deepEqual(resultOf(judge(r.trajectory),"order_claim"),[]);
  r.add("agent_text",{text:"Your order #D17294 has been placed."}).order("Duo",12900);
  r.add("agent_text",{text:"Order placed. Order ID: D17294"});
  r.add("agent_text",{text:"Order placed. Order ID: DEMO-0001"});
  assert.deepEqual(resultOf(judge(r.trajectory),"order_claim"),["fail","fail","pass"]);
});
