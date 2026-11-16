// The store's side of a shared run. A visitor on another site can send the store the record
// of what their agent did here; the store keeps a checked copy, judges it again and cosigns it:
// each answer the run says the store gave, for that tool and those arguments, must be one the
// store actually served, and each served answer backs at most one shared run. Anyone can call
// the store's tools, so a cosigned run shows that the store gave these answers, not that this
// visitor's agent received them.
//
// Served answers and accepted visits are appended to two JSONL files in a data folder, so a
// restart keeps both. Without a folder they live in memory only. Anyone can post, so the book
// keeps a bounded number of visits, rewrites the visits file when it holds too many, and caps
// shares per address and in total per hour.

import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { judge } from "../buyer/agentcosign/judge.js";

const FORMAT = "agentcosign-tool-trajectory/1";

// Prefix the browser runtime puts on a tool's own error text (runtime/mcp.js callTool).
const TOOL_ERROR_PREFIX = "MCP tool error: ";

// Longest text kept for any one field of a shared run.
const FIELD_LIMIT = 100_000;

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

// JSON with object keys sorted, so the same arguments hash the same on both sides.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * The key of one answer: the tool, its arguments and the text the agent got.
 */
export function answerHash(tool, args, text) {
  return createHash("sha256").update(canonical([tool, args ?? {}, text])).digest("hex");
}

function readLines(file) {
  if (!existsSync(file)) return [];
  const records = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    // A line cut short by a crash costs that one record, never the store's start.
    try { records.push(JSON.parse(line)); } catch { console.error(`skipped a damaged line in ${file}`); }
  }
  return records;
}

function append(file, record) {
  try {
    appendFileSync(file, JSON.stringify(record) + "\n");
  } catch (error) {
    console.error(`could not write ${file}: ${error.message}`);
  }
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

const text = (value) => (typeof value === "string" ? value.slice(0, FIELD_LIMIT) : "");

// The host in a URL, or the value itself when it is a bare host, as the runtime records a
// consent's peer.
function hostOf(value) {
  const raw = String(value ?? "");
  if (!raw.includes("://")) return raw || null;
  try { return new URL(raw).host; } catch { return null; }
}

// The http(s) origin a run says it came from, or null.
function webOrigin(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * The part of a shared run this store keeps and shows: the visitor's and the agent's words,
 * and the consent, discovery, calls and answers that involved this store's host, each with
 * only the fields the judge and the replay read. The runtime's model trace and anything about
 * other sites are dropped.
 *
 * :param trajectory: The run as posted.
 * :param host: This store's host as the visitor's browser addressed it.
 * :return: The kept run, and the store's calls paired with their results.
 * :raises RejectedVisit: The run's events cannot be read in order or its calls do not pair up.
 */
export function storeCopy(trajectory, host) {
  const events = [];
  const calls = new Map();
  let lastSeq = -1;
  for (const event of trajectory.events) {
    if (!event || typeof event !== "object" || !Number.isInteger(event.seq) || event.seq <= lastSeq) {
      throw new RejectedVisit(400, "The run's events are not in order.");
    }
    lastSeq = event.seq;
    const base = { seq: event.seq, at: text(event.at), type: event.type };
    if (event.type === "user_message" || event.type === "agent_text") events.push({ ...base, text: text(event.text) });
    else if (event.type === "turn_error") events.push({ ...base, message: text(event.message) });
    else if (event.type === "consent" && hostOf(event.peer_origin) === host) {
      events.push({ ...base, kind: text(event.kind), phase: text(event.phase), peer_label: text(event.peer_label),
        peer_origin: text(event.peer_origin), request_text: text(event.request_text), decision: event.decision === "allow" ? "allow" : "decline" });
    } else if (event.type === "capability_discovery" && hostOf(event.url) === host) {
      if (event.source === "mcp" && Array.isArray(event.tools)) {
        const tools = event.tools.filter((tool) => tool && typeof tool === "object").map((tool) => ({
          name: text(tool.name), description: text(tool.description), inputSchema: tool.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema : {},
        }));
        events.push({ ...base, source: "mcp", url: text(event.url), tools });
      } else if (event.source === "published_file") {
        events.push({ ...base, source: "published_file", url: text(event.url), status: Number(event.status) || 0, body: text(event.body) });
      }
    } else if (event.type === "tool_call") {
      if (typeof event.call_id !== "string" || calls.has(event.call_id)) throw new RejectedVisit(400, "Two tool calls in the run share an id.");
      const ours = hostOf(event.origin) === host;
      const args = event.arguments && typeof event.arguments === "object" && !Array.isArray(event.arguments) ? event.arguments : {};
      const call = { ...base, call_id: event.call_id, url: text(event.url), origin: text(event.origin), tool: text(event.tool), arguments: args };
      calls.set(event.call_id, { call, ours, result: null });
      if (ours) events.push(call);
    } else if (event.type === "tool_result") {
      const entry = calls.get(event.call_id);
      if (!entry || entry.result) throw new RejectedVisit(400, "A tool result in the run has no call of its own.");
      // The tool is the call's, never a name the result carries.
      entry.result = { ...base, call_id: event.call_id, tool: entry.call.tool, is_error: event.is_error === true, text: text(event.text),
        ...(event.transport_error ? { transport_error: text(event.transport_error) } : {}) };
      if (entry.ours) events.push(entry.result);
    }
  }
  const task = trajectory.task && typeof trajectory.task === "object" ? Object.fromEntries(Object.entries(trajectory.task)
    .filter(([, value]) => ["string", "number"].includes(typeof value)).map(([key, value]) => [key, typeof value === "string" ? text(value) : value])) : null;
  const kept = {
    format: FORMAT, run_id: text(trajectory.run_id), started_at: text(trajectory.started_at), exported_at: text(trajectory.exported_at),
    page_origin: webOrigin(trajectory.page_origin), network: text(trajectory.network) || null,
    model: { model: text(trajectory.model?.model).slice(0, 200) || null }, task, events,
  };
  return { trajectory: kept, pairs: [...calls.values()].filter((entry) => entry.ours) };
}

export class VisitBook {
  /**
   * :param options: dataDir (optional folder for the two files), toolNames (the store's own
   *     tools; only their answers are cosigned), keep (most visits kept), perHour (shares
   *     accepted from one address per hour), totalPerHour (from all addresses), now (clock,
   *     for tests).
   */
  constructor({ dataDir = "", toolNames, keep = 300, perHour = 20, totalPerHour = 300, now = () => Date.now() }) {
    this.toolNames = new Set(toolNames);
    this.keep = keep;
    this.perHour = perHour;
    this.totalPerHour = totalPerHour;
    this.lastHour = [];
    this.fileLines = 0;
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
      for (const visit of readLines(this.files.visits)) {
        this.remember(visit);
        this.fileLines += 1;
      }
      if (this.fileLines > this.keep) this.rewriteVisits();
    }
  }

  /**
   * Note one answer the store's MCP server sent. A failed write is logged, never passed on to
   * the caller of the tool.
   */
  recordServed(tool, args, result) {
    const hash = answerHash(tool, args, agentText(result));
    this.served.set(hash, (this.served.get(hash) || 0) + 1);
    if (this.files) append(this.files.served, { hash, at: new Date(this.now()).toISOString() });
  }

  rewriteVisits() {
    // Claims of dropped visits stay in memory until restart; after it they are free again,
    // which can only let an old answer back one more run.
    try {
      writeFileSync(this.files.visits, this.visits.map((v) => JSON.stringify(v) + "\n").join(""));
      this.fileLines = this.visits.length;
    } catch (error) {
      console.error(`could not rewrite ${this.files.visits}: ${error.message}`);
    }
  }

  remember(visit) {
    for (const hash of visit.cosign.claimed) this.claimed.set(hash, (this.claimed.get(hash) || 0) + 1);
    this.visits = this.visits.filter((v) => v.run_id !== visit.run_id);
    this.visits.push(visit);
    // Over the limit, drop the oldest run that is not counted, so junk cannot push out real runs.
    while (this.visits.length > this.keep) {
      const uncounted = this.visits.findIndex((v) => !v.cosign.cosigned);
      this.visits.splice(uncounted >= 0 ? uncounted : 0, 1);
    }
  }

  // Count one share from this address; refuse it over either hourly limit.
  admit(address) {
    const hour = this.now() - 3_600_000;
    if (this.recent.size > 10_000) {
      for (const [key, times] of this.recent) if (!times.some((t) => t > hour)) this.recent.delete(key);
    }
    const times = (this.recent.get(address) || []).filter((t) => t > hour);
    this.lastHour = this.lastHour.filter((t) => t > hour);
    if (times.length >= this.perHour || this.lastHour.length >= this.totalPerHour) {
      throw new RejectedVisit(429, "Too many runs shared just now. Try again later.");
    }
    this.recent.set(address, [...times, this.now()]);
    this.lastHour.push(this.now());
  }

  /**
   * Accept a shared run.
   *
   * :param trajectory: The run as the visitor's recorder exported it.
   * :param address: The sender's address, for the rate limit.
   * :param host: This store's host as the visitor's browser addressed it; only calls to it
   *     are kept and cosigned.
   * :return: The stored visit.
   * :raises RejectedVisit: The run is malformed, already shared, or over a rate limit.
   */
  accept(trajectory, address, host) {
    if (trajectory?.format !== FORMAT || !Array.isArray(trajectory.events) || typeof trajectory.run_id !== "string") {
      throw new RejectedVisit(400, `This is not a run in the ${FORMAT} format.`);
    }
    if (this.visits.some((v) => v.run_id === trajectory.run_id)) throw new RejectedVisit(409, "This run was already shared with the store.");
    this.admit(address);
    const { trajectory: kept, pairs } = storeCopy(trajectory, host);
    let verdict;
    try {
      verdict = judge(kept);
    } catch {
      throw new RejectedVisit(400, "The run could not be judged: some of its events are malformed.");
    }

    // The store's answers in this run: each call to one of its tools that got a reply. A call
    // that never reached the store (transport_error) holds no answer of the store's.
    const answers = pairs.filter(({ call, result }) => this.toolNames.has(call.tool) && result && !result.transport_error);
    const claimed = [];
    const pending = new Map();
    for (const { call, result } of answers) {
      const hash = answerHash(call.tool, call.arguments, result.text);
      const used = (this.claimed.get(hash) || 0) + (pending.get(hash) || 0);
      if (used < (this.served.get(hash) || 0)) {
        claimed.push(hash);
        pending.set(hash, (pending.get(hash) || 0) + 1);
      }
    }
    // Only a run whose every store answer was served here, and not claimed before, counts.
    const cosigned = answers.length > 0 && claimed.length === answers.length;
    const visit = {
      visit_id: randomUUID(),
      run_id: kept.run_id,
      received_at: new Date(this.now()).toISOString(),
      page_origin: kept.page_origin,
      model: kept.model.model,
      outcome: verdict.outcome,
      summary: verdict.summary,
      verdict: verdict.verdict,
      stop: verdict.stop,
      unknown: unknownChecks(answers),
      cosign: { matched: claimed.length, total: answers.length, cosigned, claimed: cosigned ? claimed : [] },
      trajectory: kept,
    };
    this.remember(visit);
    if (this.files) {
      append(this.files.visits, visit);
      this.fileLines += 1;
      if (this.fileLines > 2 * this.keep) this.rewriteVisits();
    }
    return visit;
  }

  /**
   * :param products: The catalog now, if the caller has it, to say which missing specs the
   *     store has filled in since.
   * :return: The newest counted visits first, without their trajectories, how many other
   *     visits are kept but not counted, and for each product spec the store left empty, how
   *     many cosigned visits found it missing, how many of those ended without an order, and
   *     whether it is listed now (null when unknown).
   */
  summary(products = null) {
    const visits = [...this.visits].reverse().filter((v) => v.cosign.cosigned).map(({ trajectory, cosign, ...rest }) => ({
      ...rest, cosign: { matched: cosign.matched, total: cosign.total, cosigned: cosign.cosigned },
    }));
    const uncounted = this.visits.length - visits.length;
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
    return { visits, uncounted, missing_specs: [...gaps.values()].sort((a, b) => b.visits - a.visits) };
  }

  find(visitId) {
    return this.visits.find((v) => v.visit_id === visitId) || null;
  }
}

// Each product and spec the store answered "unknown" for in this run, once per run.
function unknownChecks(answers) {
  const seen = new Map();
  for (const { call, result } of answers) {
    if (call.tool !== "check_compatibility" || result.is_error) continue;
    let data;
    try { data = JSON.parse(result.text); } catch { continue; }
    if (data?.result !== "unknown" || !Array.isArray(data.missing_fields)) continue;
    for (const field of data.missing_fields) {
      seen.set(`${data.product_id}\u0000${field}`, { product_id: String(data.product_id), title: String(data.title), field: String(field) });
    }
  }
  return [...seen.values()];
}
