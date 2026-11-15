// Tests for what the recorder keeps out of an exported run, and for the saved runs.
// Run from the repository root: node --test "buyer/agentcosign/tests/*.test.mjs"
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { withoutCredentials } from "../recorder.js";

test("values under credential-like names are withheld, at any depth", () => {
  const trace = [{
    kind: "remote_call",
    requestPayload: { user_message: { text: "hello" }, sly_data: { http_headers: { "https://x/mcp": { Authorization: "Bearer abc" } } } },
    nested: [{ api_key: "k", "X-Api-Key": "k2", note: "kept" }],
  }];
  assert.deepEqual(withoutCredentials(trace), [{
    kind: "remote_call",
    requestPayload: { user_message: { text: "hello" }, sly_data: "[withheld]" },
    nested: [{ api_key: "[withheld]", "X-Api-Key": "[withheld]", note: "kept" }],
  }]);
});

test("an empty value under such a name stays, and other fields are untouched", () => {
  const event = { kind: "remote_call", requestPayload: { sly_data: {} }, keySource: "local BYOK (not shown)", streamToken: "turn-stream-1", args: { query: "dock" } };
  assert.deepEqual(withoutCredentials(event), event);
});

test("the saved runs hold no key, bearer header or withheld credential", async () => {
  const folder = new URL("../../runs/", import.meta.url);
  const files = (await readdir(folder)).filter((name) => name.endsWith(".json") && name !== "index.json");
  assert.ok(files.length > 0);
  for (const name of files) {
    const text = await readFile(new URL(name, folder), "utf8");
    assert.doesNotMatch(text, /Bearer [A-Za-z0-9]|sk-[A-Za-z0-9-]{12}|otk_[A-Za-z0-9]{8}|shpat_|\[withheld\]/, name);
  }
});
