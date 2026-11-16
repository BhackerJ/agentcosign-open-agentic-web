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

test("it passes on the provider's request id", async () => {
  const reply = new Response("data: {}\n\n", { headers: { "content-type": "text/event-stream", "otari-request-id": "req-1" } });
  const { relay: r } = relay({ reply });
  assert.equal((await r.handle(BODY, "1.1.1.1")).headers["Otari-Request-ID"], "req-1");
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

function healthRelay(replies, clock = { time: Date.parse("2026-11-15T10:00:00Z") }, config = {}) {
  const sent = [];
  const fetchStub = async (url, init) => {
    sent.push(JSON.parse(init.body));
    const next = replies.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  const r = new ModelRelay({ upstream: "https://provider.example/v1", key: "site-key", model: "cheap-model", dailyLimit: 3, ...config }, fetchStub, () => clock.time);
  return { r, sent, clock };
}
const okReply = () => new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { headers: { "content-type": "application/json" } });

test("health asks the provider once, then reuses the answer for half an hour", async () => {
  const { r, sent, clock } = healthRelay([okReply(), okReply()]);
  assert.deepEqual(await r.health(), { ok: true });
  assert.equal(sent[0].model, "cheap-model");
  assert.equal(sent[0].max_tokens, 16);
  clock.time += 29 * 60_000;
  assert.deepEqual(await r.health(), { ok: true });
  assert.equal(sent.length, 1);
  clock.time += 2 * 60_000;
  await r.health();
  assert.equal(sent.length, 2);
});

test("health reports an empty balance or a refused key, and asks again a minute later", async () => {
  const { r, sent, clock } = healthRelay([new Response("{}", { status: 402 }), okReply()]);
  assert.deepEqual(await r.health(), { ok: false, reason: "the model provider answered with HTTP 402" });
  assert.equal((await r.health()).ok, false);
  assert.equal(sent.length, 1);
  clock.time += 61_000;
  assert.deepEqual(await r.health(), { ok: true });
});

test("health reports an unreachable provider", async () => {
  const { r } = healthRelay([new Error("offline")]);
  assert.deepEqual(await r.health(), { ok: false, reason: "the model provider could not be reached" });
});

test("concurrent health checks share one probe", async () => {
  const { r, sent } = healthRelay([okReply(), okReply()]);
  const answers = await Promise.all([r.health(), r.health(), r.health()]);
  assert.ok(answers.every((a) => a.ok));
  assert.equal(sent.length, 1);
});

test("a visitor's failed request counts for health, a malformed one does not", async () => {
  const { r, sent } = healthRelay([new Response("{}", { status: 400 }), okReply(), new Response("{}", { status: 503 })]);
  assert.equal((await r.handle(BODY, "a")).status, 502);
  assert.deepEqual(await r.health(), { ok: true });
  assert.equal(sent.length, 2);
  assert.equal((await r.handle(BODY, "a")).status, 502);
  assert.deepEqual(await r.health(), { ok: false, reason: "the model provider answered with HTTP 503" });
  assert.equal(sent.length, 3);
});

test("health is not ok without a key or once today's budget is used", async () => {
  assert.deepEqual(await healthRelay([], undefined, { key: "" }).r.health(), { ok: false, reason: "no model key configured" });
  const { r } = healthRelay([new Response("data: {}\n\n"), new Response("data: {}\n\n"), new Response("data: {}\n\n")]);
  for (const address of ["a", "b", "c"]) await r.handle(BODY, address);
  assert.deepEqual(await r.health(), { ok: false, reason: "today's model budget is used" });
});
