// Boots the browser runtime in this page's assistant section, records the visit, and shows
// the run below the chat as it happens. The recorder is on window.agentcosignRecorder, so a
// check can read the trajectory.
import { RunRecorder } from "./agentcosign/recorder.js";
import { ReplayView } from "./agentcosign/replay-view.js";

// The structured need behind the page's demo request. The judge checks the outcome against it.
const DEMO_TASK = {
  request: "Buy a dock for my USB-C laptop that runs two 4K 60 Hz displays, under 150 dollars. Let me review the order before you place it.",
  laptop_port: "USB-C (DisplayPort Alt Mode)",
  displays_at_4k60: 2,
  budget_cents: 15000,
};

// When the site funds the model and the visitor has no setup of their own, point the runtime
// at the site's relay. The placeholder stands where a key would: the relay holds the real one.
async function modelOptions() {
  const { loadTabByokSetup } = await import("./runtime/byok.js");
  if (loadTabByokSetup().key) return {};
  const config = await fetch("/site-config.json").then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (!config?.funded) return {};
  return { byokKey: "site-funded", router: new URL(config.model_relay, location.origin).href, model: config.model };
}

// Every other origin whose tools this run called.
function storeOrigins(trajectory) {
  return [...new Set(trajectory.events.filter((e) => e.type === "tool_call" && e.origin && e.origin !== location.origin).map((e) => e.origin))];
}

// Send the run to one store, if it says where it accepts shared runs, and describe the answer.
async function shareWith(origin, trajectory) {
  const line = document.createElement("span");
  const host = new URL(origin).host;
  try {
    const info = await fetch(new URL("/.well-known/agentcosign.json", origin)).then((r) => (r.ok ? r.json() : null));
    if (!info?.share_url) {
      line.textContent = `${host} does not accept shared runs. `;
      return line;
    }
    const response = await fetch(new URL(info.share_url, origin), {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(trajectory),
    });
    const reply = await response.json().catch(() => ({}));
    if (!response.ok) {
      line.textContent = `${host}: ${reply.error || `HTTP ${response.status}`} `;
      return line;
    }
    const { matched, total, cosigned } = reply.cosign;
    line.textContent = cosigned
      ? `Shared with ${host}. The store found all ${total} of its tool answers in this run in its own records. `
      : `Shared with ${host}, but the store did not give ${total - matched} of the ${total} tool answers in this run, so it will not count it. `;
    if (reply.visits_page) {
      const link = document.createElement("a");
      link.href = new URL(reply.visits_page, origin).href;
      link.textContent = "See it on the store's page";
      line.append(link);
    }
  } catch {
    line.textContent = `Could not reach ${host}. `;
  }
  return line;
}

const status = document.querySelector("#assistant-status");
const siteBase = new URL("./", import.meta.url).href;
try {
  const { boot } = await import("./runtime/index.js");
  const booted = await boot("#agent-app", {
    originUrl: siteBase,
    sandboxWorkerUrl: new URL("runtime/sandbox-worker.js", siteBase).href,
    ...(await modelOptions()),
  });
  const recorder = RunRecorder.attach(booted.engine, { task: DEMO_TASK });
  window.agentcosignRecorder = recorder;
  const needsKey = !booted.engine.byokKey || booted.engine.byokKey === "demo";
  status.textContent = needsKey
    ? "The assistant needs your AI provider key. Add it in AI model settings below."
    : "Assistant connected to this page. This visit is recorded in your browser only.";

  document.querySelector("#demo-task").addEventListener("click", () => {
    const input = document.querySelector("#ns-input");
    input.value = DEMO_TASK.request;
    input.focus();
  });
  // Show the run after the first visitor message, and again after every recorded event.
  const runSection = document.querySelector("#run-section");
  const view = new ReplayView(document.querySelector("#run-view"));
  const shareButton = document.querySelector("#share-run");
  recorder.addEventListener("event", () => {
    runSection.hidden = false;
    view.show(recorder.export(), { running: recorder.running });
    shareButton.disabled = recorder.running || !storeOrigins(recorder.export()).length;
  });
  shareButton.addEventListener("click", async () => {
    shareButton.disabled = true;
    const status = document.querySelector("#share-status");
    status.textContent = "Sharing…";
    const lines = [];
    for (const origin of storeOrigins(recorder.export())) lines.push(await shareWith(origin, recorder.export()));
    status.replaceChildren(...lines);
    shareButton.disabled = recorder.running;
  });

  document.querySelector("#save-run").addEventListener("click", () => {
    const trajectory = recorder.export();
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([JSON.stringify(trajectory, null, 2)], { type: "application/json" }));
    link.download = `run-${trajectory.run_id}.json`;
    link.click();
    URL.revokeObjectURL(link.href);
  });
  document.querySelector("#run-tools").hidden = false;
} catch (error) {
  status.textContent = "The assistant could not load.";
  console.error("Assistant startup failed", error);
}
