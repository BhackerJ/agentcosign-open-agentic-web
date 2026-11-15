"""Run the demo request on the buyer site with a real model, in headless Chromium, and save the run.

Usage:
    python check/run_demo.py <name> [--buyer http://localhost:8802/] [--decline]

Both sites must be running, the buyer site with a funded model relay (see README.md), so the
page needs no key. The script sends the page's demo request, allows each consent card (or
declines with --decline), and, when the first turn ends in a quote, confirms it in a second
turn. It prints the judge's verdict and any request that got a 404, and saves the trajectory
to buyer/runs/<name>.json.
"""
import argparse
import json
import pathlib
import sys

from playwright.sync_api import Page, sync_playwright

RUNS = pathlib.Path(__file__).resolve().parent.parent / "buyer" / "runs"
CONFIRM = "Yes, I confirm this quote. Place the order."
TURN_TIMEOUT_MS = 180_000

TURNS_DONE = "() => window.agentcosignRecorder.events.filter(e => e.type === 'agent_text' || e.type === 'turn_error').length"


def run_turn(page: Page, text: str, turn: int, decision: str) -> None:
    """Send one visitor message and answer consent cards until the turn ends."""
    page.fill("#ns-input", text)
    page.click("#ns-send")
    waited = 0
    while page.evaluate(TURNS_DONE) < turn:
        button = page.query_selector(f'.ns-consent .ns-consent-actions button[data-d="{decision}"]')
        if button:
            button.click()
        page.wait_for_timeout(250)
        waited += 250
        if waited > TURN_TIMEOUT_MS:
            raise TimeoutError(f"turn {turn} did not end within {TURN_TIMEOUT_MS} ms")


def judged(page: Page) -> dict:
    return page.evaluate("""async () => {
        const { judge } = await import('./agentcosign/judge.js');
        const trajectory = window.agentcosignRecorder.export();
        return { trajectory, verdict: judge(trajectory) };
    }""")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("name")
    parser.add_argument("--buyer", default="http://localhost:8802/")
    parser.add_argument("--decline", action="store_true")
    args = parser.parse_args()
    decision = "decline" if args.decline else "allow"

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page()
        missing: list[str] = []
        page.on("response", lambda response: missing.append(response.url) if response.status == 404 else None)
        page.goto(args.buyer)
        page.wait_for_function("window.agentcosignRecorder", timeout=30000)
        if page.evaluate("!window.agentcosignRecorder.engine.byokKey"):
            print("The buyer site funds no model. Start it with a relay key (see README.md).")
            return 1

        request = page.evaluate("window.agentcosignRecorder.task.request")
        run_turn(page, request, 1, decision)
        result = judged(page)
        if result["verdict"]["outcome"] == "quoted":
            run_turn(page, CONFIRM, 2, decision)
            result = judged(page)

        trajectory, verdict = result["trajectory"], result["verdict"]
        RUNS.mkdir(exist_ok=True)
        (RUNS / f"{args.name}.json").write_text(json.dumps(trajectory, indent=2) + "\n")

        print(f"MODEL: {trajectory['model']}")
        for event in trajectory["events"]:
            kind = event["type"]
            if kind == "tool_call":
                print(f"  [{event['seq']}] call {event['tool']} {json.dumps(event['arguments'])[:160]}")
            elif kind == "tool_result":
                print(f"  [{event['seq']}] result {'ERROR ' if event['is_error'] else ''}{event['text'][:200]}")
            elif kind == "capability_discovery":
                detail = [t["name"] for t in event["tools"]] if event["source"] == "mcp" else event["status"]
                print(f"  [{event['seq']}] discovered {event['url']} {detail}")
            elif kind == "consent":
                print(f"  [{event['seq']}] consent {event['peer_origin']} {event['decision']}: {event['request_text'][:160]}")
            else:
                print(f"  [{event['seq']}] {kind}: {(event.get('text') or event.get('message') or '')[:400]!r}")
        print(f"OUTCOME: {verdict['outcome']} ({verdict['verdict']})")
        print(f"SUMMARY: {verdict['summary']}")
        for check in verdict["checks"]:
            print(f"  {check['result']:<4} {check['label']}: {check['detail']}")
        print(f"REQUESTS THAT GOT 404: {missing or 'none'}")
        browser.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
