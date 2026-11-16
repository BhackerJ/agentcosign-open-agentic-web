// The store's side of a shared run. A visitor on another site can send the store the record
// of what their agent did here; the store judges it again and cosigns it: each answer the run
// says the store gave must be one the store actually served, and each served answer backs at
// most one shared run.
//
// Served answers and accepted visits are appended to two JSONL files in a data folder, so a
// restart keeps both. Without a folder they live in memory only.

import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { judge } from "../buyer/agentcosign/judge.js";

const FORMAT = "agentcosign-tool-trajectory/1";

// Prefix the browser runtime puts on a tool's own error text (runtime/mcp.js callTool).
const TOOL_ERROR_PREFIX = "MCP tool error: ";

/**
 * The text a browser runtime hands its agent for one MCP tools/call result, which is also
 * the text a recorder keeps.
 *
 * :param result: The tools/call result the store sent.
 * :return: The parts' text joined by newlines, with the error prefix when isError is set.
 */
export function agentText(result) {
  const text = (result?.content || []).map((part) => (part.type === "text" ? part.text : JSON.stringify(part))).join("\n");
  return result?.isError ? `${TOOL_ERROR_PREFIX}${text}` : text;
}

export function hashText(text) {
  return createHash("sha256").update(text).digest("hex");
}

function readLines(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

/**
 * Raised when a shared run cannot be accepted; the message is safe to show the visitor.
 */
export class RejectedVisit extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export class VisitBook {
  /**
   * :param options: dataDir (optional folder for the two files), toolNames (the store's own
   *     tools; only their results are cosigned), keep (most visits kept), perHour (shares
   *     accepted from one address per hour), now (clock, for tests).
   */
  constructor({ dataDir = "", toolNames, keep = 500, perHour = 20, now = () => Date.now() }) {
    this.toolNames = new Set(toolNames);
    this.keep = keep;
    this.perHour = perHour;
    this.now = now;
    this.served = new Map(); // answer hash -> times served
    this.claimed = new Map(); // answer hash -> times claimed by an accepted visit
    this.visits = [];
    this.recent = new Map(); // address -> share times in the last hour
    this.files = null;
    if (dataDir) {
      mkdirSync(dataDir, { recursive: true });
      this.files = { served: path.join(dataDir, "served.jsonl"), visits: path.join(dataDir, "visits.jsonl") };
      for (const { hash } of readLines(this.files.served)) this.served.set(hash, (this.served.get(hash) || 0) + 1);
      for (const visit of readLines(this.files.visits)) this.remember(visit);
    }
  }

  /**
   * Note one answer the store's MCP server sent.
   */
  recordServed(result) {
    const hash = hashText(agentText(result));
    this.served.set(hash, (this.served.get(hash) || 0) + 1);
    if (this.files) appendFileSync(this.files.served, JSON.stringify({ hash, at: new Date(this.now()).toISOString() }) + "\n");
  }

  remember(visit) {
    for (const hash of visit.cosign.claimed) this.claimed.set(hash, (this.claimed.get(hash) || 0) + 1);
    this.visits = this.visits.filter((v) => v.run_id !== visit.run_id);
    this.visits.push(visit);
    if (this.visits.length > this.keep) this.visits.splice(0, this.visits.length - this.keep);
  }

  /**
   * Accept a shared run.
   *
   * :param trajectory: The run as the visitor's recorder exported it.
   * :param address: The sender's address, for the rate limit.
   * :return: The stored visit.
   * :raises RejectedVisit: The run is malformed, already shared, or the address is over its limit.
   */
  accept(trajectory, address) {
    if (trajectory?.format !== FORMAT || !Array.isArray(trajectory.events) || typeof trajectory.run_id !== "string") {
      throw new RejectedVisit(400, `This is not a run in the ${FORMAT} format.`);
    }
    if (this.visits.some((v) => v.run_id === trajectory.run_id)) throw new RejectedVisit(409, "This run was already shared with the store.");
    const hour = this.now() - 3_600_000;
    const times = (this.recent.get(address) || []).filter((t) => t > hour);
    if (times.length >= this.perHour) throw new RejectedVisit(429, "Too many runs shared from this address. Try again later.");
    this.recent.set(address, [...times, this.now()]);

    const results = trajectory.events.filter((e) => e.type === "tool_result" && this.toolNames.has(e.tool) && typeof e.text === "string");
    const claimed = [];
    const pending = new Map();
    let matched = 0;
    for (const result of results) {
      const hash = hashText(result.text);
      const used = (this.claimed.get(hash) || 0) + (pending.get(hash) || 0);
      if (used < (this.served.get(hash) || 0)) {
        matched += 1;
        claimed.push(hash);
        pending.set(hash, (pending.get(hash) || 0) + 1);
      }
    }
    // Only a run whose every store answer was served here, and not claimed before, counts.
    const cosigned = results.length > 0 && matched === results.length;
    const verdict = judge(trajectory);
    const visit = {
      visit_id: randomUUID(),
      run_id: trajectory.run_id,
      received_at: new Date(this.now()).toISOString(),
      page_origin: typeof trajectory.page_origin === "string" ? trajectory.page_origin : null,
      model: typeof trajectory.model?.model === "string" ? trajectory.model.model : null,
      outcome: verdict.outcome,
      summary: verdict.summary,
      verdict: verdict.verdict,
      stop: verdict.stop,
      unknown: unknownChecks(trajectory),
      cosign: { matched, total: results.length, cosigned, claimed: cosigned ? claimed : [] },
      trajectory,
    };
    this.remember(visit);
    if (this.files) appendFileSync(this.files.visits, JSON.stringify(visit) + "\n");
    return visit;
  }

  /**
   * :param products: The catalog now, if the caller has it, to say which missing specs the
   *     store has filled in since.
   * :return: The newest visits first, without their trajectories, and for each product spec
   *     the store left empty, how many cosigned visits found it missing, how many of those
   *     ended without an order, and whether it is listed now (null when unknown).
   */
  summary(products = null) {
    const visits = [...this.visits].reverse().map(({ trajectory, cosign, ...rest }) => ({
      ...rest, cosign: { matched: cosign.matched, total: cosign.total, cosigned: cosign.cosigned },
    }));
    const gaps = new Map();
    for (const visit of this.visits.filter((v) => v.cosign.cosigned)) {
      for (const { product_id, title, field } of visit.unknown) {
        const key = `${product_id}\u0000${field}`;
        const gap = gaps.get(key) || { product_id, title, field, visits: 0, without_order: 0, last_seen: null };
        gap.visits += 1;
        if (visit.outcome !== "ordered") gap.without_order += 1;
        gap.last_seen = visit.received_at;
        gaps.set(key, gap);
      }
    }
    for (const gap of gaps.values()) {
      const product = products?.find((p) => p.id === gap.product_id);
      gap.listed_now = product ? product.specs?.[gap.field] != null : null;
    }
    return { visits, missing_specs: [...gaps.values()].sort((a, b) => b.visits - a.visits) };
  }

  find(visitId) {
    return this.visits.find((v) => v.visit_id === visitId) || null;
  }
}

// Each product and spec the store answered "unknown" for in this run, once per run.
function unknownChecks(trajectory) {
  const seen = new Map();
  for (const event of trajectory.events) {
    if (event.type !== "tool_result" || event.tool !== "check_compatibility" || event.is_error) continue;
    let data;
    try { data = JSON.parse(event.text); } catch { continue; }
    if (data?.result !== "unknown" || !Array.isArray(data.missing_fields)) continue;
    for (const field of data.missing_fields) {
      seen.set(`${data.product_id}\u0000${field}`, { product_id: String(data.product_id), title: String(data.title), field: String(field) });
    }
  }
  return [...seen.values()];
}
