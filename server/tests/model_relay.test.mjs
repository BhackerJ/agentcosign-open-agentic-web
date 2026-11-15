// Tests for the site-funded model relay's limits. No network is used.
// Run from the repository root: node --test "server/tests/*.test.mjs"
import assert from "node:assert/strict";
import test from "node:test";
import { ModelRelay } from "../model_relay.mjs";

const BODY = JSON.stringify({ model: "something-expensive", max_tokens: 90000, messages: [{ role: "user", content: "hi" }] });

function relay(overrides = {}, clock = { time: Date.parse("2026-11-15T10:00:00Z") }) {
  const sent = [];
  const fetchStub = async (url, init) => {
    sent.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return overrides.reply || new Response("data: {}\n\n", { headers: { "content-type": "text/event-stream" } });
  };
  const config = { upstream: "https://provider.example/v1/", key: "site-key", model: "cheap-model", dailyLimit: 3, ...overrides.config };
  return { relay: new ModelRelay(config, fetchStub, () => clock.time), sent, clock };
}

test("it forwards with the site's key, its own model and a capped output", async () => {
  const { relay: r, sent } = relay();
  const reply = await r.handle(BODY, "1.1.1.1");
  assert.equal(reply.status, 200);
  assert.ok(reply.stream);
  assert.equal(sent[0].url, "https://provider.example/v1/chat/completions");
  assert.equal(sent[0].headers.Authorization, "Bearer site-key");
  assert.equal(sent[0].body.model, "cheap-model");
  assert.equal(sent[0].body.max_tokens, 2000);
});

test("without a key it is off and sends nothing", async () => {
  const { relay: r, sent } = relay({ config: { key: "" } });
  assert.equal(r.funded, false);
  assert.equal((await r.handle(BODY, "1.1.1.1")).status, 503);
  assert.equal(sent.length, 0);
});

test("it refuses a body that is not a chat request", async () => {
  const { relay: r, sent } = relay();
  assert.equal((await r.handle("not json", "1.1.1.1")).status, 400);
  assert.equal((await r.handle(JSON.stringify({ prompt: "x" }), "1.1.1.1")).status, 400);
  assert.equal((await r.handle("x".repeat(400_001), "1.1.1.1")).status, 413);
  assert.equal(sent.length, 0);
});

test("the daily total stops further requests until the next day", async () => {
  const { relay: r, sent, clock } = relay();
  for (const address of ["a", "b", "c"]) assert.equal((await r.handle(BODY, address)).status, 200);
  const refused = await r.handle(BODY, "d");
  assert.equal(refused.status, 429);
  assert.match(refused.body, /today's model budget/);
  clock.time += 24 * 3600 * 1000;
  assert.equal((await r.handle(BODY, "d")).status, 200);
  assert.equal(sent.length, 4);
});

test("one address is limited per minute, and others are not", async () => {
  const { relay: r, clock } = relay({ config: { dailyLimit: 1000 } });
  for (let i = 0; i < 40; i += 1) assert.equal((await r.handle(BODY, "busy")).status, 200);
  assert.equal((await r.handle(BODY, "busy")).status, 429);
  assert.equal((await r.handle(BODY, "quiet")).status, 200);
  clock.time += 61_000;
  assert.equal((await r.handle(BODY, "busy")).status, 200);
});

test("a provider error passes on its status and none of its text", async () => {
  const { relay: r } = relay({ reply: new Response("account acct_123 is out of credit", { status: 402 }) });
  const reply = await r.handle(BODY, "1.1.1.1");
  assert.equal(reply.status, 502);
  assert.doesNotMatch(reply.body, /acct_123/);
});
