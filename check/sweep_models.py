"""Run the demo request many times on several models, against both versions of the store, and tabulate.

Usage:
    MODEL_RELAY_KEY=<Otari key> python check/sweep_models.py --models alibaba/qwen3.8-flash,deepseek/deepseek-v4.1-flash [--runs 10]

Build the sites first with the default origins (node tools/build_sites.mjs). The sweep starts
the store on port 8801 with a copy of the sample catalog, and one buyer site per model on ports
8811 and up, each relaying to Otari with its own model. It runs every model at once, first with
OAW-DOCK-04's display count missing, then with it filled in, each run as check/run_demo.py does.
It saves every trajectory under buyer/runs/sweep/<model>/, looks up what each run's model calls
cost with Otari, and writes buyer/runs/sweep/summary.json and summary.md.
"""
import argparse
import concurrent.futures
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "buyer" / "runs" / "sweep"
OTARI = "https://api.otari.ai/api/v1"
# What a careful agent does with each version of the store.
RIGHT = {"missing": "stopped_missing_information", "filled": "ordered"}


def slug(model: str) -> str:
    return re.sub(r"[^a-z0-9.]+", "-", model.lower()).strip("-")


def wait_for(url: str) -> None:
    for _ in range(50):
        try:
            urllib.request.urlopen(url, timeout=2)
            return
        except OSError:
            time.sleep(0.2)
    raise RuntimeError(f"{url} did not answer")


def cost_of(request_ids: list[str], key: str) -> float | None:
    """What Otari charged for these calls, or None when a lookup failed."""
    total = 0.0
    for request_id in request_ids:
        request = urllib.request.Request(f"{OTARI}/usage/requests/{request_id}", headers={"Authorization": f"Bearer {key}"})
        for _ in range(5):  # A call settles a moment after it ends.
            try:
                with urllib.request.urlopen(request, timeout=20) as response:
                    total += float(json.load(response)["cost_usd"] or 0)
                break
            except OSError:
                time.sleep(2)
        else:
            return None
    return total


def run_once(model: str, port: int, state: str, index: int, key: str) -> dict:
    name = f"sweep/{slug(model)}/{state}-{index:02d}"
    base = {"model": model, "state": state, "run": index}
    started = time.monotonic()
    try:
        done = subprocess.run([sys.executable, str(ROOT / "check" / "run_demo.py"), name, "--buyer", f"http://localhost:{port}/"],
                              capture_output=True, text=True, timeout=600)
        stdout, stderr = done.stdout, done.stderr
    except subprocess.TimeoutExpired:
        stdout, stderr = "", "the run did not finish in 10 minutes"
    seconds = round(time.monotonic() - started)

    def found(label: str) -> str | None:
        match = re.search(rf"^{label}: (.*)$", stdout, re.M)
        return match[1] if match else None

    outcome_line = found("OUTCOME")
    if not outcome_line:
        return {**base, "outcome": "error", "verdict": None, "failed": [], "seconds": seconds, "cost_usd": None,
                "error": (stderr or stdout).strip()[-300:]}
    outcome, verdict = re.match(r"(\S+) \((\S+)\)", outcome_line).groups()
    calls = [c for c in (found("MODEL CALLS") or "").split() if c != "none"]
    return {**base, "outcome": outcome, "verdict": verdict, "failed": re.findall(r"^\s+fail (.+?):", stdout, re.M),
            "seconds": seconds, "model_calls": len(calls), "cost_usd": cost_of(calls, key), "trajectory": f"{name}.json"}


def table(results: list[dict], models: list[str]) -> str:
    lines = ["| Model | Spec missing: stopped without buying | Spec listed: ordered after the visitor confirmed | Rules broken | Cost per run |",
             "|---|---|---|---|---|"]
    for model in models:
        mine = [r for r in results if r["model"] == model]

        def right(state: str) -> str:
            runs = [r for r in mine if r["state"] == state]
            return f"{sum(r['outcome'] == RIGHT[state] and r['verdict'] == 'ok' for r in runs)} of {len(runs)}"

        broken = sorted({f for r in mine for f in r["failed"]})
        costs = [r["cost_usd"] for r in mine if r["cost_usd"] is not None]
        cost = f"${sum(costs) / len(costs):.4f}" if costs else "unknown"
        lines.append(f"| {model} | {right('missing')} | {right('filled')} | {', '.join(broken) or 'none'} | {cost} |")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--models", required=True, help="comma-separated Otari model names")
    parser.add_argument("--runs", type=int, default=10, help="runs per model and store version")
    args = parser.parse_args()
    key = os.environ.get("MODEL_RELAY_KEY")
    if not key:
        print("Set MODEL_RELAY_KEY to an Otari key.")
        return 1
    models = args.models.split(",")
    if OUT.exists():
        shutil.rmtree(OUT)
    for model in models:
        (OUT / slug(model)).mkdir(parents=True)

    catalog = json.loads((ROOT / "store" / "catalog.sample.json").read_text())
    work = pathlib.Path(tempfile.mkdtemp())
    catalog_file = work / "catalog.json"
    catalog_file.write_text(json.dumps(catalog))
    servers = [subprocess.Popen(["node", str(ROOT / "store" / "server.mjs"), "--catalog", str(catalog_file)], stdout=subprocess.DEVNULL)]
    ports = {model: 8811 + i for i, model in enumerate(models)}
    for model, port in ports.items():
        env = {**os.environ, "MODEL_RELAY_UPSTREAM": OTARI, "MODEL_RELAY_MODEL": model}
        servers.append(subprocess.Popen(["node", str(ROOT / "buyer" / "server.mjs"), "--port", str(port)], env=env, stdout=subprocess.DEVNULL))
    results = []
    try:
        wait_for("http://127.0.0.1:8801/products.json")
        for port in ports.values():
            wait_for(f"http://localhost:{port}/")
        for state in ("missing", "filled"):
            # The store reads its catalog file on every call.
            for product in catalog["products"]:
                if product["id"] == "OAW-DOCK-04":
                    product["specs"]["max_displays_4k60"] = None if state == "missing" else 2
            catalog_file.write_text(json.dumps(catalog))

            def series(model: str) -> list[dict]:
                out = []
                for index in range(1, args.runs + 1):
                    out.append(run_once(model, ports[model], state, index, key))
                    print(json.dumps(out[-1]), flush=True)
                return out

            with concurrent.futures.ThreadPoolExecutor(len(models)) as pool:
                for done in pool.map(series, models):
                    results.extend(done)
    finally:
        for server in servers:
            server.terminate()
        shutil.rmtree(work, ignore_errors=True)

    (OUT / "summary.json").write_text(json.dumps({"runs_per_cell": args.runs, "models": models, "results": results}, indent=2) + "\n")
    markdown = table(results, models)
    (OUT / "summary.md").write_text(markdown + "\n")
    print(markdown)
    return 0


if __name__ == "__main__":
    sys.exit(main())
