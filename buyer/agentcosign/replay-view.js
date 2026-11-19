// Renders one recorded run into a page element: the judge's verdict and checks, then every
// step with the exact arguments the agent sent and the full answer it got. The replay page
// and the buyer page's live view both use it. All run content is set as text, never as HTML,
// because a run holds text from other sites.
import { verifyReceipt } from "./receipt.js";
import { judge } from "./judge.js";

export const FORMAT = "agentcosign-tool-trajectory/1";

const OUTCOMES = {
  ordered: "Order placed",
  quoted: "Quoted, no order",
  stopped_missing_information: "Stopped: the store lacked information",
  stopped_nothing_compatible: "Stopped: nothing fits",
  no_purchase_attempt: "No purchase attempt",
};

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function pretty(text) {
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
}

function block(title, text) {
  const wrap = element("div");
  wrap.append(element("h3", "", title), element("pre", "", text));
  return wrap;
}

function folded(summary, text) {
  const details = element("details");
  details.append(element("summary", "", summary), element("pre", "", text));
  return details;
}

function dollars(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * Build the card for one step. A tool call and its result share a card.
 */
function card(event, result, running) {
  const box = element("div", "card");
  const head = (kind, title) => box.append(element("p", "kind", kind), element("p", "title", title));
  if (event.type === "user_message") {
    box.classList.add("visitor");
    head("Visitor", "The visitor wrote");
    box.append(element("p", "text", event.text));
  } else if (event.type === "agent_text") {
    head("Agent", "The agent answered");
    box.append(element("p", "text", event.text));
  } else if (event.type === "turn_error") {
    box.classList.add("error");
    head("Error", "The turn failed");
    box.append(element("p", "text", event.message));
  } else if (event.type === "consent") {
    head("Consent", `The visitor ${event.decision === "decline" ? "declined" : "allowed"} contact with ${event.peer_label}`);
    box.append(element("p", "where", event.peer_origin));
    if (event.request_text) box.append(element("p", "text", event.request_text));
  } else if (event.type === "capability_discovery" && event.source === "mcp") {
    head("Discovery", `The agent listed the store's tools: ${event.tools.map((tool) => tool.name).join(", ")}`);
    box.append(element("p", "where", event.url), folded("Tool definitions as the agent received them", JSON.stringify(event.tools, null, 2)));
  } else if (event.type === "capability_discovery") {
    head("Discovery", `The agent's browser read ${new URL(event.url).pathname.split("/").pop()}`);
    box.append(element("p", "where", `${event.url} · HTTP ${event.status}`), folded("File as read", pretty(event.body)));
  } else if (event.type === "tool_call") {
    const waiting = !result && running;
    const failed = !waiting && (!result || result.is_error);
    if (failed) box.classList.add("error");
    head("Tool call", `${event.tool}${failed ? " · refused or failed" : ""}`);
    box.append(element("p", "where", event.url));
    const received = result ? (result.transport_error || pretty(result.text)) : waiting ? "Waiting for the store…" : "No result was recorded.";
    const pair = element("div", "pair");
    pair.append(block("Sent", JSON.stringify(event.arguments, null, 2)), block("Received", received));
    box.append(pair);
    if (event.tool === "confirm_demo_order" && result && !result.is_error) {
      let order;
      try { order = JSON.parse(result.text); } catch { return box; }
      if (order?.signature) {
        const verify = element("button", "", "Verify store signature");
        const status = element("p", "text");
        status.setAttribute("role", "status");
        verify.onclick = async () => {
          try {
            const { store } = await (await fetch("/demo-links.json")).json();
            const key = await (await fetch(new URL("/.well-known/agentcosign-receipt-key.json", store))).json();
            status.textContent = await verifyReceipt(order, key) === "verified"
              ? `Store signature verified for ${order.order_id}.` : "Invalid signature for the connected store.";
          } catch { status.textContent = "The store verification key could not be loaded."; }
        };
        box.append(verify, status);
      } else if (order?.order_id) box.append(element("p", "where", "Recorded order reply · no signature in this archive."));
    }
  }
  return box;
}

/**
 * A replay view inside one element.
 */
export class ReplayView {
  /**
   * Build the view's empty sections inside `root`.
   *
   * :param root: The element to render into. It gets the class acs-replay.
   */
  constructor(root) {
    this.root = root;
    root.classList.add("acs-replay");
    this.verdict = element("section", "verdict");
    this.badge = element("p", "badge");
    this.title = element("h2");
    this.facts = element("dl", "facts");
    this.verdict.append(this.badge, this.title, this.facts);
    this.checksSection = element("section");
    this.checks = element("ul", "checks");
    this.checksSection.append(element("h2", "", "Checks"), this.checks);
    const stepsSection = element("section");
    this.steps = element("ol", "steps");
    stepsSection.append(element("h2", "", "What happened, step by step"), this.steps);
    root.replaceChildren(this.verdict, this.checksSection, stepsSection);
  }

  /**
   * Render a run.
   *
   * :param trajectory: A trajectory document from recorder.js.
   * :param options: `running` true while a turn is still going: the view then shows the
   *     steps so far and holds back the verdict and the checks, which need the turn's end.
   */
  show(trajectory, { running = false } = {}) {
    const verdict = judge(trajectory);
    const results = new Map(trajectory.events.filter((e) => e.type === "tool_result").map((e) => [e.call_id, e]));
    // A check or the stop may rest on a result; show it on the call's card.
    const cardSeq = new Map();
    for (const event of trajectory.events) {
      if (event.type === "tool_result") {
        const call = trajectory.events.find((e) => e.type === "tool_call" && e.call_id === event.call_id);
        cardSeq.set(event.seq, call ? call.seq : event.seq);
      } else cardSeq.set(event.seq, event.seq);
    }
    const anchor = (seq) => `${this.root.id || "run"}-step-${seq}`;

    if (running) {
      this.badge.className = "badge running";
      this.badge.textContent = "Running";
      this.title.textContent = "The agent is working on the request. The verdict appears when it answers.";
    } else {
      this.badge.className = `badge ${verdict.verdict}`;
      this.badge.textContent = `${OUTCOMES[verdict.outcome]} · ${verdict.verdict === "ok" ? "agent acted correctly" : "agent broke a rule"}`;
      this.title.textContent = verdict.summary;
    }

    this.facts.replaceChildren();
    const fact = (name, value) => { if (value) this.facts.append(element("dt", "", name), element("dd", "", value)); };
    fact("Request", trajectory.task?.request || trajectory.events.find((e) => e.type === "user_message")?.text);
    fact("Budget", trajectory.task?.budget_cents != null ? dollars(trajectory.task.budget_cents) : "");
    fact("Model", trajectory.model?.model);
    fact("Buyer site", trajectory.page_origin);
    fact("Store", [...new Set(trajectory.events.filter((e) => e.type === "tool_call").map((e) => e.origin))].join(", "));
    fact("Started", new Date(trajectory.started_at).toLocaleString());
    fact("Run id", trajectory.run_id);

    this.checksSection.hidden = running;
    this.checks.replaceChildren();
    for (const check of verdict.checks) {
      const item = element("li", check.result);
      const body = element("div");
      body.append(element("div", "", check.label), element("div", "detail", check.detail));
      if (check.seq !== null) {
        const link = element("a", "", "Show this step");
        link.href = `#${anchor(cardSeq.get(check.seq))}`;
        body.append(link);
      }
      item.append(element("span", "mark", check.result === "na" ? "not needed" : check.result), body);
      this.checks.append(item);
    }

    const notes = new Map();
    if (!running) {
      for (const check of verdict.checks) {
        if (check.seq === null || check.result === "na") continue;
        const seq = cardSeq.get(check.seq);
        notes.set(seq, [...(notes.get(seq) || []), check]);
      }
    }
    const stopSeq = !running && verdict.stop ? cardSeq.get(verdict.stop.seq) : null;

    this.steps.replaceChildren();
    let number = 0;
    for (const event of trajectory.events) {
      if (event.type === "tool_result") continue;
      const step = element("li", "step");
      step.id = anchor(event.seq);
      const box = card(event, results.get(event.call_id), running);
      if (event.seq === stopSeq) {
        step.classList.add("stop");
        const missing = verdict.stop.missing_fields.length
          ? `Why no order was placed: the store has no value for ${verdict.stop.missing_fields.join(", ")}, so it could not say this product fits.`
          : "Why no order was placed: this was the last product checked, and none fit.";
        box.append(element("p", "note", missing));
      }
      for (const check of notes.get(event.seq) || []) {
        if (event.seq === stopSeq && check.id === "stopped_on_missing_spec") continue;
        step.classList.add(`flag-${check.result}`);
        box.append(element("p", "note", `${check.result === "pass" ? "✓" : "✕"} ${check.label}`));
      }
      step.append(element("span", "num", String(++number)), box);
      this.steps.append(step);
    }
  }
}
