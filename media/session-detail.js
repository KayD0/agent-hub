(() => {
  const vscode = acquireVsCodeApi();
  const byId = (id) => document.getElementById(id);
  const activityPanel = byId("activity-panel");
  const tablist = document.querySelector('[role="tablist"]');
  const mergeTab = document.createElement("button");
  mergeTab.className = "tab"; mergeTab.id = "merge-tab"; mergeTab.type = "button"; mergeTab.setAttribute("role", "tab"); mergeTab.setAttribute("aria-selected", "false"); mergeTab.setAttribute("aria-controls", "merge-panel"); mergeTab.dataset.tab = "merge"; mergeTab.tabIndex = -1; mergeTab.textContent = "マージキュー";
  tablist.append(mergeTab);
  const mergePanel = document.createElement("section");
  mergePanel.className = "tabpanel"; mergePanel.id = "merge-panel"; mergePanel.setAttribute("role", "tabpanel"); mergePanel.hidden = true;
  mergePanel.innerHTML = '<div class="actions"><button type="button" id="refresh-merge">状態を更新</button><button type="button" id="run-merge" disabled>選択項目を順番にマージ</button></div><div id="merge-candidates"><p class="empty">関連するIssue用worktreeはありません。</p></div>';
  document.querySelector("#audit-panel").after(mergePanel);
  const auditBody = document.querySelector("#audit-panel tbody");
  const activityNodes = new Map();
  const auditNodes = new Map();
  let mergeRunning = false;

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

  function updateMergeQueue(candidates) {
    const container = byId("merge-candidates");
    container.replaceChildren();
    if (!candidates.length) { const empty = document.createElement("p"); empty.className = "empty"; empty.textContent = "関連するIssue用worktreeはありません。"; container.append(empty); updateMergeAction(); return; }
    for (const candidate of candidates) {
      const row = document.createElement("article");
      const label = document.createElement("label");
      const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.dataset.mergeCandidate = candidate.id;
      const selectable = !candidate.dirty && candidate.mergeStatus === "unmerged" && candidate.baseBranch === "develop";
      checkbox.disabled = !selectable; checkbox.addEventListener("change", updateMergeAction);
      const title = document.createElement("strong"); title.textContent = candidate.branch + " → " + candidate.baseBranch;
      const detail = document.createElement("p"); detail.className = "meta"; detail.textContent = candidate.rootPath;
      const state = document.createElement("p"); state.className = "meta"; state.textContent = candidate.dirty ? "未コミット差分あり" : candidate.mergeStatus === "merged" ? "マージ済み" : candidate.mergeStatus === "unmerged" ? "未マージ" : "判定不能";
      label.append(checkbox, title); row.append(label, detail, state); container.append(row);
    }
    updateMergeAction();
  }

  function updateMergeAction() { byId("run-merge").disabled = mergeRunning || !document.querySelector("[data-merge-candidate]:checked"); }

  const tabs = [...document.querySelectorAll('[role="tab"]')];
  function activateTab(name, focus = false) {
    for (const tab of tabs) { const selected = tab.dataset.tab === name; tab.setAttribute("aria-selected", String(selected)); tab.tabIndex = selected ? 0 : -1; byId(tab.getAttribute("aria-controls")).hidden = !selected; if (selected && focus) tab.focus(); }
    vscode.setState({ ...vscode.getState(), detailTab: name });
  }
  for (const tab of tabs) { tab.addEventListener("click", () => activateTab(tab.dataset.tab)); tab.addEventListener("keydown", (event) => { if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return; event.preventDefault(); const current = tabs.indexOf(tab); const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : event.key === "ArrowRight" ? (current + 1) % tabs.length : (current - 1 + tabs.length) % tabs.length; activateTab(tabs[next].dataset.tab, true); }); }
  const savedTab = vscode.getState()?.detailTab;
  activateTab(["activity", "audit", "merge"].includes(savedTab) ? savedTab : "activity");

  const form = byId("message-form"); const input = byId("message");
  form.addEventListener("submit", (event) => { event.preventDefault(); if (!input.value.trim()) return; vscode.postMessage({ type: "send", text: input.value }); input.value = ""; });
  input.addEventListener("keydown", (event) => { if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229) return; event.preventDefault(); form.requestSubmit(); });
  byId("interrupt").addEventListener("click", () => vscode.postMessage({ type: "interrupt" }));
  byId("refresh-merge").addEventListener("click", () => vscode.postMessage({ type: "refreshMergeQueue" }));
  byId("run-merge").addEventListener("click", () => {
    if (mergeRunning) return;
    const candidateIds = [...document.querySelectorAll("[data-merge-candidate]:checked")].map((checkbox) => checkbox.dataset.mergeCandidate);
    if (candidateIds.length) { mergeRunning = true; updateMergeAction(); vscode.postMessage({ type: "mergeQueue", candidateIds }); }
  });
  byId("attention").addEventListener("click", (event) => { const button = event.target.closest?.("[data-decision]"); if (button) vscode.postMessage({ type: "approval", decision: button.dataset.decision }); });
  window.addEventListener("message", (event) => { if (event.data?.type === "sessionDetail") update(event.data.session); else if (event.data?.type === "mergeQueue") updateMergeQueue(event.data.candidates || []); else if (event.data?.type === "mergeQueueComplete") { mergeRunning = false; updateMergeAction(); } });
  vscode.postMessage({ type: "ready" });
})();
