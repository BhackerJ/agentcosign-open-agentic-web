# AgentCosign recorder and replay

Files that record what an agent network did in a page and show it afterwards. They work
with the nsdeploy browser runtime and do not edit it.

- `recorder.js`: `RunRecorder.attach(engine, { task })` wraps the engine's turn, consent and
  MCP entry points and the page's `fetch`. It records each visitor message, each consent
  decision, each published file read from another site, each MCP tool list, every tool call
  with its full arguments and full result, and each answer. It fires an `event` after each
  one, and `running` is true while a visitor message has no answer yet. `export()` returns the
  trajectory document, with the runtime's own trace beside it.
- `judge.js`: `judge(trajectory)` reads a trajectory and returns the outcome, the step where
  the run stopped, and five checks. It knows the demo store's tools by name:
  `check_compatibility`, `prepare_order` and `confirm_demo_order`.
- `replay-view.js`: `new ReplayView(element).show(trajectory, { running })` renders a run into
  any element: the verdict, the checks and every step. While a turn is running it shows the
  steps so far and holds back the verdict. `replay.css` styles it under the class `acs-replay`.
- `replay.html`, `replay.js`: a static page that shows saved runs with that view. It lists the
  runs in `../runs/index.json` and opens a run file from disk.

The buyer page (`../site.js`) shows the view below the chat and redraws it on each recorder
event, so a visitor sees the run as it happens without saving a file. Its share button sends
the trajectory to each store the run called that announces `/.well-known/agentcosign.json`.

The store imports `judge.js` to judge shared runs itself, and its build copies `judge.js`,
`replay-view.js` and `replay.css` to show them, so these files must not depend on the page.

## The trajectory

A JSON document with `format: "agentcosign-tool-trajectory/1"`, `run_id`, `started_at`,
`page_origin`, `network`, `model`, `task`, `events` and `runtime_trace`. Each event has `seq`,
`at` and a `type`:

| `type` | Fields |
| --- | --- |
| `user_message` | `text` |
| `consent` | `kind`, `phase`, `peer_label`, `peer_origin`, `request_text`, `decision` |
| `capability_discovery` | `source: "published_file"` with `url`, `status`, `body`; or `source: "mcp"` with `url`, `tools` |
| `tool_call` | `call_id`, `url`, `origin`, `tool`, `arguments`, `trace_span` |
| `tool_result` | `call_id`, `tool`, `is_error`, `text`, and `transport_error` when the call never reached the tool |
| `agent_text` | `text` |
| `turn_error` | `message` |

A run file holds what the visitor typed and what other sites returned. The recorder never sees
the model key: the runtime keeps it out of its trace, and the recorder reads no settings.

## Tests

```shell
node --test "buyer/agentcosign/tests/*.test.mjs"
```
