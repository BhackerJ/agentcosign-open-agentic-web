# AgentCosign: see what a buying agent did at your store

An entry for the [Open Agentic Web Challenge](https://cognizant-agenticweb.devpost.com/).

When an AI agent shops for someone, the store never sees why the agent walked away. This
project records a buying agent's visit to a store, tool call by tool call, and shows where it
stopped and whether it was right to. It has three parts:

- **A demo store** that publishes an agent network and four tools: search the range, check a
  product against the shopper's laptop and displays, quote an order, and place a simulated
  order. Its products live in a Shopify development store. Every product is fictional.
- **A buyer site** on another origin, whose agent finds the store's network and calls its
  tools in the visitor's browser, after the visitor agrees.
- **A recorder and replay** that any site on the reference runtime can add without changing
  the runtime. It keeps every call's full arguments and full answer, and shows the run below
  the chat as it happens. A judge then checks the run against five rules. The judge is plain
  code, not a model: it reads the store's recorded answers, so the same run always gets the
  same verdict.

The five rules: compatibility was confirmed before a quote; the agent did not buy a product
whose spec the store is missing; the visitor confirmed before the order; the order matches
the quote; the total is within the visitor's budget. A rule that a run never reaches, such as
"order matches the quote" when nothing was ordered, is marked as not needed.

## The demo

The request is the same in both runs: "Buy a dock for my USB-C laptop that runs two 4K 60 Hz
displays, under 150 dollars. Let me review the order before you place it."

| Store state | What the agent did | Verdict |
| --- | --- | --- |
| One dock is missing its "displays at 4K 60 Hz" spec | Checked the docks in budget, got "unknown" for the only one that might fit, placed no order and told the visitor which spec the store lacks | No order, and that was right: the one rule that applied passed |
| The merchant fills in that one spec in Shopify | Checked the same dock as compatible, quoted $129, waited, and placed the simulated order after the visitor confirmed | Ordered: the four rules that applied passed |

Between the two runs, the only change is one product field in the Shopify admin. The recorded
runs are in `buyer/runs/`, for Claude Sonnet 5.5 and DeepSeek V4.1 Flash. Each is a single
run: another run of the same request can go differently.

## Run it

Needs Node 22 or later. No packages to install.

```shell
node tools/build_sites.mjs
```

```shell
node store/server.mjs --catalog store/catalog.sample.json
```

```shell
node buyer/server.mjs
```

Open the buyer site at http://localhost:8802/, add a model key (see "The model" below),
select **Fill in the demo request**, then **Send**, and allow the contact with the store.
The run appears below the chat. The store's own page is at http://127.0.0.1:8801/. The two
sites use two host names on purpose: on one host name the runtime shares its saved-key cookie
across ports.

`store/catalog.sample.json` holds the five docks in the missing-spec state, so the store runs
without Shopify and the first run ends with no order. For the second run, set
`max_displays_4k60` of `OAW-DOCK-04` to `2` in that file and send the request again: the
store reads the file on every call.

Without a key, the four recorded runs open at http://localhost:8802/agentcosign/replay.html.

**The model.** In **AI model settings** on either page, paste a key for any OpenAI-compatible
provider. To let visitors use the assistant without a key, give each server a provider key
and it relays model calls for its own page, with one fixed model, a rate limit per address
and a daily total:

```shell
MODEL_RELAY_KEY=<key> MODEL_RELAY_UPSTREAM=https://api.otari.ai/api/v1 MODEL_RELAY_MODEL=alibaba/qwen3.8-flash node buyer/server.mjs
```

**A Shopify store.** `tools/create_dock_fixtures.py` creates the five products and their spec
fields in a development store, and `tools/set_demo_state.py missing|filled` switches the one
spec. Start the store with the store's domain, client id and client secret in the
environment, under a prefix you name, from a private env file outside this repository:

```shell
node --env-file=<private .env> store/server.mjs --store-prefix STORE1
```

**Another address.** The buyer's network names the store's network URL, so rebuild when the
store moves: `node tools/build_sites.mjs --store-origin https://store.example`.

## Check it

```shell
node --test "store/tests/*.test.mjs" "buyer/agentcosign/tests/*.test.mjs" "server/tests/*.test.mjs"
```

The tests use no network. Two more checks need the sites running:

- `node check/mcp_client_check.mjs http://127.0.0.1:8801/mcp --origin http://localhost:8802`
  calls the store's MCP server as an outside client, including the CORS preflight a browser
  on that origin would send.
- `python check/run_demo.py my-run` (Python with Playwright) sends the demo request on the
  buyer page in headless Chromium with the site-funded model, prints the verdict and saves
  `buyer/runs/my-run.json`.

## How a call crosses sites

1. The buyer's network lists the store's network URL as a tool, and the buyer's manifest
   lists the store's origin as an allowed peer.
2. Before anything is sent, the page shows a consent card with the store's name, its host and
   the request. If the visitor declines, the store receives nothing.
3. After Allow, the buyer's browser reads the store's `agent-manifest.json`, network file and
   `links.json`, and runs the store's network locally, on the buyer's model.
4. The store's network calls the store's own MCP server. The browser sends a CORS preflight,
   so the store's `/mcp` must answer with CORS headers.

The store's tools never decide for the buyer. `check_compatibility` answers "unknown" when a
spec is missing and `prepare_order` would still quote that product: stopping is the agent's
call, and the record shows what it did. The store cannot verify that a person confirmed an
order, so `confirm_demo_order` takes the agent's statement that they did, and the judge
checks it against the conversation.

## What is where

- `store/`: the store's page, its network source, `server.mjs`, the tools (`tools.mjs`) and
  the catalog readers (`catalog.mjs`).
- `buyer/`: the buyer's page and network source, and `buyer/agentcosign/`, the recorder, the
  judge and the replay. Its `README.md` documents the run format.
- `server/`: the HTTP server both sites share and the model relay.
- `vendor/agentify-website/`: the reference runtime and build tools, unchanged, from
  [cognizant-ai-labs/agentic-web](https://github.com/cognizant-ai-labs/agentic-web) at commit
  `63a956cf`.
- `tools/`, `check/`: build, Shopify setup and the checks above.

## Limits

- The judge knows this store's tool names. It is not a general judge for any store.
- Quotes and orders live in the store server's memory and are lost when it restarts.
- A run is recorded in the visitor's browser and stays there unless they save it.

## License

Apache License 2.0. See `LICENSE` and `NOTICE`.
