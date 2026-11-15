// A site-funded model relay: an OpenAI-compatible chat-completions endpoint that forwards to
// one upstream provider with the site's key, so a visitor can use the assistant without a key
// of their own. The key stays on the server.
//
// It is an open endpoint on a public site, so it limits what a caller can spend: one fixed
// model, a cap on output tokens and request size, a per-address rate and a daily total.

const MAX_BODY_BYTES = 400_000;
const MAX_OUTPUT_TOKENS = 2_000;
const PER_ADDRESS_PER_MINUTE = 40;

/**
 * Forwards chat completions to one upstream, within spending limits.
 */
export class ModelRelay {
  /**
   * :param config: upstream (base URL), key, model, and dailyLimit (requests per UTC day).
   * :param fetchImpl: The fetch to use, replaced in tests.
   * :param now: Returns the current time in milliseconds, replaced in tests.
   */
  constructor({ upstream, key, model, dailyLimit = 3000 }, fetchImpl = fetch, now = Date.now) {
    this.upstream = String(upstream || "").replace(/\/$/, "");
    this.key = key || "";
    this.model = model;
    this.dailyLimit = dailyLimit;
    this.fetch = fetchImpl;
    this.now = now;
    this.day = "";
    this.today = 0;
    this.recent = new Map(); // address -> request times within the last minute
  }

  /**
   * :return: True when the relay has a key and can fund visitors.
   */
  get funded() {
    return Boolean(this.key && this.upstream && this.model);
  }

  // Count one request against the per-address rate and the daily total.
  admit(address) {
    const time = this.now();
    const day = new Date(time).toISOString().slice(0, 10);
    if (day !== this.day) {
      this.day = day;
      this.today = 0;
      this.recent.clear();
    }
    if (this.today >= this.dailyLimit) return "This demo has used today's model budget. Add your own key in AI model settings, or try again tomorrow.";
    const times = (this.recent.get(address) || []).filter((t) => time - t < 60_000);
    if (times.length >= PER_ADDRESS_PER_MINUTE) return "Too many requests from this address. Wait a minute and try again.";
    times.push(time);
    this.recent.set(address, times);
    this.today += 1;
    return null;
  }

  /**
   * Answer one POST to the relay.
   *
   * :param bodyText: The request body as sent by the page.
   * :param address: The caller's network address, for the rate limit.
   * :return: status, headers and either a `body` string or an upstream `stream` to pipe.
   */
  async handle(bodyText, address) {
    const refuse = (status, message) => ({
      status, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: { message } }),
    });
    if (!this.funded) return refuse(503, "This site has no model budget configured. Add your own key in AI model settings.");
    if (bodyText.length > MAX_BODY_BYTES) return refuse(413, "The request is too large for this demo.");
    let request;
    try { request = JSON.parse(bodyText); } catch { return refuse(400, "The request body is not JSON."); }
    if (!Array.isArray(request.messages)) return refuse(400, "The request has no messages.");
    const limited = this.admit(address);
    if (limited) return refuse(429, limited);

    // The site pays for one model only, whatever the page asks for.
    const body = { ...request, model: this.model, max_tokens: Math.min(request.max_tokens || MAX_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS) };
    let reply;
    try {
      reply = await this.fetch(`${this.upstream}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.key}` },
        body: JSON.stringify(body),
      });
    } catch {
      return refuse(502, "The model provider could not be reached.");
    }
    if (!reply.ok) {
      // Pass on the status, not the provider's text, which can name the account.
      return refuse(reply.status === 429 ? 429 : 502, `The model provider answered with HTTP ${reply.status}.`);
    }
    return { status: 200, headers: { "Content-Type": reply.headers.get("content-type") || "application/json" }, stream: reply.body };
  }
}
