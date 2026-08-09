(() => {
  const vscode = acquireVsCodeApi();
  const byId = (id) => document.getElementById(id);
  const activityPanel = byId("activity-panel");
  const auditBody = document.querySelector("#audit-panel tbody");
  const activityNodes = new Map();
  const auditNodes = new Map();

  function reconcile(container, items, nodes, tag) {
    const active = new Set(items.map((item) => item.key));
    for (const [key, node] of nodes) if (!active.has(key)) { node.remove(); nodes.delete(key); }
    let previous;
    for (const item of items) {
      let node = nodes.get(item.key);
      if (!node) { node = document.createElement(tag); node.dataset.key = item.key; node.innerHTML = item.html; nodes.set(item.key, node); }
      const expected = previous ? previous.nextElementSibling : container.firstElementChild;
      if (expected !== node) container.insertBefore(node, expected);
      previous = node;
    }
  }

  function update(session) {
    byId("title").textContent = session.title;
    byId("status").textContent = session.status;
    byId("current-activity").textContent = session.currentActivity;
    byId("cwd").textContent = session.cwd;
    byId("interrupt").hidden = !session.canInterrupt;
    const attention = byId("attention");
    if (attention.dataset.html !== session.attentionHtml) { attention.dataset.html = session.attentionHtml; attention.innerHTML = session.attentionHtml; }
    reconcile(activityPanel, session.activities, activityNodes, "article");
    activityPanel.querySelector(".empty").hidden = session.activities.length > 0;
    reconcile(auditBody, session.audits, auditNodes, "tr");
    document.querySelector("#audit-panel .empty").hidden = session.audits.length > 0;
  }

  const tabs = [...document.querySelectorAll('[role="tab"]')];
  function activateTab(name, focus = false) {
    for (const tab of tabs) { const selected = tab.dataset.tab === name; tab.setAttribute("aria-selected", String(selected)); tab.tabIndex = selected ? 0 : -1; byId(tab.getAttribute("aria-controls")).hidden = !selected; if (selected && focus) tab.focus(); }
    vscode.setState({ ...vscode.getState(), detailTab: name });
  }
  for (const tab of tabs) { tab.addEventListener("click", () => activateTab(tab.dataset.tab)); tab.addEventListener("keydown", (event) => { if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return; event.preventDefault(); const current = tabs.indexOf(tab); const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : event.key === "ArrowRight" ? (current + 1) % tabs.length : (current - 1 + tabs.length) % tabs.length; activateTab(tabs[next].dataset.tab, true); }); }
  activateTab(vscode.getState()?.detailTab === "audit" ? "audit" : "activity");

  const form = byId("message-form"); const input = byId("message");
  form.addEventListener("submit", (event) => { event.preventDefault(); if (!input.value.trim()) return; vscode.postMessage({ type: "send", text: input.value }); input.value = ""; });
  input.addEventListener("keydown", (event) => { if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229) return; event.preventDefault(); form.requestSubmit(); });
  byId("interrupt").addEventListener("click", () => vscode.postMessage({ type: "interrupt" }));
  byId("attention").addEventListener("click", (event) => { const button = event.target.closest?.("[data-decision]"); if (button) vscode.postMessage({ type: "approval", decision: button.dataset.decision }); });
  window.addEventListener("message", (event) => { if (event.data?.type === "sessionDetail") update(event.data.session); });
  vscode.postMessage({ type: "ready" });
})();
