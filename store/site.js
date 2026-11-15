// Boots the browser runtime in this page's assistant section.

// When the site funds the model and the visitor has no setup of their own, point the runtime
// at the site's relay. The placeholder stands where a key would: the relay holds the real one.
async function modelOptions() {
  const { loadTabByokSetup } = await import("./runtime/byok.js");
  if (loadTabByokSetup().key) return {};
  const config = await fetch("/site-config.json").then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (!config?.funded) return {};
  return { byokKey: "site-funded", router: new URL(config.model_relay, location.origin).href, model: config.model };
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
  window.assistantEngine = booted.engine;
  const needsKey = !booted.engine.byokKey || booted.engine.byokKey === "demo";
  status.textContent = needsKey
    ? "The assistant needs your AI provider key. Add it in AI model settings below."
    : "Assistant connected to this page.";
} catch (error) {
  status.textContent = "The assistant could not load. You can still browse the range above.";
  console.error("Assistant startup failed", error);
}
