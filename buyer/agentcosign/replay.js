// The replay page: pick a saved run, or open a run file, and show it.
import { FORMAT, ReplayView } from "./replay-view.js";

const RUNS = new URL("../runs/", import.meta.url);
const root = document.querySelector("#replay");
const empty = document.querySelector("#empty");
const view = new ReplayView(root);

function show(trajectory) {
  const valid = trajectory?.format === FORMAT && Array.isArray(trajectory.events);
  if (valid) view.show(trajectory);
  else empty.textContent = `This file is not a run in the ${FORMAT} format.`;
  root.hidden = !valid;
  empty.hidden = valid;
}

async function load(file) {
  const response = await fetch(new URL(file, RUNS));
  if (!response.ok) throw new Error(`could not read ${file}`);
  show(await response.json());
}

const select = document.querySelector("#run-select");
select.addEventListener("change", () => {
  if (!select.value) return;
  history.replaceState(null, "", `?run=${encodeURIComponent(select.value)}`);
  load(select.value);
});
document.querySelector("#run-file").addEventListener("change", async (event) => {
  const [file] = event.target.files;
  if (!file) return;
  try { show(JSON.parse(await file.text())); } catch { show(null); }
});

try {
  const index = await (await fetch(new URL("index.json", RUNS))).json();
  select.append(new Option("Choose a run", ""));
  for (const run of index.runs) select.append(new Option(run.label, run.file));
  // Only a file the index lists can be loaded by name.
  const wanted = new URLSearchParams(location.search).get("run");
  const first = index.runs.find((run) => run.file === wanted) || index.runs[0];
  if (first) {
    select.value = first.file;
    await load(first.file);
  }
} catch {
  select.append(new Option("No saved runs here", ""));
}
