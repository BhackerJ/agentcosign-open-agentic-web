// Records what an agent network did in this page: what the visitor said, what the visitor
// allowed, which capabilities the agent discovered on other sites, every tool call with its
// full arguments and full result, and what the agent answered.
//
// It attaches to a running engine of the nsdeploy browser runtime without editing the
// runtime: it wraps the engine's turn, consent and MCP entry points. The runtime's own trace
// keeps only the start of each result, so the recorder keeps the whole of it.
//
// Usage, after the runtime's boot():
//   const recorder = RunRecorder.attach(booted.engine, { task });
//   recorder.addEventListener("event", () => { ... });   // after each recorded event
//   const trajectory = recorder.export();

// Names under which the runtime or a site may carry a credential, such as the per-server
// headers a network passes to an MCP server in sly_data.http_headers.
const CREDENTIAL_NAME = /^(authorization|cookie|set-cookie|http_headers|sly_data)$|api[-_]?key|access[-_]?token|secret|password/i;

/**
 * Copy a value for export, replacing anything stored under a credential-like name.
 *
 * :param value: Any JSON value from the runtime's trace.
 * :return: A copy with each such value replaced by "[withheld]". An empty object or string
 *     stays as it is, since it holds nothing.
 */
export function withoutCredentials(value) {
  if (Array.isArray(value)) return value.map(withoutCredentials);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([name, inner]) => {
    const empty = inner === "" || inner === null || (typeof inner === "object" && !Object.keys(inner).length);
    return [name, CREDENTIAL_NAME.test(name) && !empty ? "[withheld]" : withoutCredentials(inner)];
  }));
}

/**
 * Collects one page visit's events into a trajectory document.
 */
export class RunRecorder extends EventTarget {
  /**
   * The trajectory format this recorder writes. judge.js and the replay page read it.
   */
  static FORMAT = "agentcosign-tool-trajectory/1";

  /**
   * Files of another site's published agent network, kept as the agent's browser read them.
   */
  static PUBLISHED_FILE = /\/(agent-manifest\.json|links\.json|[^/]+\.network\.json)$/;

  /**
   * :param engine: The runtime engine boot() returned.
   * :param options: An optional `task`: the structured need behind the visitor's request,
   *     such as a budget, for the judge to check the outcome against.
   */
  constructor(engine, { task = null } = {}) {
    super();
    this.engine = engine;
    this.task = task;
    this.runId = crypto.randomUUID();
    this.startedAt = new Date().toISOString();
    this.events = [];
    this.calls = 0;
  }

  /**
   * Create a recorder and wrap the engine's entry points.
   *
   * :return: The attached recorder.
   */
  static attach(engine, options) {
    const recorder = new RunRecorder(engine, options);
    recorder.wrapTurns();
    recorder.wrapConsent();
    recorder.wrapMcp();
    recorder.wrapFetch();
    return recorder;
  }

  add(type, fields) {
    const event = { seq: this.events.length, at: new Date().toISOString(), type, ...fields };
    this.events.push(event);
    this.dispatchEvent(new Event("event"));
    return event;
  }

  wrapTurns() {
    const engine = this.engine;
    const runTurn = engine.runTurn.bind(engine);
    engine.runTurn = async (userText, options) => {
      this.add("user_message", { text: String(userText) });
      try {
        const result = await runTurn(userText, options);
        this.add("agent_text", { text: String(result?.text ?? "") });
        return result;
      } catch (error) {
        this.add("turn_error", { message: String(error?.message || error) });
        throw error;
      }
    };
  }

  wrapConsent() {
    const engine = this.engine;
    const requestConsent = engine.requestConsent.bind(engine);
    engine.requestConsent = async (info) => {
      const decision = await requestConsent(info);
      this.add("consent", {
        kind: info.kind || "network",
        phase: info.phase || "call",
        peer_label: info.peerLabel,
        peer_origin: info.peerOrigin,
        request_text: info.requestText || "",
        decision,
      });
      return decision;
    };
  }

  wrapMcp() {
    const engine = this.engine;
    const resolveMcp = engine.resolveMcp.bind(engine);
    const wrapped = new WeakSet();
    engine.resolveMcp = async (...args) => {
      const client = await resolveMcp(...args);
      if (wrapped.has(client)) return client;
      wrapped.add(client);
      const listTools = client.listTools.bind(client);
      const callTool = client.callTool.bind(client);
      client.listTools = async (parentSpan) => {
        const tools = await listTools(parentSpan);
        this.add("capability_discovery", { source: "mcp", url: client.url, tools });
        return tools;
      };
      client.callTool = async (name, toolArguments, parentSpan) => {
        const callId = `call-${++this.calls}`;
        this.add("tool_call", {
          call_id: callId, url: client.url, origin: new URL(client.url).origin,
          tool: name, arguments: toolArguments ?? {}, trace_span: parentSpan ?? null,
        });
        try {
          const text = await callTool(name, toolArguments, parentSpan);
          // The runtime's MCP client marks a tool's own refusal with this prefix.
          this.add("tool_result", { call_id: callId, tool: name, is_error: text.startsWith("MCP tool error: "), text });
          return text;
        } catch (error) {
          this.add("tool_result", { call_id: callId, tool: name, is_error: true, transport_error: String(error?.message || error), text: "" });
          throw error;
        }
      };
      return client;
    };
  }

  // The runtime reads another site's network with the page's fetch. Keep a copy of each
  // published file from another origin, so the record holds what the agent was given.
  wrapFetch() {
    const pageFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const response = await pageFetch(input, init);
      try {
        const url = new URL(typeof input === "string" ? input : input.url, location.href);
        const method = (init?.method || (typeof input === "object" && input.method) || "GET").toUpperCase();
        if (method === "GET" && url.origin !== location.origin && RunRecorder.PUBLISHED_FILE.test(url.pathname)) {
          const body = await response.clone().text();
          this.add("capability_discovery", { source: "published_file", url: url.href, status: response.status, body });
        }
      } catch {
        // Recording must never break the page's own request.
      }
      return response;
    };
  }

  /**
   * :return: True while a visitor message has no answer or error yet.
   */
  get running() {
    const count = (type) => this.events.filter((event) => event.type === type).length;
    return count("user_message") > count("agent_text") + count("turn_error");
  }

  /**
   * :return: The trajectory document for this visit so far.
   */
  export() {
    const engine = this.engine;
    const routerHost = (() => {
      try { return new URL(engine.userRouter?.baseUrl).host; } catch { return engine.userRouter?.baseUrl || null; }
    })();
    return {
      format: RunRecorder.FORMAT,
      run_id: this.runId,
      started_at: this.startedAt,
      exported_at: new Date().toISOString(),
      page_origin: location.origin,
      network: engine.top?.network?.name || null,
      model: { router_host: routerHost, model: engine.modelOverride || engine.top?.network?.config?.llm_config?.model_name || null },
      task: this.task,
      events: this.events,
      // The runtime's own trace, without stream chunks: model calls, agent spans and timings.
      runtime_trace: withoutCredentials(engine.trace.export().events.filter((event) => event.phase !== "update")),
    };
  }
}
