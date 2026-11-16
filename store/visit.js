// Shows one run a visitor shared with the store, with the same replay view the buyer site uses.
import { ReplayView } from "./agentcosign/replay-view.js";

const root = document.querySelector("#replay");
const empty = document.querySelector("#empty");
const id = new URLSearchParams(location.search).get("id") || "";
try {
  const response = await fetch(`agent-visits/${encodeURIComponent(id)}.json`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  new ReplayView(root).show(await response.json());
  root.hidden = false;
  empty.hidden = true;
} catch {
  empty.textContent = "The store has no shared run with this link.";
}
